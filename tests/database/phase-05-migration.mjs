// Rehearse the final additive migration in an isolated namespace/role, then roll it all back.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, pool } from './fixture.mjs';
const f = await fixture(),
  client = await pool.connect();
try {
  await client.query('begin');
  assert.equal(
    (
      await client.query(
        "select exists(select 1 from pg_namespace where nspname='phase05_review') or exists(select 1 from pg_roles where rolname='leadsfam_ai_review') present",
      )
    ).rows[0].present,
    false,
  );
  await client.query('create schema phase05_review');
  let sql = await readFile(
    new URL('../../supabase/migrations/20261101205116_ai_foundation.sql', import.meta.url),
    'utf8',
  );
  sql = sql
    .replaceAll('leadsfam_ai', 'leadsfam_ai_review')
    .replaceAll('private.ai_', 'phase05_review.ai_')
    .replaceAll('public.ai_', 'public.phase05_review_ai_')
    .replaceAll('ai_execution', 'ai_review_execution')
    .replace(
      'schema public,private to leadsfam_ai_review',
      'schema public,private,phase05_review to leadsfam_ai_review',
    )
    .replaceAll(
      'on schema private to leadsfam_ai_review',
      'on schema phase05_review to leadsfam_ai_review',
    )
    .replaceAll(
      'on schema private from leadsfam_ai_review',
      'on schema phase05_review from leadsfam_ai_review',
    )
    .replaceAll(
      'on schema private to leadsfam_policy',
      'on schema phase05_review to leadsfam_policy',
    )
    .replaceAll(
      'on schema private from leadsfam_policy',
      'on schema phase05_review from leadsfam_policy',
    )
    .replace(
      "n.nspname='private' and p.proname in ('ai_",
      "n.nspname='phase05_review' and p.proname in ('ai_",
    )
    .replaceAll('private.automation_validate', 'phase05_review.automation_validate')
    .replaceAll('private.automation_execute', 'phase05_review.automation_execute')
    .replace(/alter table private\.automation_tool_executions[^;]+;/g, '');
  const tableLoopStart = sql.indexOf("foreach relation in array array['ai_settings'");
  const tableLoopEnd = sql.indexOf(' end loop;', tableLoopStart);
  sql =
    sql.slice(0, tableLoopStart) +
    sql.slice(tableLoopStart, tableLoopEnd).replaceAll('private.%I', 'phase05_review.%I') +
    sql.slice(tableLoopEnd);
  await client.query(sql);
  await client.query('grant usage on schema phase05_review to authenticated,leadsfam_worker');
  assert.deepEqual(
    (
      await client.query(
        "select count(*)::int n,bool_and(relrowsecurity) rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='phase05_review' and c.relkind='r'",
      )
    ).rows[0],
    { n: 3, rls: true },
  );
  assert.equal(
    (
      await client.query(
        "select rolcanlogin or rolsuper or rolbypassrls unsafe from pg_roles where rolname='leadsfam_ai_review'",
      )
    ).rows[0].unsafe,
    false,
  );
  await client.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({
      sub: f.ids.owner.user,
      session_id: f.ids.owner.session,
      role: 'authenticated',
    }),
  ]);
  await client.query('set local role authenticated');
  const settings = (
    await client.query("select public.phase05_review_ai_read($1,'settings',null,'{}') result", [
      f.org,
    ])
  ).rows[0].result;
  assert.equal(settings.enabled, false);
  assert.equal(settings.provider, 'simulation');
  const id = randomUUID();
  await assert.rejects(
    client.query("select public.phase05_review_ai_manage($1,'request',$2,null,$3::jsonb)", [
      f.org,
      id,
      JSON.stringify({
        leadId: randomUUID(),
        task: 'analysis',
        channel: 'email',
        kind: 'follow_up',
      }),
    ]),
    { message: 'ai_disabled' },
  );
  // Expected failure aborts the rehearsal transaction. Its rollback removes all DDL/policies/grants.
  console.log(
    'Phase 05 fresh namespace/role/RLS/default-denial migration rehearsal passed; rolled back.',
  );
} finally {
  await client.query('rollback');
  client.release();
  await f.cleanup();
  await pool.end();
}
