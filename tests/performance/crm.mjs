// Local-only synthetic benchmark. Administrator access is confined to fixture
// setup, plans and teardown; timed requests use real application sessions/RLS.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { harness } from '../crm/fixture.mjs';

const h = await harness();
const label = process.env.BENCHMARK_LABEL ?? 'phase-02';
assert.match(label, /^[a-z0-9-]{1,40}$/);
const output = new URL(`../../docs/phases/benchmarks/${label}/`, import.meta.url);
await mkdir(output, { recursive: true });
const report = {
  at: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: os.platform(),
    architecture: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    hostMemoryGiB: Math.round(os.totalmem() / 2 ** 30),
  },
  method:
    'Fastify injection, real opaque cookie/CSRF, runtime SQL, Auth verification and JWT PostgREST; excludes browser and client TCP/TLS. Four independently signed-in users, 4 concurrent requests, 4 warmups then 12 measured requests per read. Imports: 3 sequential 100-row jobs and one 4-job concurrent burst. Timings are warm local engineering observations, not an SLA.',
  stages: [],
};
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
    samplesMs: values,
  };
}
async function seed(org, owner, count) {
  const c = await h.admin.connect();
  try {
    await c.query('begin');
    await c.query(
      'create temporary table bench_contacts(n integer primary key,id uuid) on commit drop',
    );
    await c.query(
      'insert into bench_contacts select n,gen_random_uuid() from generate_series(1,$1) n',
      [Math.ceil(count / 2)],
    );
    await c.query(
      `insert into public.contacts(id,organization_id,kind,display_name,company_name,created_by,created_at,updated_at)
      select id,$1,case when n%5=0 then 'company' else 'person' end,'Synthetic contact '||n,case when n%5=0 then 'Synthetic company '||n else '' end,$2,'2026-10-30Z'::timestamptz-(n%365)*interval '1 day','2026-10-30Z' from bench_contacts`,
      [org, owner],
    );
    await c.query(
      `insert into public.contact_emails(organization_id,contact_id,position,value,normalized) select $1,id,1,'person-'||n||'@example.test','person-'||n||'@example.test' from bench_contacts where n%5<>0`,
      [org],
    );
    await c.query(
      `insert into public.contact_phones(organization_id,contact_id,position,value,normalized,region) select $1,id,1,'+12025550'||lpad((100+n%100)::text,3,'0'),'+12025550'||lpad((100+n%100)::text,3,'0'),'US' from bench_contacts where n%5 in (1,2)`,
      [org],
    );
    await c.query(
      'create temporary table bench_sources(n integer primary key,id uuid) on commit drop',
    );
    await c.query(
      'insert into bench_sources select n,gen_random_uuid() from generate_series(1,8) n',
    );
    await c.query(
      `insert into public.lead_sources(id,organization_id,name,created_by) select id,$1,'Synthetic source '||n,$2 from bench_sources`,
      [org, owner],
    );
    await c.query(
      'create temporary table bench_leads(n integer primary key,id uuid,contact_id uuid) on commit drop',
    );
    await c.query(
      'insert into bench_leads select series.n,gen_random_uuid(),c.id from generate_series(1,$1) series(n) join bench_contacts c on c.n=(series.n+1)/2',
      [count],
    );
    await c.query(
      `insert into public.leads(id,organization_id,contact_id,title,description,priority,status,outcome,closed_at,last_assigned_user_id,assigned_membership_generation,archived_at,created_by,created_at,updated_at,last_activity_at)
      select id,$1,contact_id,'Synthetic opportunity '||n||case when n%100=0 then ' specialist' else ' standard' end,repeat('Synthetic description. ',5),case when n%10=0 then 'high' when n%10=1 then 'low' else 'normal' end,case when n%10<4 then 'new' when n%10<7 then 'in_progress' when n%10<9 then 'qualified' else 'closed' end,case when n%10=9 then 'won' end,case when n%10=9 then '2026-10-29Z'::timestamptz end,case when n%3=0 then $2::uuid end,case when n%3=0 then 1 end,case when n%20=0 then '2026-10-29Z'::timestamptz end,$2,'2026-10-30Z'::timestamptz-(n%365)*interval '1 day'-n*interval '1 microsecond','2026-10-30Z','2026-10-30Z'::timestamptz-(n%10000)*interval '1 minute' from bench_leads`,
      [org, owner],
    );
    await c.query(
      `insert into public.lead_attributions(organization_id,lead_id,source_id,channel,campaign,accepted_at) select $1,l.id,s.id,case when l.n%2=0 then 'manual' else 'csv' end,'Synthetic campaign '||(l.n%10),'2026-10-30Z'::timestamptz-(l.n%365)*interval '1 day' from bench_leads l join bench_sources s on s.n=1+l.n%8`,
      [org],
    );
    await c.query(
      `insert into public.crm_activities(organization_id,lead_id,actor_id,event,details,created_at) select $1,id,$2,'lead.created',jsonb_build_object('channel','manual','sourceId',null),'2026-10-30Z'::timestamptz-(n%365)*interval '1 day' from bench_leads`,
      [org, owner],
    );
    await c.query(
      `insert into public.crm_activities(organization_id,lead_id,actor_id,event,details,created_at) select $1,id,$2,'lead.updated','{"fields":["title"]}','2026-10-30Z'::timestamptz-(n%10000)*interval '1 minute' from bench_leads`,
      [org, owner],
    );
    await c.query(
      `insert into public.crm_activities(organization_id,contact_id,actor_id,event,details) select $1,id,$2,'contact.created','{}' from bench_contacts`,
      [org, owner],
    );
    const selected = (await c.query('select id,contact_id from bench_leads where n=6')).rows[0];
    const source = (await c.query('select id from bench_sources where n=1')).rows[0].id;
    await c.query('commit');
    for (const table of [
      'contacts',
      'contact_emails',
      'contact_phones',
      'leads',
      'lead_attributions',
      'crm_activities',
    ])
      await h.admin.query(`analyze public.${table}`);
    return { ...selected, source };
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
const queryDefaults = {
  searchMode: 'prefix',
  contactId: null,
  q: '',
  status: 'all',
  priority: 'all',
  sourceId: null,
  assignee: 'all',
  archived: 'active',
  from: null,
  to: null,
  sort: 'created',
  pageSize: 25,
};
try {
  const people = [];
  for (let i = 0; i < 4; i++) people.push(await h.account());
  report.postgres = (await h.admin.query('select version() value')).rows[0].value;
  report.postgresSettings = (
    await h.admin.query('select name,setting,unit from pg_settings where name=any($1)', [
      ['shared_buffers', 'work_mem', 'max_connections', 'jit', 'log_parameter_max_length_on_error'],
    ])
  ).rows;
  for (const size of (process.env.BENCHMARK_SIZES ?? '1000,10000,50000').split(',').map(Number)) {
    assert.ok([1000, 10000, 50000].includes(size));
    const org = await h.organization(people[0]);
    for (const person of people.slice(1))
      await h.admin.query(
        "insert into public.organization_memberships(organization_id,user_id,role) values($1,$2,'admin')",
        [org, person.user],
      );
    const foreignOrg = await h.organization(people[1]);
    await seed(foreignOrg, people[1].user, 1000);
    const records = await seed(org, people[0].user, size);
    const stage = {
      leads: size,
      contacts: Math.ceil(size / 2),
      foreignLeads: 1000,
      distribution:
        '40% new, 30% in_progress, 20% qualified, 10% closed/won; 5% archived; 80% normal/10% high/10% low priority; 1/3 assigned; 8 sources, 10 campaigns; 365 days; 20% company, 80% email, 40% phone; two leads/contact, two lead events and one contact event/contact; foreign tenant has 1000 leads',
      reads: {},
      imports: {},
    };
    stage.actualGlobalRows = (
      await h.admin.query(
        'select (select count(*) from public.leads)::integer leads,(select count(*) from public.contacts)::integer contacts,(select count(*) from public.crm_activities)::integer activities',
      )
    ).rows[0];
    stage.relationBytes = (
      await h.admin.query(
        'select relname,pg_total_relation_size(oid)::bigint bytes from pg_class where oid=any($1::regclass[])',
        [['public.leads', 'public.contacts', 'public.crm_activities']],
      )
    ).rows;
    report.stages.push(stage);
    const base = `/organizations/${org}`;
    const cases = {
      list: `${base}/leads`,
      activityOrder: `${base}/leads?sort=activity`,
      contactSearch: `${base}/contacts?q=person-217%40example.test`,
      leadSearch: `${base}/leads?q=synthetic%20opportunity%2021`,
      broadContains: `${base}/leads?q=specialist&searchMode=contains`,
      filtered: `${base}/leads?status=in_progress&assignee=mine&sourceId=${records.source}`,
      detail: `${base}/leads/${records.id}`,
      timeline: `${base}/leads/${records.id}/activity`,
    };
    for (const [name, path] of Object.entries(cases)) {
      const timings = [];
      const failures = [];
      for (let round = 0; round < 4; round++)
        await Promise.all(
          people.map(async (person) => {
            const start = performance.now();
            const r = await person.client.request(path);
            if (r.statusCode !== 200)
              failures.push({ status: r.statusCode, code: r.json().error?.code });
            if (round) timings.push(performance.now() - start);
          }),
        );
      stage.reads[name] = { ...summarize(timings), failures };
      console.log(JSON.stringify({ size, operation: name, p95Ms: stage.reads[name].p95Ms }));
    }
    const tokens = (
      await h.admin.query(
        "select provider_session_id from private.app_sessions where user_id=$1 and purpose='application' and revoked_at is null limit 1",
        [people[0].user],
      )
    ).rows[0];
    const plan = await h.admin.connect();
    try {
      await plan.query('begin');
      await plan.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({
          sub: people[0].user,
          session_id: tokens.provider_session_id,
          role: 'authenticated',
        }),
      ]);
      await plan.query('set local role authenticated');
      const contactShape = (
        await h.admin.query(
          "select prosrc from pg_proc where oid='private.crm_contact_json(uuid,uuid)'::regprocedure",
        )
      ).rows[0].prosrc
        .replaceAll('p_org', '$1')
        .replaceAll('p_id', '$2');
      const parts = [];
      for (const [name, sql, params] of [
        [
          'rpc_list',
          "select public.crm_query($1,'leads',$2)",
          [org, JSON.stringify(queryDefaults)],
        ],
        [
          'rpc_filtered',
          "select public.crm_query($1,'leads',$2)",
          [
            org,
            JSON.stringify({
              ...queryDefaults,
              status: 'in_progress',
              assignee: 'mine',
              sourceId: records.source,
            }),
          ],
        ],
        [
          'rpc_search',
          "select public.crm_query($1,'contacts',$2)",
          [org, JSON.stringify({ ...queryDefaults, q: 'person-217@example.test' })],
        ],
        ['rpc_detail', "select public.crm_get($1,'lead',$2)", [org, records.id]],
        ['rpc_timeline', "select public.crm_activity($1,'lead',$2,25)", [org, records.id]],
        ['contact_shape', contactShape, [org, records.contact_id]],
        [
          'rls_prefix_email',
          'select c.id from public.contact_emails e join public.contacts c on c.organization_id=e.organization_id and c.id=e.contact_id where e.organization_id=$1 and starts_with(e.normalized,$2)',
          [org, 'person-217@example.test'],
        ],
        [
          'rls_prefix_title',
          'select id from public.leads where organization_id=$1 and starts_with(search_title,$2)',
          [org, 'synthetic opportunity 21'],
        ],
        [
          'rls_list_access',
          'select id from public.leads where organization_id=$1 and archived_at is null order by created_at desc,id desc limit 26',
          [org],
        ],
        [
          'rls_contact_search',
          "select id from public.contacts c where organization_id=$1 and (display_name ilike '%person-217@example.test%' or exists(select 1 from public.contact_emails e where e.organization_id=c.organization_id and e.contact_id=c.id and e.normalized ilike '%person-217@example.test%')) order by created_at desc,id desc limit 26",
          [org],
        ],
      ]) {
        const result = await plan.query(`explain (analyze,buffers,format json) ${sql}`, params);
        parts.push({ name, plan: result.rows[0]['QUERY PLAN'] });
      }
      await writeFile(new URL(`${size}-plans.json`, output), JSON.stringify(parts, null, 2) + '\n');
    } finally {
      await plan.query('rollback');
      plan.release();
    }
    await writeFile(new URL('results.json', output), JSON.stringify(report, null, 2) + '\n');
    async function importBatch(person) {
      const rows = Array.from({ length: 100 }, (_, i) => ({
        deliveryId: randomUUID(),
        rowNumber: i + 1,
        intake: {
          contact: {
            mode: 'create',
            data: {
              kind: 'person',
              displayName: `Synthetic import ${randomUUID()}`,
              duplicateResolution: 'create_distinct',
            },
          },
          lead: { title: `Synthetic benchmark ${i}` },
        },
      }));
      const start = performance.now();
      const r = await person.client.request(`${base}/lead-imports`, {
        method: 'POST',
        body: { jobId: randomUUID(), attemptId: randomUUID(), rows },
      });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().rows.filter((v) => v.status === 'succeeded').length, 100);
      return performance.now() - start;
    }
    const serial = [];
    for (let i = 0; i < 3; i++) serial.push(await importBatch(people[i]));
    stage.imports.sequential = summarize(serial);
    stage.imports.concurrent = summarize(await Promise.all(people.map(importBatch)));
    console.log(JSON.stringify({ size, imports: stage.imports }));
    await writeFile(new URL('results.json', output), JSON.stringify(report, null, 2) + '\n');
  }
} finally {
  await writeFile(new URL('results.json', output), JSON.stringify(report, null, 2) + '\n');
  await h.cleanup();
}
console.log(`Synthetic benchmark complete: ${output.pathname}`);
