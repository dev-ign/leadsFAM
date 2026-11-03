import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixture, pool, rpc } from '../database/fixture.mjs';
import { AutomationDatabase } from '../../packages/database/dist/index.js';
import { localIdentity } from '../../scripts/local-identity.mjs';
import { processAi } from '../../apps/api/dist/modules/ai/execute.js';
const f = await fixture(),
  local = await localIdentity(),
  worker = new AutomationDatabase(local.workerDatabaseUrl, 'worker');
try {
  const contact = randomUUID(),
    lead = randomUUID();
  await pool.query(
    "insert into public.contacts(id,organization_id,kind,display_name,created_by) values($1,$2,'person','Synthetic benchmark',$3)",
    [contact, f.org, f.ids.owner.user],
  );
  await pool.query(
    "insert into public.leads(id,organization_id,contact_id,title,description,created_by) values($1,$2,$3,'Synthetic benchmark','Deep cleaning inquiry',$4)",
    [lead, f.org, contact, f.ids.owner.user],
  );
  await rpc(f.ids.owner, 'ai_manage', [
    f.org,
    'settings',
    null,
    1,
    {
      enabled: true,
      provider: 'simulation',
      dailyLimit: 500,
      concurrentLimit: 1,
      business: {
        name: 'Synthetic',
        description: '',
        services: ['Deep cleaning'],
        serviceAreas: [],
        tone: 'warm',
        questions: [],
        guidelines: '',
        restrictions: '',
        escalation: '',
      },
    },
  ]);
  await pool.query(
    "insert into private.ai_runs(id,organization_id,lead_id,actor_id,authority_generation,task,channel,kind,trigger,provider,state,created_at) select gen_random_uuid(),$1,$2,$3,0,'analysis','email','follow_up','manual','simulation','succeeded',clock_timestamp()-interval '1 day' from generate_series(1,2000)",
    [f.org, lead, f.ids.owner.user],
  );
  const measurements = {};
  for (const kind of ['history', 'crmRead', 'simulation']) {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      if (kind === 'simulation')
        await rpc(f.ids.owner, 'ai_manage', [
          f.org,
          'request',
          randomUUID(),
          null,
          { leadId: lead, task: 'analysis', channel: 'email', kind: 'follow_up' },
        ]);
      const start = performance.now();
      if (kind === 'history') {
        const r = await rpc(f.ids.owner, 'ai_read', [f.org, 'history', lead, {}]);
        assert.equal(r.items.length, 20);
        assert.ok(r.next);
      } else if (kind === 'crmRead') await rpc(f.ids.owner, 'crm_get', [f.org, 'lead', lead]);
      else await processAi(worker, await worker.claimAi(), { enabled: false });
      samples.push(performance.now() - start);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    measurements[kind] = {
      requests: samples.length,
      p50Ms: sorted[9],
      p95Ms: sorted[18],
      maxMs: sorted[19],
    };
  }
  const plan = (
    await pool.query(
      'explain (analyze,buffers,format json) select id from private.ai_runs where organization_id=$1 and lead_id=$2 order by created_at desc,id desc limit 20',
      [f.org, lead],
    )
  ).rows;
  const dailyAdmissionPlan = (
    await pool.query(
      'explain (analyze,buffers,format json) select count(*) from private.ai_runs where organization_id=$1 and created_at>=$2::timestamptz',
      [f.org, new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z')],
    )
  ).rows;
  const result = {
    date: new Date().toISOString(),
    conditions:
      'Local macOS, Node 26.13.0, PostgreSQL 17.11, loopback authenticated-role RPCs, 2000 synthetic historical metadata rows with null results; 20 samples per operation, one caller. History is measured before 20 actual simulation runs. Simulation includes claim/prepare/validation/finish; no paid provider, HTTP, TLS or browser latency. Not a production SLO.',
    measurements,
    historyPlan: plan,
    dailyAdmissionPlan,
  };
  await writeFile(
    new URL('../../docs/phases/benchmarks/phase-05/results.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify({ measurements, historyIndex: plan[0]['QUERY PLAN'][0].Plan }));
} finally {
  await worker.close();
  await f.cleanup();
  await pool.end();
}
