// Explicit local migration verification; not a default suite or hosted runner.
// Raw synthetic fixture state stays mode-0600 outside the repository.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, pool, rpc } from './fixture.mjs';
import { localStack } from '../../scripts/local-stack.mjs';
import { AutomationDatabase } from '../../packages/database/dist/index.js';
import { localIdentity } from '../../scripts/local-identity.mjs';
import { crmQuerySchema } from '../../packages/shared/dist/index.js';
const [command, argument] = process.argv.slice(2);
const output = new URL(
  '../../docs/phases/benchmarks/phase-03/migration-verification/',
  import.meta.url,
);
const digest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const legacyTables = [
  'public.organizations',
  'public.organization_memberships',
  'public.profiles',
  'public.organization_notes',
  'public.contacts',
  'public.contact_emails',
  'public.contact_phones',
  'public.leads',
  'public.lead_sources',
  'public.lead_attributions',
  'public.crm_activities',
  'private.crm_request_receipts',
  'private.lead_import_jobs',
  'private.lead_import_rows',
  'private.lead_import_attempts',
];
const automationTables = [
  'source_integrations',
  'ingestion_receipts',
  'ingestion_attempts',
  'domain_events',
  'automation_workflows',
  'automation_versions',
  'automation_runs',
  'automation_jobs',
  'automation_tool_executions',
];
async function legacySnapshot(f) {
  const result = {};
  for (const table of legacyTables) {
    const where =
      table === 'public.organizations'
        ? 'id=any($1::uuid[])'
        : table === 'public.profiles'
          ? 'id=any($1::uuid[])'
          : 'organization_id=any($1::uuid[])';
    const values =
      table === 'public.profiles' ? Object.values(f.ids).map((p) => p.user) : [f.org, f.otherOrg];
    result[table] = (
      await pool.query(
        `select to_jsonb(t)-'created_by_integration'-'integration_id' value from ${table} t where ${where} order by (to_jsonb(t)-'created_by_integration'-'integration_id')::text`,
        [values],
      )
    ).rows.map((r) => r.value);
  }
  return result;
}
async function legacySecurity() {
  return {
    policies: (
      await pool.query(
        "select schemaname,tablename,policyname,permissive,roles::text[] roles,cmd,qual,with_check from pg_policies where schemaname in ('public','private') and policyname<>'automation_execution' order by schemaname,tablename,policyname",
      )
    ).rows,
    functions: (
      await pool.query(
        "select n.nspname schema,p.proname name,pg_get_function_identity_arguments(p.oid) arguments,pg_get_userbyid(p.proowner) owner,p.prosecdef definer,p.proconfig config,md5(pg_get_functiondef(p.oid)) definition_hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and (p.proname like 'crm_%' or p.proname in ('active_application_session','authorize_org','member_role','current_verified_email')) order by 1,2,3",
      )
    ).rows,
    grants: (
      await pool.query(
        "select grantee,table_schema,table_name,privilege_type from information_schema.role_table_grants where table_schema in ('public','private') and grantee in ('anon','authenticated','service_role','leadsfam_runtime','leadsfam_crm','leadsfam_policy') and table_name not like 'automation_%' and table_name not in ('source_integrations','ingestion_receipts','ingestion_attempts','domain_events') order by 1,2,3,4",
      )
    ).rows,
  };
}
async function catalog(label) {
  assert.match(label, /^(clean|upgrade)$/);
  const roles = (
    await pool.query(
      "select rolname,rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication from pg_roles where rolname in ('leadsfam_automation','leadsfam_ingress','leadsfam_worker') order by rolname",
    )
  ).rows;
  assert.equal(roles.length, 3);
  for (const role of roles) {
    assert.equal(role.rolcanlogin, role.rolname !== 'leadsfam_automation');
    for (const flag of [
      'rolsuper',
      'rolbypassrls',
      'rolinherit',
      'rolcreatedb',
      'rolcreaterole',
      'rolreplication',
    ])
      assert.equal(role[flag], false, `${role.rolname} ${flag}`);
  }
  const tables = (
    await pool.query(
      "select c.relname name,c.relrowsecurity rls,pg_get_userbyid(c.relowner) owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname=any($1::text[]) order by name",
      [automationTables],
    )
  ).rows;
  assert.equal(tables.length, 9);
  assert.ok(tables.every((t) => t.rls && t.owner === 'postgres'));
  const functions = (
    await pool.query(
      "select n.nspname schema,p.proname name,pg_get_function_identity_arguments(p.oid) arguments,pg_get_userbyid(p.proowner) owner,p.prosecdef definer,p.proconfig config,md5(pg_get_functiondef(p.oid)) definition_hash from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and (p.proname like 'automation_%' or p.proname='ingest_lead') order by 1,2,3",
    )
  ).rows;
  assert.equal(functions.length, 11);
  for (const fn of functions) {
    assert.ok(fn.config.includes('search_path=""'));
    assert.equal(
      fn.owner,
      fn.schema === 'public'
        ? 'postgres'
        : fn.name === 'automation_admin_generation'
          ? 'leadsfam_policy'
          : 'leadsfam_automation',
    );
    assert.equal(
      fn.definer,
      fn.schema === 'private' &&
        !['automation_validate', 'automation_creator_immutable'].includes(fn.name),
    );
  }
  const policies = (
    await pool.query(
      "select schemaname,tablename,policyname,roles::text[] roles,cmd,qual,with_check from pg_policies where policyname='automation_execution' order by schemaname,tablename",
    )
  ).rows;
  assert.equal(policies.length, 16);
  for (const policy of policies) {
    assert.deepEqual(policy.roles, ['leadsfam_automation']);
    if (!['source_integrations', 'automation_jobs'].includes(policy.tablename)) {
      assert.match(policy.qual, /leadsfam.automation_org/);
      assert.match(policy.with_check, /leadsfam.automation_org/);
    }
  }
  const privileges = [];
  for (const role of [
    'anon',
    'authenticated',
    'service_role',
    'leadsfam_runtime',
    'leadsfam_ingress',
    'leadsfam_worker',
  ]) {
    for (const table of automationTables)
      for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const value = (
          await pool.query('select has_table_privilege($1,$2,$3) value', [
            role,
            `private.${table}`,
            op,
          ])
        ).rows[0].value;
        assert.equal(value, false, `${role} ${table} ${op}`);
      }
    for (const fn of functions) {
      const signature = `${fn.schema}.${fn.name}(${fn.arguments.replaceAll(/\b(p_[a-z_]+) /g, '')})`;
      const value = (
        await pool.query("select has_function_privilege($1,$2,'EXECUTE') value", [role, signature])
      ).rows[0].value;
      const allowed =
        (role === 'authenticated' &&
          ['automation_manage', 'automation_overview'].includes(fn.name)) ||
        (role === 'leadsfam_ingress' && fn.name === 'ingest_lead') ||
        (role === 'leadsfam_worker' &&
          ['automation_claim', 'automation_execute'].includes(fn.name));
      assert.equal(value, allowed, `${role} ${signature}`);
      privileges.push({ role, signature, execute: value });
    }
  }
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from pg_auth_members where member in ('leadsfam_ingress'::regrole,'leadsfam_worker'::regrole,'leadsfam_automation'::regrole)",
      )
    ).rows[0].n,
    0,
  );
  const applied = (
    await pool.query(
      'select version,name from supabase_migrations.schema_migrations order by version',
    )
  ).rows;
  assert.equal(applied.length, 19);
  assert.equal(applied.at(-1).version, '20261030232445');
  const result = {
    schemaDigest: digest({ roles, tables, functions, policies, privileges, applied }),
    roles,
    tables,
    functions,
    policies,
    privileges,
    applied,
  };
  await writeFile(
    new URL(`${label}-catalog.json`, output),
    JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2) + '\n',
  );
  if (label === 'upgrade')
    assert.equal(
      result.schemaDigest,
      JSON.parse(await readFile(new URL('clean-catalog.json', output), 'utf8')).schemaDigest,
      'Clean and upgrade catalogs must match',
    );
  console.log({
    path: label,
    catalog: 'passed',
    roles: 3,
    privateRlsTables: 9,
    functions: 11,
    executionPolicies: 16,
    schemaDigest: result.schemaDigest,
  });
}
async function seed(stateFile) {
  const parent = await realpath(path.dirname(stateFile));
  const temporaryRoots = await Promise.all([tmpdir(), '/tmp'].map((p) => realpath(p)));
  assert.ok(
    path.isAbsolute(stateFile) &&
      temporaryRoots.some((root) => parent === root || parent.startsWith(root + path.sep)),
    'Raw fixture state must stay in an OS temporary directory',
  );
  const paths = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', '0ec8797', 'supabase/migrations'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  assert.equal(paths.length, 18);
  for (const file of paths)
    assert.equal(
      digest(await readFile(file, 'utf8')),
      digest(execFileSync('git', ['show', `0ec8797:${file}`], { encoding: 'utf8' })),
      file,
    );
  const applied = (
    await pool.query('select version from supabase_migrations.schema_migrations order by version')
  ).rows;
  assert.equal(applied.length, 18);
  assert.equal(applied.at(-1).version, '20261030212327');
  assert.equal(
    (await pool.query("select to_regclass('private.automation_jobs') present")).rows[0].present,
    null,
  );
  const f = await fixture();
  const source = await rpc(f.ids.owner, 'crm_sources', [
    f.org,
    null,
    null,
    { name: 'Synthetic upgrade source', archived: false },
  ]);
  const contact = await rpc(f.ids.owner, 'crm_save_contact', [
    f.org,
    'create',
    {
      kind: 'person',
      displayName: 'Synthetic retained contact',
      firstName: 'Synthetic',
      lastName: 'Retained',
      emails: [{ value: 'retained@example.test', normalized: 'retained@example.test' }],
      phones: [{ value: '+12025550123', normalized: '+12025550123', region: 'US' }],
    },
    null,
    null,
    randomUUID(),
  ]);
  const company = await rpc(f.ids.owner, 'crm_save_contact', [
    f.org,
    'create',
    {
      kind: 'company',
      displayName: 'Synthetic retained company',
      companyName: 'Synthetic retained company',
      emails: [],
      phones: [],
    },
    null,
    null,
    randomUUID(),
  ]);
  await rpc(f.ids.other, 'crm_save_contact', [
    f.otherOrg,
    'create',
    { kind: 'person', displayName: 'Synthetic other tenant', emails: [], phones: [] },
    null,
    null,
    randomUUID(),
  ]);
  const input = {
    contact: { mode: 'existing', id: contact.id },
    lead: {
      title: 'Synthetic retained inquiry',
      description: 'Synthetic baseline content',
      priority: 'high',
    },
    attribution: { sourceId: source.id, campaign: 'Synthetic baseline campaign' },
  };
  const key = randomUUID();
  let lead = await rpc(f.ids.member, 'crm_intake_manual', [f.org, input, key]);
  lead = await rpc(f.ids.owner, 'crm_change_lead', [
    f.org,
    lead.id,
    lead.version,
    'assign',
    { userId: f.ids.member.user },
  ]);
  lead = await rpc(f.ids.member, 'crm_change_lead', [
    f.org,
    lead.id,
    lead.version,
    'transition',
    { status: 'qualified' },
  ]);
  let closed = await rpc(f.ids.owner, 'crm_intake_manual', [
    f.org,
    {
      ...input,
      contact: { mode: 'existing', id: company.id },
      lead: { ...input.lead, title: 'Synthetic retained closed inquiry' },
    },
    randomUUID(),
  ]);
  closed = await rpc(f.ids.owner, 'crm_change_lead', [
    f.org,
    closed.id,
    closed.version,
    'transition',
    { status: 'closed', outcome: 'won' },
  ]);
  const job = randomUUID(),
    attempt = randomUUID(),
    rows = [
      {
        deliveryId: randomUUID(),
        rowNumber: 1,
        intake: { ...input, lead: { ...input.lead, title: 'Synthetic retained import' } },
      },
    ];
  const imported = await rpc(f.ids.admin, 'crm_import_execute', [
    f.org,
    job,
    attempt,
    JSON.stringify(rows),
  ]);
  await rpc(f.ids.member, 'write_note', [
    f.org,
    'Synthetic retained note',
    'Disposable migration verification',
    null,
  ]);
  const snapshot = await legacySnapshot(f),
    security = await legacySecurity();
  await writeFile(
    stateFile,
    JSON.stringify({
      ids: f.ids,
      org: f.org,
      otherOrg: f.otherOrg,
      source,
      contact,
      company,
      lead,
      closed,
      input,
      key,
      job,
      attempt,
      rows,
      imported,
      snapshot,
      security,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const manifest = {
    at: new Date().toISOString(),
    baselineCommit: '0ec8797',
    baselineMigration: '20261030212327',
    committedMigrationFilesVerified: 18,
    counts: Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, v.length])),
    snapshotDigest: digest(snapshot),
    securityDigest: digest(security),
  };
  await writeFile(new URL('upgrade-before.json', output), JSON.stringify(manifest, null, 2) + '\n');
  console.log(manifest);
}
async function verify(stateFile) {
  const f = JSON.parse(await readFile(stateFile, 'utf8'));
  const snapshot = await legacySnapshot(f);
  assert.deepEqual(snapshot, f.snapshot, 'Every legacy row/relationship must survive unchanged');
  assert.deepEqual(
    await legacySecurity(),
    f.security,
    'Existing role grants, policies and CRM function definitions must remain intact',
  );
  assert.equal(
    (await rpc(f.ids.member, 'crm_get', [f.org, 'lead', f.lead.id])).current_assignee_id,
    f.ids.member.user,
  );
  assert.equal(
    (await rpc(f.ids.owner, 'crm_intake_manual', [f.org, f.input, f.key])).id,
    f.lead.id,
  );
  assert.deepEqual(
    await rpc(f.ids.admin, 'crm_import_execute', [f.org, f.job, f.attempt, JSON.stringify(f.rows)]),
    f.imported,
  );
  await assert.rejects(rpc(f.ids.other, 'crm_get', [f.org, 'lead', f.lead.id]), {
    message: 'not_found',
  });
  await assert.rejects(
    rpc(f.ids.member, 'crm_sources', [
      f.org,
      null,
      null,
      { name: 'Unauthorized', archived: false },
    ]),
    { message: 'forbidden' },
  );
  await assert.rejects(
    rpc(f.ids.member, 'crm_change_lead', [
      f.org,
      f.lead.id,
      f.lead.version - 1,
      'update',
      { title: 'Stale', description: '', priority: 'normal' },
    ]),
    { message: 'version_conflict' },
  );
  const visible = await rpc(f.ids.member, 'crm_query', [
    f.org,
    'leads',
    crmQuerySchema.parse({
      q: 'Synthetic retained',
      searchMode: 'prefix',
      status: 'all',
      priority: 'all',
      assignee: 'all',
      archived: 'all',
      sort: 'created',
      pageSize: 25,
    }),
  ]);
  assert.equal(visible.items.length, 3);
  const reopened = await rpc(f.ids.owner, 'crm_change_lead', [
    f.org,
    f.closed.id,
    f.closed.version,
    'transition',
    { status: 'in_progress', reason: 'Synthetic upgrade verification' },
  ]);
  assert.equal(reopened.status, 'in_progress');
  const identity = await localIdentity(),
    ingress = new AutomationDatabase(identity.ingressDatabaseUrl, 'ingress'),
    worker = new AutomationDatabase(identity.workerDatabaseUrl, 'worker');
  let intakeResult;
  try {
    await ingress.start();
    await worker.start();
    const secretHash = digest(randomUUID());
    const integration = await rpc(f.ids.owner, 'automation_manage', [
      f.org,
      'integration',
      'create',
      null,
      null,
      { name: 'Synthetic upgraded integration', sourceId: f.source.id, credentialHash: secretHash },
    ]);
    const workflow = await rpc(f.ids.owner, 'automation_manage', [
      f.org,
      'workflow',
      'save',
      null,
      null,
      {
        name: 'Synthetic upgraded workflow',
        definition: {
          schemaVersion: 1,
          trigger: 'lead.created',
          conditions: [{ field: 'sourceId', equals: f.source.id }],
          steps: [
            {
              id: 'record',
              tool: 'activities.create',
              version: 1,
              arguments: { message: 'Synthetic upgraded activity' },
            },
          ],
        },
      },
    ]);
    await rpc(f.ids.owner, 'automation_manage', [
      f.org,
      'workflow',
      'publish',
      workflow.id,
      workflow.version,
      {},
    ]);
    const input = {
      schemaVersion: 1,
      externalEventId: randomUUID(),
      contact: { mode: 'existing', id: f.contact.id },
      lead: { title: 'Synthetic upgraded intake', description: '', priority: 'normal' },
      metadata: { eventKind: 'inquiry' },
    };
    intakeResult = await ingress.ingest(secretHash, input, randomUUID());
    assert.equal(
      (await ingress.ingest(secretHash, input, randomUUID())).leadId,
      intakeResult.leadId,
    );
    for (let n = 0; n < 3; n++) {
      const claim = await worker.claim();
      if (!claim) break;
      assert.equal(
        (await worker.execute(claim.id, claim.token, claim.generation)).state,
        'completed',
      );
    }
    const overview = await rpc(f.ids.owner, 'automation_overview', [f.org]);
    assert.equal(overview.runs.length, 1);
    assert.equal(overview.runs[0].completed_steps, 1);
    assert.equal(overview.runs[0].state, 'succeeded');
    assert.equal(overview.integrations[0].id, integration.id);
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from private.domain_events where organization_id=$1',
          [f.org],
        )
      ).rows[0].n,
      1,
      'No retroactive event backfill',
    );
    assert.equal(
      (await rpc(f.ids.member, 'crm_get', [f.org, 'lead', intakeResult.leadId])).contact.id,
      f.contact.id,
    );
  } finally {
    await ingress.close();
    await worker.close();
  }
  const summary = {
    at: new Date().toISOString(),
    legacySnapshotUnchanged: true,
    legacyRowsVerified: Object.values(snapshot).reduce((n, v) => n + v.length, 0),
    legacySecurityUnchanged: true,
    manualAndCsvReplay: true,
    searchAssignmentLifecycleAndCas: true,
    tenantAndMemberDenials: true,
    newIngestionAndWorkflow: true,
    newLogicalActivities: 1,
    noRetroactiveBackfill: true,
  };
  await writeFile(new URL('upgrade-after.json', output), JSON.stringify(summary, null, 2) + '\n');
  console.log(summary);
  // Teardown only the fixture's two known synthetic organizations and five users.
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role='replica'");
    for (const table of [
      ...automationTables.map((t) => `private.${t}`),
      ...legacyTables.filter((t) => !['public.organizations', 'public.profiles'].includes(t)),
      'public.organization_invitations',
    ])
      await c.query(`delete from ${table} where organization_id=any($1::uuid[])`, [
        [f.org, f.otherOrg],
      ]);
    await c.query('delete from public.organizations where id=any($1::uuid[])', [
      [f.org, f.otherOrg],
    ]);
    await c.query("set local session_replication_role='origin'");
    await c.query('delete from auth.users where id=any($1::uuid[])', [
      Object.values(f.ids).map((p) => p.user),
    ]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
try {
  localStack();
  if (command === 'catalog') await catalog(argument);
  else if (command === 'seed') await seed(argument);
  else if (command === 'verify') await verify(argument);
  else
    throw new Error('Choose catalog clean|upgrade, seed or verify with an OS-temporary state file');
} finally {
  await pool.end();
}
