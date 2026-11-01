// Synthetic, local-only engineering measurements. No provider calls or PII.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { harness } from '../crm/fixture.mjs';
import { AutomationDatabase } from '../../packages/database/dist/index.js';
const h = await harness(),
  worker = new AutomationDatabase(h.identity.workerDatabaseUrl, 'worker');
const summarize = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return {
    count: s.length,
    medianMs: s[Math.ceil(s.length * 0.5) - 1],
    p95Ms: s[Math.ceil(s.length * 0.95) - 1],
    maxMs: s.at(-1),
    samplesMs: values,
  };
};
try {
  const person = await h.account(),
    org = await h.organization(person),
    base = `/organizations/${org}`;
  const installed = await person.client.request(`${base}/integrations`, {
    method: 'POST',
    body: { name: 'Synthetic benchmark' },
  });
  assert.equal(installed.statusCode, 200);
  const secret = installed.json().credential;
  const definition = {
    schemaVersion: 1,
    trigger: 'lead.created',
    conditions: [],
    steps: [
      {
        id: 'record',
        tool: 'activities.create',
        version: 1,
        arguments: { message: 'Synthetic benchmark review' },
      },
    ],
  };
  const draft = await person.client.request(`${base}/automations`, {
    method: 'POST',
    body: { name: 'Synthetic review', definition },
  });
  assert.equal(draft.statusCode, 200);
  const w = draft.json();
  assert.equal(
    (
      await person.client.request(`${base}/automations/${w.id}/publish`, {
        method: 'POST',
        body: { version: w.version },
      })
    ).statusCode,
    200,
  );
  const sample = async () => {
    const id = randomUUID(),
      t = performance.now();
    const r = await h.app.inject({
      method: 'POST',
      url: '/ingress/v1/leads',
      remoteAddress: '127.0.3.25',
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        externalEventId: id,
        contact: {
          mode: 'create',
          data: {
            kind: 'person',
            displayName: `Synthetic ${id}`,
            emails: [`synthetic-${id}@example.test`],
          },
        },
        lead: { title: 'Synthetic benchmark inquiry' },
        metadata: { eventKind: 'inquiry' },
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    return performance.now() - t;
  };
  const sequential = [];
  for (let n = 0; n < 20; n++) sequential.push(await sample());
  const concurrent = [];
  for (let n = 0; n < 5; n++)
    concurrent.push(...(await Promise.all(Array.from({ length: 4 }, sample))));
  const jobs = [];
  for (let n = 0; n < 100; n++) {
    const claim = await worker.claim();
    if (!claim) break;
    const t = performance.now();
    assert.equal(
      (await worker.execute(claim.id, claim.token, claim.generation)).state,
      'completed',
    );
    jobs.push(performance.now() - t);
  }
  const view = (await person.client.request(`${base}/automations`)).json();
  assert.equal(view.queue.pending, 0);
  assert.equal(view.queue.failed, 0);
  assert.ok(view.runs.every((r) => r.completed_steps === 1));
  const count = await h.admin.query(
    'select count(*)::int n from private.automation_tool_executions where organization_id=$1',
    [org],
  );
  assert.equal(count.rows[0].n, 40);
  assert.equal(jobs.length, 80);
  const report = {
    at: new Date().toISOString(),
    method:
      'Local Fastify injection, real application Auth/JWT management, restricted ingress/worker logins and PostgreSQL. 20 sequential + 20 requests at concurrency four; 80 dispatch/action SQL executions. No warmups or network/TLS; sample p95 is not a production SLO.',
    intakeSequential: summarize(sequential),
    intakeConcurrency4: summarize(concurrent),
    jobExecution: summarize(jobs),
    logicalActivities: count.rows[0].n,
  };
  const output = new URL('../../docs/phases/benchmarks/phase-03-automation/', import.meta.url);
  await mkdir(output, { recursive: true });
  await writeFile(new URL('results.json', output), JSON.stringify(report, null, 2) + '\n');
  console.log({
    intakeSequentialP95Ms: report.intakeSequential.p95Ms,
    intakeConcurrency4P95Ms: report.intakeConcurrency4.p95Ms,
    jobExecutionP95Ms: report.jobExecution.p95Ms,
    logicalActivities: report.logicalActivities,
  });
} finally {
  await worker.close();
  await h.cleanup();
}
