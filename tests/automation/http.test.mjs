import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from '../crm/fixture.mjs';
import { AutomationDatabase } from '../../packages/database/dist/index.js';
const h = await harness();
const worker = new AutomationDatabase(h.identity.workerDatabaseUrl, 'worker');
after(async () => {
  await worker.close();
  await h.cleanup();
});
test('first-party authenticated intake, management, safe errors and execution through real Auth and RLS', async (t) => {
  const person = await h.account(),
    org = await h.organization(person),
    base = `/organizations/${org}`;
  let integration, secret;
  await t.test('management requires a current application session and CSRF', async () => {
    assert.equal((await h.browser().request(`${base}/automations`)).statusCode, 401);
    assert.equal(
      (
        await person.client.request(`${base}/integrations`, {
          method: 'POST',
          body: { name: 'Synthetic' },
          headers: { 'x-csrf-token': 'forged' },
        })
      ).statusCode,
      403,
    );
    const r = await person.client.request(`${base}/integrations`, {
      method: 'POST',
      body: { name: 'Synthetic backend' },
    });
    assert.equal(r.statusCode, 200, r.body);
    integration = r.json().integration;
    secret = r.json().credential;
    assert.equal(integration.credential_hash, undefined);
    const overview = await person.client.request(`${base}/automations`);
    assert.equal(overview.statusCode, 200, overview.body);
    assert.ok(!overview.body.includes(secret));
    assert.ok(!overview.body.includes('credential_hash'));
  });
  const definition = {
    schemaVersion: 1,
    trigger: 'lead.created',
    conditions: [{ field: 'status', equals: 'new' }],
    steps: [
      {
        id: 'record',
        tool: 'activities.create',
        version: 1,
        arguments: { message: 'Synthetic review activity' },
      },
    ],
  };
  await t.test(
    'guided save, explicit publication, version conflicts and unsafe definitions',
    async () => {
      const r = await person.client.request(`${base}/automations`, {
        method: 'POST',
        body: { name: 'Review inquiries', definition },
      });
      assert.equal(r.statusCode, 200, r.body);
      const w = r.json();
      assert.equal(w.status, 'draft');
      const published = await person.client.request(`${base}/automations/${w.id}/publish`, {
        method: 'POST',
        body: { version: w.version },
      });
      assert.equal(published.statusCode, 200, published.body);
      assert.equal(
        (
          await person.client.request(`${base}/automations/${w.id}/pause`, {
            method: 'POST',
            body: { version: w.version },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await person.client.request(`${base}/automations`, {
            method: 'POST',
            body: { name: 'Unsafe', definition: { ...definition, organizationId: org } },
          })
        ).statusCode,
        400,
      );
    },
  );
  const input = {
    externalEventId: randomUUID(),
    contact: {
      mode: 'create',
      data: {
        kind: 'person',
        displayName: 'Synthetic HTTP inquiry',
        emails: ['Inquiry+Tag@EXAMPLE.TEST'],
        phones: [{ value: '2025550123', region: 'US' }],
      },
    },
    lead: { title: 'Synthetic website inquiry' },
    metadata: { eventKind: 'inquiry' },
  };
  const ingest = (body, headers = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/ingress/v1/leads',
      remoteAddress: '127.0.2.20',
      headers: { authorization: `Bearer ${secret}`, ...headers },
      payload: body,
    });
  let accepted;
  await t.test(
    'invalid credentials, browser use, malformed payloads, tenant injection and bounds are denied',
    async () => {
      assert.equal((await ingest(input, { authorization: 'Bearer invalid' })).statusCode, 401);
      assert.equal((await ingest(input, { origin: 'https://example.test' })).statusCode, 403);
      assert.equal((await ingest({ ...input, organizationId: org })).statusCode, 400);
      assert.equal(
        (await ingest({ ...input, metadata: { arbitrary: 'not allowed' } })).statusCode,
        400,
      );
      const tooLarge = await ingest({
        ...input,
        lead: { title: 'Synthetic', description: 'x'.repeat(17000) },
      });
      assert.equal(tooLarge.statusCode, 413);
      const malformed = await h.app.inject({
        method: 'POST',
        url: '/ingress/v1/leads',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        payload: '{invalid',
      });
      assert.equal(malformed.statusCode, 400);
      assert.ok(!malformed.body.includes(secret));
      const text = await h.app.inject({
        method: 'POST',
        url: '/ingress/v1/leads',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'text/plain' },
        payload: 'hello',
      });
      assert.equal(text.statusCode, 415);
    },
  );
  await t.test(
    'intake is committed, replay is stable and worker produces one activity',
    async () => {
      const r = await ingest(input);
      assert.equal(r.statusCode, 200, r.body);
      accepted = r.json();
      assert.equal(accepted.state, 'succeeded');
      const replay = await ingest(input);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().leadId, accepted.leadId);
      assert.equal(replay.json().replayed, true);
      const conflict = await ingest({ ...input, lead: { title: 'Different inquiry' } });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
      const contact = (
        await person.client.request(`${base}/contacts/${accepted.contactId}`)
      ).json();
      assert.equal(contact.emails[0].normalized, 'inquiry+tag@example.test');
      assert.equal(contact.phones[0].normalized, '+12025550123');
      for (let i = 0; i < 4; i++) {
        const c = await worker.claim();
        if (!c) break;
        assert.equal((await worker.execute(c.id, c.token, c.generation)).state, 'completed');
      }
      const overview = await person.client.request(`${base}/automations`);
      assert.equal(overview.statusCode, 200, overview.body);
      assert.equal(overview.json().runs[0].state, 'succeeded');
      assert.equal(overview.json().runs[0].completed_steps, 1);
      assert.equal(overview.json().attempts.length, 3);
      const activities = await person.client.request(`${base}/leads/${accepted.leadId}/activity`);
      assert.equal(activities.statusCode, 200, activities.body);
      assert.equal(
        activities.json().items.filter((a) => a.event === 'automation.activity').length,
        1,
      );
    },
  );
  await t.test(
    'foreign organizations, credential rotation and revocation preserve isolation',
    async () => {
      const other = await h.account(),
        otherOrg = await h.organization(other);
      assert.equal((await other.client.request(`${base}/automations`)).statusCode, 404);
      assert.equal(
        (await person.client.request(`/organizations/${otherOrg}/automations`)).statusCode,
        404,
      );
      const rotated = await person.client.request(`${base}/integrations/${integration.id}/rotate`, {
        method: 'POST',
        body: { version: integration.version },
      });
      assert.equal(rotated.statusCode, 200, rotated.body);
      assert.equal((await ingest(input)).statusCode, 401);
      secret = rotated.json().credential;
      integration = rotated.json().integration;
      const revoked = await person.client.request(
        `${base}/integrations/${integration.id}/revoked`,
        { method: 'POST', body: { version: integration.version } },
      );
      assert.equal(revoked.statusCode, 200, revoked.body);
      assert.equal((await ingest(input)).statusCode, 401);
    },
  );
});
