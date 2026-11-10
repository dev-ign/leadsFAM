import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { harness } from '../crm/fixture.mjs';
import { AutomationDatabase } from '../../packages/database/dist/index.js';
import { deriveMockInboundCredential } from '../../apps/api/dist/modules/automation/routes.js';
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

test('real Auth HTTP: inbound authority before JSON, signed replies, replay, review and secret-free lifecycle', async (t) => {
  const person = await h.account(),
    org = await h.organization(person),
    base = `/organizations/${org}`;
  const contactResponse = await person.client.request(`${base}/contacts`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: {
      kind: 'person',
      displayName: 'Michael Rivera — synthetic',
      firstName: 'Michael',
      lastName: 'Rivera',
      companyName: '',
      emails: ['michael-inbound@example.test'],
      phones: [{ value: '+12025550129', region: 'US' }],
    },
  });
  assert.equal(contactResponse.statusCode, 200, contactResponse.body);
  const contact = contactResponse.json();
  const leadId = randomUUID();
  await h.admin.query(
    "insert into public.leads(id,organization_id,contact_id,title,created_by) values($1,$2,$3,'Synthetic inbound cleaning inquiry',$4)",
    [leadId, org, contact.id, person.user],
  );
  const created = await person.client.request(`${base}/integrations`, {
    method: 'POST',
    body: { name: 'Synthetic inbound replies', capability: 'mock_inbound' },
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.deepEqual(Object.keys(created.json()), ['integration']);
  let integration = created.json().integration,
    key = deriveMockInboundCredential(
      h.identity.mockWebhookSecret,
      integration.id,
      integration.credential_generation,
    );
  assert.ok(!created.body.includes(key));
  assert.ok(!created.body.includes(h.identity.mockWebhookSecret));
  const payload = {
    eventId: randomUUID(),
    channel: 'email',
    sender: 'Michael-Inbound@example.test',
    subject: 'Synthetic customer correction',
    body: '  Actually three bedrooms.\r\nCan you provide an estimate? 🙂  ',
  };
  function deliver(
    raw,
    extra = {},
    credential = key,
    time = String(Math.floor(Date.now() / 1000)),
  ) {
    const signature = createHmac('sha256', Buffer.from(credential.slice(7), 'base64url'))
      .update(`${time}.`)
      .update(raw)
      .digest('hex');
    return h.app.inject({
      method: 'POST',
      url: '/webhooks/mock/inbound',
      payload: raw,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential}`,
        'x-mock-timestamp': time,
        'x-mock-signature': signature,
        ...extra,
      },
    });
  }
  await t.test(
    'bad signatures, freshness, browser authority, UTF-8 and bounded payloads fail closed',
    async () => {
      const raw = JSON.stringify(payload);
      assert.equal((await deliver(raw, { 'x-mock-signature': '0'.repeat(64) })).statusCode, 401);
      assert.equal(
        (await deliver(raw, {}, key, String(Math.floor(Date.now() / 1000) - 301))).statusCode,
        401,
      );
      assert.equal((await deliver(raw, { cookie: 'browser-session' })).statusCode, 403);
      assert.equal((await deliver(raw, { origin: 'http://127.0.0.1:5173' })).statusCode, 403);
      assert.equal((await deliver('x'.repeat(16385))).statusCode, 413);
      assert.equal((await deliver('not JSON')).statusCode, 400);
      const invalid = 'lf_inb_' + 'a'.repeat(43);
      assert.equal((await deliver('not JSON', {}, invalid)).statusCode, 401);
      assert.equal(
        (await deliver(JSON.stringify({ ...payload, organizationId: org }))).statusCode,
        400,
      );
      assert.equal(
        (await deliver(JSON.stringify({ ...payload, body: 'x'.repeat(4001) }))).statusCode,
        400,
      );
      assert.equal((await deliver(Buffer.from([0xff, 0xfe]))).statusCode, 400);
    },
  );
  let received;
  await t.test(
    'normalized email, concurrent replay and conflict have one durable effect',
    async () => {
      const raw = JSON.stringify(payload),
        results = await Promise.all([deliver(raw), deliver(raw)]);
      for (const r of results) assert.equal(r.statusCode, 200, r.body);
      received = results[0].json();
      assert.equal(received.state, 'linked');
      assert.equal(received.messageId, results[1].json().messageId);
      assert.equal(
        (await deliver(JSON.stringify({ ...payload, body: 'Conflicting body' }))).statusCode,
        409,
      );
      const message = await person.client.request(
        `${base}/communications/messages/${received.messageId}`,
      );
      assert.equal(message.statusCode, 200, message.body);
      assert.equal(message.json().body, payload.body.replaceAll('\r\n', '\n'));
      assert.equal(message.json().sender, payload.sender.toLowerCase());
      assert.equal(message.json().created_by_integration, integration.id);
      const list = await person.client.request(
        `${base}/communications/conversations?leadId=${leadId}`,
      );
      assert.equal(list.json().items.length, 1);
    },
  );
  await t.test(
    'SMS and explicit human review preserve authorization and outbound boundaries',
    async () => {
      const sms = await deliver(
        JSON.stringify({
          ...payload,
          eventId: randomUUID(),
          channel: 'sms',
          sender: '+12025550129',
          subject: '',
          body: 'Synthetic SMS reply',
        }),
      );
      assert.equal(sms.statusCode, 200, sms.body);
      assert.equal(sms.json().state, 'linked');
      const unknown = await deliver(
        JSON.stringify({ ...payload, eventId: randomUUID(), sender: 'new-synthetic@example.test' }),
      );
      assert.equal(unknown.statusCode, 200, unknown.body);
      assert.equal(unknown.json().state, 'needs_review');
      const receipts = await person.client.request(`${base}/communications/inbound`);
      assert.equal(receipts.statusCode, 200, receipts.body);
      assert.equal(receipts.json().items.length, 1);
      const foreign = await h.account();
      await h.organization(foreign);
      assert.equal(
        (await foreign.client.request(`${base}/communications/inbound`)).statusCode,
        404,
      );
      assert.equal(
        (
          await foreign.client.request(
            `${base}/communications/inbound/${unknown.json().receiptId}/link`,
            { method: 'POST', body: { contactId: contact.id, leadId } },
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await person.client.request(
            `${base}/communications/inbound/${unknown.json().receiptId}/link`,
            {
              method: 'POST',
              headers: { 'x-csrf-token': 'forged' },
              body: { contactId: contact.id, leadId },
            },
          )
        ).statusCode,
        403,
      );
      const linked = await person.client.request(
        `${base}/communications/inbound/${unknown.json().receiptId}/link`,
        { method: 'POST', body: { contactId: contact.id, leadId } },
      );
      assert.equal(linked.statusCode, 200, linked.body);
      assert.equal(linked.json().lead_id, leadId);
      assert.equal(
        (
          await h.admin.query(
            'select count(*)::int n from private.communication_jobs where organization_id=$1',
            [org],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await h.admin.query(
            'select count(*)::int n from private.ai_runs where organization_id=$1',
            [org],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await t.test(
    'rotating hides signing credentials, invalidates the old key and preserves new-key replay',
    async () => {
      const rotated = await person.client.request(`${base}/integrations/${integration.id}/rotate`, {
        method: 'POST',
        body: { version: integration.version },
      });
      assert.equal(rotated.statusCode, 200, rotated.body);
      assert.deepEqual(Object.keys(rotated.json()), ['integration']);
      const old = key;
      integration = rotated.json().integration;
      key = deriveMockInboundCredential(
        h.identity.mockWebhookSecret,
        integration.id,
        integration.credential_generation,
      );
      assert.ok(!rotated.body.includes(key));
      assert.notEqual(old, key);
      assert.equal((await deliver(JSON.stringify(payload), {}, old)).statusCode, 401);
      assert.equal((await deliver(JSON.stringify(payload))).json().replayed, true);
      const revoked = await person.client.request(
        `${base}/integrations/${integration.id}/revoked`,
        { method: 'POST', body: { version: integration.version } },
      );
      assert.equal(revoked.statusCode, 200, revoked.body);
      assert.equal(
        (await deliver(JSON.stringify({ ...payload, eventId: randomUUID() }))).statusCode,
        401,
      );
    },
  );
});
