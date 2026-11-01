// Non-destructive packaged migration compatibility rehearsal. The entire isolated
// namespace/role/policy/RPC replay is rolled back; no database is reset or cloned.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, pool } from './fixture.mjs';
const f = await fixture(),
  client = await pool.connect();
try {
  const source = await readFile(
    new URL(
      '../../supabase/migrations/20261101190428_communications_foundation.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const contact = randomUUID();
  await client.query(
    "insert into public.contacts(id,organization_id,kind,display_name,created_by) values($1,$2,'person','Synthetic migration compatibility',$3)",
    [contact, f.org, f.ids.owner.user],
  );
  await client.query('begin');
  const existing = (
    await client.query(
      "select exists(select 1 from pg_namespace where nspname='phase04_review') or exists(select 1 from pg_roles where rolname='leadsfam_comm_review') present",
    )
  ).rows[0].present;
  assert.equal(
    existing,
    false,
    'Reserved rehearsal namespace/role already exists; refuse overwrite',
  );
  await client.query('create schema phase04_review');
  const sql = source
    .replaceAll('leadsfam_communications', 'leadsfam_comm_review')
    .replaceAll('communication_execution', 'communication_review_execution')
    .replaceAll('private.communication_', 'phase04_review.communication_')
    .replaceAll('private.conversations', 'phase04_review.conversations')
    .replaceAll('public.communication_manage', 'public.phase04_review_manage')
    .replaceAll('public.communication_read', 'public.phase04_review_read')
    .replaceAll(
      'schema public,private to leadsfam_comm_review',
      'schema public,private,phase04_review to leadsfam_comm_review',
    )
    .replaceAll('private.%I', 'phase04_review.%I')
    .replaceAll(
      'on schema private to leadsfam_comm_review',
      'on schema phase04_review to leadsfam_comm_review',
    )
    .replaceAll(
      'on schema private from leadsfam_comm_review',
      'on schema phase04_review from leadsfam_comm_review',
    )
    .replaceAll("n.nspname='private' and p.proname", "n.nspname='phase04_review' and p.proname");
  await client.query(sql);
  await client.query(
    'grant usage on schema phase04_review to authenticated,leadsfam_worker,leadsfam_ingress',
  );
  const tables = (
    await client.query(
      "select count(*)::int n,bool_and(relrowsecurity) rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='phase04_review' and c.relkind='r'",
    )
  ).rows[0];
  assert.deepEqual(tables, { n: 9, rls: true });
  const functions = (
    await client.query(
      "select count(*)::int n,bool_and(p.proowner='leadsfam_comm_review'::regrole) owned from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='phase04_review'",
    )
  ).rows[0];
  assert.deepEqual(functions, { n: 9, owned: true });
  await client.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({
      sub: f.ids.owner.user,
      session_id: f.ids.owner.session,
      role: 'authenticated',
    }),
  ]);
  await client.query('set local role authenticated');
  const id = randomUUID(),
    draft = {
      id,
      contactId: contact,
      leadId: null,
      channel: 'email',
      purpose: 'transactional',
      recipient: 'synthetic@example.test',
      subject: 'Compatibility',
      body: 'Synthetic migration rehearsal',
    };
  const result = (
    await client.query("select public.phase04_review_manage($1,'draft',$2,null,$3::jsonb) result", [
      f.org,
      id,
      JSON.stringify(draft),
    ])
  ).rows[0].result;
  assert.equal(result.state, 'draft');
  const history = (
    await client.query("select public.phase04_review_read($1,'history',$2,'{}') result", [
      f.org,
      result.conversation_id,
    ])
  ).rows[0].result;
  assert.equal(history.messages.length, 1);
  await client.query('rollback');
  assert.equal(
    (
      await client.query(
        "select exists(select 1 from pg_namespace where nspname='phase04_review') present",
      )
    ).rows[0].present,
    false,
  );
  const report = {
    date: new Date().toISOString(),
    method:
      'Packaged migration replayed in a transaction using an isolated schema, role and wrapper names; real existing CRM/Auth schema and enrolled authenticated-role draft/history calls; all replay objects rolled back. No local reset or data clone.',
    tables: tables.n,
    rls: tables.rls,
    functions: functions.n,
    functionOwnership: functions.owned,
    draftAndHistory: true,
    rollbackConfirmed: true,
  };
  await writeFile(
    new URL('../../docs/phases/benchmarks/phase-04/migration-compatibility.json', import.meta.url),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  client.release();
  await f.cleanup();
  await pool.end();
}
