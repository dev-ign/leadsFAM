import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { harness } from '../crm/fixture.mjs';
import { AutomationDatabase } from '../../packages/database/dist/index.js';
import { deriveMockInboundCredential } from '../../apps/api/dist/modules/automation/routes.js';
import { processAi } from '../../apps/api/dist/modules/ai/execute.js';
import { processCommunication } from '../../apps/api/dist/modules/communications/dispatch.js';
const h = await harness(),
  worker = new AutomationDatabase(h.identity.workerDatabaseUrl, 'worker');
after(async () => {
  await worker.close();
  await h.cleanup();
});
test('real Auth HTTP: AI configuration, analysis, email/SMS review, exact approval and mock lifecycle', async (t) => {
  const person = await h.account(),
    org = await h.organization(person),
    base = `/organizations/${org}`,
    other = await h.account();
  const setup = {
    enabled: true,
    provider: 'simulation',
    dailyLimit: 50,
    concurrentLimit: 1,
    business: {
      name: 'FreshNest Cleaning (synthetic)',
      description: 'Fictional household services',
      services: ['Deep cleaning'],
      serviceAreas: ['Exampletown'],
      tone: 'warm',
      questions: [],
      guidelines: 'Ask before making commitments.',
      restrictions: 'Do not quote prices or availability.',
      escalation: 'Ask a team member to review uncertain requests.',
    },
    version: 1,
  };
  const settings = await person.client.request(`${base}/ai/settings`, {
    method: 'PUT',
    body: setup,
  });
  assert.equal(settings.statusCode, 200, settings.body);
  const email = `ai-${randomUUID()}@example.test`;
  const leadResponse = await person.client.request(`${base}/leads`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: {
      contact: {
        mode: 'create',
        data: {
          kind: 'person',
          displayName: 'Alex Synthetic',
          emails: [email],
          phones: [{ value: '+12025550123', region: 'US' }],
        },
      },
      lead: {
        title: 'Deep cleaning inquiry',
        description: 'I need deep cleaning. Please tell me what information you need.',
        priority: 'normal',
      },
      attribution: {},
    },
  });
  assert.equal(leadResponse.statusCode, 200, leadResponse.body);
  const lead = leadResponse.json();
  await t.test('authentication, CSRF, strict authority and tenant scope are enforced', async () => {
    assert.equal((await h.browser().request(`${base}/ai/history`)).statusCode, 401);
    assert.equal((await other.client.request(`${base}/ai/history`)).statusCode, 404);
    assert.equal(
      (
        await person.client.request(`${base}/ai/settings`, {
          method: 'PUT',
          headers: { 'x-csrf-token': 'forged' },
          body: setup,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await person.client.request(`${base}/ai/requests/${randomUUID()}`, {
          method: 'PUT',
          body: {
            leadId: lead.id,
            task: 'analysis',
            channel: 'email',
            kind: 'follow_up',
            actorId: person.user,
          },
        })
      ).statusCode,
      400,
    );
  });
  await t.test('manual analysis is durable and can be reopened', async () => {
    const id = randomUUID(),
      body = { leadId: lead.id, task: 'analysis', channel: 'email', kind: 'follow_up' };
    const r = await person.client.request(`${base}/ai/requests/${id}`, { method: 'PUT', body });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(
      (await person.client.request(`${base}/ai/requests/${id}`, { method: 'PUT', body })).json().id,
      id,
    );
    await processAi(worker, await worker.claimAi(), { enabled: false });
    const history = await person.client.request(`${base}/ai/history?leadId=${lead.id}`);
    assert.equal(history.statusCode, 200, history.body);
    const run = history.json().items[0];
    assert.equal(run.state, 'succeeded');
    assert.equal(run.result.analysis.service.quote, 'deep cleaning');
    assert.ok(run.result.analysis.missing.includes('timeframe'));
  });
  for (const channel of ['email', 'sms'])
    await t.test(
      `${channel} proposal enters Phase 04 unapproved, is edited and approved exactly, then mock delivered`,
      async () => {
        const id = randomUUID();
        const requested = await person.client.request(`${base}/ai/requests/${id}`, {
          method: 'PUT',
          body: { leadId: lead.id, task: 'draft', channel, kind: 'follow_up' },
        });
        assert.equal(requested.statusCode, 200, requested.body);
        await processAi(worker, await worker.claimAi(), { enabled: false });
        const history = await person.client.request(`${base}/ai/history?leadId=${lead.id}`);
        const run = history.json().items.find((r) => r.id === id);
        assert.equal(run.state, 'succeeded');
        const recipient = channel === 'email' ? email : '+12025550123';
        const response = await person.client.request(`${base}/ai/requests/${id}/draft`, {
          method: 'POST',
          body: {
            recipient,
            ...run.result.proposal,
            body: `${run.result.proposal.body}\nHuman reviewed.`,
          },
        });
        assert.equal(response.statusCode, 200, response.body);
        const message = response.json();
        assert.equal(message.state, 'draft');
        assert.equal(
          (await person.client.request(`${base}/communications/messages/${message.id}`))
            .json()
            .body.endsWith('Human reviewed.'),
          true,
        );
        await person.client.request(`${base}/communications/settings`, {
          method: 'PUT',
          body: {
            paused: false,
            dailyLimit: 100,
            recipientDailyLimit: 5,
            channelDailyLimit: 100,
            concurrentLimit: 2,
            requestsPerMinute: 30,
            maxAttempts: 3,
          },
        });
        assert.equal(
          (
            await person.client.request(`${base}/communications/messages/${message.id}/send`, {
              method: 'POST',
              body: { version: message.version },
            })
          ).json().error.code,
          'RECIPIENT_INELIGIBLE',
        );
        const consent = await person.client.request(`${base}/communications/permission`, {
          method: 'POST',
          body: {
            contactId: message.contact_id,
            channel,
            purpose: 'transactional',
            recipient,
            status: 'granted',
            source: 'Synthetic explicit request',
            collectedAt: new Date(Date.now() - 1000).toISOString(),
            jurisdiction: 'US',
            policyVersion: 'synthetic-v1',
            evidence: 'Fictional acceptance test permission',
          },
        });
        assert.equal(consent.statusCode, 200, consent.body);
        const approved = await person.client.request(
          `${base}/communications/messages/${message.id}/send`,
          { method: 'POST', body: { version: message.version } },
        );
        assert.equal(approved.statusCode, 200, approved.body);
        assert.equal(approved.json().state, 'queued');
        await processCommunication(worker, await worker.claimCommunication());
        await h.admin.query(
          'update private.communication_jobs set run_at=clock_timestamp() where message_id=$1',
          [message.id],
        );
        await processCommunication(worker, await worker.claimCommunication());
        const delivered = await person.client.request(
          `${base}/communications/messages/${message.id}`,
        );
        assert.equal(delivered.json().state, 'delivered');
        assert.equal(delivered.json().provider, 'mock');
      },
    );
});

test('Phase 08 real Auth HTTP: scoped evaluation, exact review, safe draft handoff and stale denial', async (t) => {
  const person = await h.account(),
    org = await h.organization(person),
    base = `/organizations/${org}`,
    foreign = await h.account();
  await h.organization(foreign);
  const business = {
    name: 'FreshNest Phase 08 (synthetic)',
    description: '',
    services: ['Deep cleaning'],
    serviceAreas: ['Exampletown'],
    tone: 'warm',
    questions: [],
    guidelines: '',
    restrictions: '',
    escalation: '',
  };
  let result = await person.client.request(`${base}/ai/settings`, {
    method: 'PUT',
    body: {
      version: 1,
      enabled: true,
      provider: 'simulation',
      dailyLimit: 50,
      concurrentLimit: 1,
      business,
    },
  });
  assert.equal(result.statusCode, 200, result.body);
  const email = `phase08-${randomUUID()}@example.test`;
  result = await person.client.request(`${base}/leads`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: {
      contact: {
        mode: 'create',
        data: { kind: 'person', displayName: 'Michael Synthetic', emails: [email], phones: [] },
      },
      lead: {
        title: 'Synthetic cleaning inquiry',
        description: 'Fictional inquiry',
        priority: 'normal',
      },
      attribution: {},
    },
  });
  assert.equal(result.statusCode, 200, result.body);
  const lead = result.json();
  result = await person.client.request(`${base}/integrations`, {
    method: 'POST',
    body: { name: 'Synthetic Phase 08 replies', capability: 'mock_inbound' },
  });
  assert.equal(result.statusCode, 200, result.body);
  const integration = result.json().integration;
  const key = deriveMockInboundCredential(
    h.identity.mockWebhookSecret,
    integration.id,
    integration.credential_generation,
  );
  async function deliver(body = 'I need Deep cleaning in Exampletown.', eventId = randomUUID()) {
    const raw = JSON.stringify({ eventId, channel: 'email', sender: email, body }),
      time = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', Buffer.from(key.slice(7), 'base64url'))
      .update(`${time}.`)
      .update(raw)
      .digest('hex');
    return h.app.inject({
      method: 'POST',
      url: '/webhooks/mock/inbound',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-mock-timestamp': time,
        'x-mock-signature': signature,
      },
      payload: raw,
    });
  }
  result = await deliver();
  assert.equal(result.statusCode, 200, result.body);
  const message = (
      await h.admin.query('select * from private.communication_messages where id=$1', [
        result.json().messageId,
      ])
    ).rows[0],
    conversation = message.conversation_id;
  const url = `${base}/ai/conversations/${conversation}`;
  let rec;
  await t.test(
    'read is scoped and receipt alone enqueues neither AI nor communication',
    async () => {
      assert.equal((await h.browser().request(url)).statusCode, 401);
      assert.equal((await foreign.client.request(url)).statusCode, 404);
      result = await person.client.request(url);
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().eligible, true);
      assert.equal(result.json().items.length, 0);
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
    'strict CSRF and deduplicated requests reuse existing simulation execution',
    async () => {
      const source = (await person.client.request(url)).json(),
        input = { conversationId: conversation, sourceVersion: source.sourceVersion };
      assert.equal(
        (
          await person.client.request(`${base}/ai/recommendations/${randomUUID()}`, {
            method: 'PUT',
            headers: { 'x-csrf-token': 'forged' },
            body: input,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await person.client.request(`${base}/ai/recommendations/${randomUUID()}`, {
            method: 'PUT',
            body: { ...input, tool: 'send' },
          })
        ).statusCode,
        400,
      );
      const responses = await Promise.all(
        [randomUUID(), randomUUID()].map((id) =>
          person.client.request(`${base}/ai/recommendations/${id}`, { method: 'PUT', body: input }),
        ),
      );
      for (const r of responses) assert.equal(r.statusCode, 200, r.body);
      assert.equal(responses[0].json().id, responses[1].json().id);
      rec = responses[0].json();
      await processAi(worker, await worker.claimAi(), { enabled: false });
      result = await person.client.request(url);
      assert.equal(result.statusCode, 200, result.body);
      rec = result.json().items[0];
      assert.equal(rec.kind, 'ASK_FOR_INFORMATION');
      assert.equal(rec.evaluation.recommendation_conversation_id, conversation);
    },
  );
  await t.test(
    'preparation requires consent and creates exactly one editable unapproved draft',
    async () => {
      const review = `${base}/ai/recommendations/${rec.id}/review`,
        input = { version: rec.version, decision: 'prepare' };
      assert.equal(
        (await foreign.client.request(review, { method: 'POST', body: input })).statusCode,
        404,
      );
      assert.equal(
        (
          await person.client.request(review, {
            method: 'POST',
            body: { ...input, recipient: 'forged@example.test' },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await person.client.request(review, { method: 'POST', body: input })).statusCode,
        409,
      );
      result = await person.client.request(`${base}/communications/permission`, {
        method: 'POST',
        body: {
          contactId: lead.contact_id,
          channel: 'email',
          purpose: 'transactional',
          recipient: email,
          status: 'granted',
          source: 'Synthetic explicit request',
          collectedAt: new Date().toISOString(),
          jurisdiction: 'US',
          policyVersion: 'synthetic-v1',
          evidence: 'fictional-only',
        },
      });
      assert.equal(result.statusCode, 200, result.body);
      const responses = await Promise.all(
        [0, 1].map(() => person.client.request(review, { method: 'POST', body: input })),
      );
      for (const r of responses) assert.equal(r.statusCode, 200, r.body);
      assert.equal(responses[0].json().message_id, responses[1].json().message_id);
      result = await person.client.request(
        `${base}/communications/messages/${responses[0].json().message_id}`,
      );
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().state, 'draft');
      assert.equal(result.json().recipient, email);
      assert.equal(
        (
          await h.admin.query(
            'select count(*)::int n from private.communication_jobs where organization_id=$1',
            [org],
          )
        ).rows[0].n,
        0,
      );
    },
  );
  await t.test(
    'a committed correction and changed business knowledge invalidate prior review actions',
    async () => {
      result = await deliver('Actually, I need a different Deep cleaning scope in Exampletown.');
      assert.equal(result.statusCode, 200, result.body);
      const source = (await person.client.request(url)).json();
      assert.equal(source.items[0].stale, true);
      result = await person.client.request(`${base}/ai/recommendations/${randomUUID()}`, {
        method: 'PUT',
        body: { conversationId: conversation, sourceVersion: source.sourceVersion },
      });
      assert.equal(result.statusCode, 200, result.body);
      await processAi(worker, await worker.claimAi(), { enabled: false });
      rec = (await person.client.request(url)).json().items[0];
      assert.equal(rec.kind, 'HUMAN_ATTENTION');
      result = await person.client.request(`${base}/ai/settings`, {
        method: 'PUT',
        body: {
          version: 2,
          enabled: true,
          provider: 'simulation',
          dailyLimit: 50,
          concurrentLimit: 1,
          business: { ...business, description: 'Changed approved context' },
        },
      });
      assert.equal(result.statusCode, 200, result.body);
      result = await person.client.request(`${base}/ai/recommendations/${rec.id}/review`, {
        method: 'POST',
        body: { version: rec.version, decision: 'accept' },
      });
      assert.equal(result.statusCode, 409, result.body);
      assert.equal(result.json().error.code, 'STALE_RECOMMENDATION');
    },
  );
});
