import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from '../crm/fixture.mjs';
import { AutomationDatabase } from '../../packages/database/dist/index.js';
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
