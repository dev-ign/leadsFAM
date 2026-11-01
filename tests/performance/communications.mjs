import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fixture, pool, rpc } from '../database/fixture.mjs';
const f = await fixture();
try {
  const started = performance.now();
  await pool.query(
    "insert into public.contacts(id,organization_id,kind,display_name,created_by) select gen_random_uuid(),$1,'person','Synthetic benchmark '||n,$2 from generate_series(1,1000) n",
    [f.org, f.ids.owner.user],
  );
  await pool.query(
    "insert into private.conversations(organization_id,contact_id,channel) select organization_id,id,'email' from public.contacts where organization_id=$1",
    [f.org],
  );
  await pool.query(
    "insert into private.communication_messages(id,organization_id,conversation_id,contact_id,channel,purpose,sender,recipient,subject,body,created_by) select gen_random_uuid(),c.organization_id,c.id,c.contact_id,'email','transactional','FreshNest <mock@example.test>','synthetic@example.test','Synthetic benchmark','Synthetic content',$2 from private.conversations c cross join generate_series(1,10) n where c.organization_id=$1",
    [f.org, f.ids.owner.user],
  );
  const seedMs = performance.now() - started,
    measurements = {};
  let conversation;
  for (const kind of ['conversations', 'history']) {
    const samples = [];
    for (let round = 0; round < 5; round++)
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const start = performance.now(),
            result = await rpc(f.ids.owner, 'communication_read', [
              f.org,
              kind,
              kind === 'history' ? conversation : null,
              {},
            ]);
          samples.push(performance.now() - start);
          if (kind === 'conversations') {
            assert.equal(result.items.length, 50);
            assert.ok(result.next);
            conversation = result.items[0].id;
          } else assert.equal(result.messages.length, 10);
        }),
      );
    const sorted = [...samples].sort((a, b) => a - b);
    measurements[kind] = {
      requests: samples.length,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxMs: sorted.at(-1),
      samplesMs: samples,
    };
  }
  const plan = (
    await pool.query(
      'explain (format json) select id from private.communication_jobs where message_id=$1 limit 1',
      [conversation],
    )
  ).rows;
  const result = {
    date: new Date().toISOString(),
    conditions:
      'Local loopback PostgreSQL; real enrolled authenticated-role RPCs; 1000 conversations / 10000 synthetic messages; four concurrent callers, five rounds; includes pool/transaction/session/RLS, excludes HTTP/browser/network TLS. Small local sample, not a production SLO.',
    seedMs,
    measurements,
    providerLookupPlan: plan,
  };
  await writeFile(
    new URL('../../docs/phases/benchmarks/phase-04/results.json', import.meta.url),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      seedMs,
      measurements: Object.fromEntries(
        Object.entries(measurements).map(([k, { samplesMs, ...v }]) => {
          void samplesMs;
          return [k, v];
        }),
      ),
    }),
  );
} finally {
  await f.cleanup();
  await pool.end();
}
