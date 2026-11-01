import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { harness } from '../crm/fixture.mjs';
import { AutomationDatabase } from '../../packages/database/dist/index.js';
import { processCommunication } from '../../apps/api/dist/modules/communications/dispatch.js';
const h = await harness(),
  worker = new AutomationDatabase(h.identity.workerDatabaseUrl, 'worker');
after(async () => {
  await worker.close();
  await h.cleanup();
});
const settings = {
  paused: false,
  dailyLimit: 100,
  recipientDailyLimit: 5,
  channelDailyLimit: 100,
  concurrentLimit: 2,
  requestsPerMinute: 30,
  maxAttempts: 3,
};

test('real Auth HTTP: saved approval, mock dispatch, signed raw webhook, replay, tenant scope and opt-out', async (t) => {
  const person = await h.account(),
    org = await h.organization(person),
    base = `/organizations/${org}/communications`;
  const email = `synthetic-${randomUUID()}@example.test`;
  const c = await person.client.request(`/organizations/${org}/contacts`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: {
      kind: 'person',
      displayName: 'Synthetic communications recipient',
      firstName: '',
      lastName: '',
      companyName: '',
      emails: [email],
      phones: [],
    },
  });
  assert.equal(c.statusCode, 200, c.body);
  const contact = c.json();
  const input = {
    id: randomUUID(),
    contactId: contact.id,
    leadId: null,
    channel: 'email',
    purpose: 'transactional',
    recipient: email,
    subject: 'Synthetic appointment',
    body: 'Your mock appointment details.',
  };
  let message;
  await t.test(
    'authentication, CSRF, unsafe sender fields and durable draft identity',
    async () => {
      assert.equal((await h.browser().request(`${base}/conversations`)).statusCode, 401);
      assert.equal(
        (
          await person.client.request(`${base}/messages/${input.id}`, {
            method: 'PUT',
            body: input,
            headers: { 'x-csrf-token': 'forged' },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await person.client.request(`${base}/messages/${input.id}`, {
            method: 'PUT',
            body: { ...input, sender: 'forged@example.test' },
          })
        ).statusCode,
        400,
      );
      const saved = await person.client.request(`${base}/messages/${input.id}`, {
        method: 'PUT',
        body: input,
      });
      assert.equal(saved.statusCode, 200, saved.body);
      message = saved.json();
      const read = await person.client.request(`${base}/messages/${input.id}`);
      assert.equal(read.statusCode, 200, read.body);
      assert.equal(read.json().body, input.body);
      const replay = await person.client.request(`${base}/messages/${input.id}`, {
        method: 'PUT',
        body: input,
      });
      assert.equal(replay.json().id, input.id);
    },
  );
  await t.test('pause and missing consent fail closed; permission requires evidence', async () => {
    assert.equal(
      (
        await person.client.request(`${base}/messages/${message.id}/send`, {
          method: 'POST',
          body: { version: 1 },
        })
      ).json().error.code,
      'SENDING_PAUSED',
    );
    assert.equal(
      (await person.client.request(`${base}/settings`, { method: 'PUT', body: settings }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await person.client.request(`${base}/messages/${message.id}/send`, {
          method: 'POST',
          body: { version: 1 },
        })
      ).json().error.code,
      'RECIPIENT_INELIGIBLE',
    );
    const consent = {
      contactId: contact.id,
      channel: 'email',
      purpose: 'transactional',
      recipient: email,
      status: 'granted',
      source: 'Synthetic explicit inquiry',
      collectedAt: new Date(Date.now() - 1000).toISOString(),
      jurisdiction: 'US',
      policyVersion: 'test-v1',
      evidence: 'synthetic-only',
    };
    assert.equal(
      (
        await person.client.request(`${base}/permission`, {
          method: 'POST',
          body: { ...consent, evidence: '' },
        })
      ).statusCode,
      400,
    );
    const r = await person.client.request(`${base}/permission`, { method: 'POST', body: consent });
    assert.equal(r.statusCode, 200, r.body);
    const sent = await person.client.request(`${base}/messages/${message.id}/send`, {
      method: 'POST',
      body: { version: 1 },
    });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal(sent.json().state, 'queued');
    const replay = await person.client.request(`${base}/messages/${message.id}/send`, {
      method: 'POST',
      body: { version: 1 },
    });
    assert.equal(replay.json().id, message.id);
  });
  await worker.start();
  await processCommunication(worker, await worker.claimCommunication());
  const event = {
      eventId: randomUUID(),
      reference: `mock:${message.id}`,
      channel: 'email',
      type: 'delivered',
    },
    timestamp = String(Math.floor(Date.now() / 1000));
  const webhook = (body, signature, time = timestamp) =>
    h.app.inject({
      method: 'POST',
      url: '/webhooks/mock/communications',
      headers: {
        'content-type': 'application/json',
        'x-mock-timestamp': time,
        'x-mock-signature': signature,
      },
      payload: body,
    });
  const sign = (body, time = timestamp) =>
    createHmac('sha256', Buffer.from(h.identity.mockWebhookSecret, 'base64'))
      .update(`${time}.`)
      .update(body)
      .digest('hex');
  await t.test(
    'unmodified-byte signature, stale replay, duplicate delivery and bounded malformed bodies',
    async () => {
      const raw = JSON.stringify(event, null, 2);
      assert.equal((await webhook(raw, '0'.repeat(64))).statusCode, 401);
      assert.equal((await webhook(JSON.stringify(event), sign(raw))).statusCode, 401);
      const stale = String(Number(timestamp) - 301);
      assert.equal((await webhook(raw, sign(raw, stale), stale)).statusCode, 401);
      assert.equal((await webhook('not json', sign('not json'))).statusCode, 400);
      const malformedReference = JSON.stringify({ ...event, reference: `mock:${'-'.repeat(36)}` });
      assert.equal((await webhook(malformedReference, sign(malformedReference))).statusCode, 400);
      const huge = 'x'.repeat(16385);
      assert.equal((await webhook(huge, sign(huge))).statusCode, 413);
      assert.equal((await webhook(raw, sign(raw))).statusCode, 200);
      assert.equal((await webhook(raw, sign(raw))).statusCode, 200);
      const history = await person.client.request(
        `${base}/conversations/${message.conversation_id}`,
      );
      assert.equal(history.statusCode, 200, history.body);
      assert.equal(history.json().messages[0].state, 'delivered');
      assert.equal(history.json().events.filter((e) => e.event === 'provider_delivered').length, 1);
    },
  );
  await t.test(
    'cross-tenant message IDs remain unavailable and settings expose no secret',
    async () => {
      const foreign = await h.account();
      await h.organization(foreign);
      assert.equal(
        (await foreign.client.request(`${base}/messages/${message.id}`)).statusCode,
        404,
      );
      const settings = await person.client.request(`${base}/settings`);
      assert.equal(settings.statusCode, 200);
      assert.ok(!settings.body.includes(h.identity.mockWebhookSecret));
      assert.equal(settings.json().liveEnabled, false);
    },
  );
  await t.test('verified unsubscribe blocks later delivery and START never clears it', async () => {
    for (const type of ['opt_out', 'start']) {
      const raw = JSON.stringify({ ...event, eventId: randomUUID(), type });
      assert.equal((await webhook(raw, sign(raw))).statusCode, 200);
    }
    const status = await person.client.request(
      `${base}/contacts/${contact.id}/eligibility?channel=email&purpose=transactional&recipient=${encodeURIComponent(email)}`,
    );
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().code, 'DESTINATION_SUPPRESSED');
  });
});
