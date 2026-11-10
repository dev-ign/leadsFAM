import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { AutomationDatabase, createSessionPool } from '../../packages/database/dist/index.js';
import { localIdentity } from '../../scripts/local-identity.mjs';
import { processCommunication } from '../../apps/api/dist/modules/communications/dispatch.js';
import {
  UnsubmittedProviderError,
  mockProvider,
} from '../../apps/api/dist/modules/communications/providers.js';
import { fixture, pool, rpc, waitForLock } from '../database/fixture.mjs';

const settings = {
  paused: false,
  dailyLimit: 100,
  recipientDailyLimit: 5,
  channelDailyLimit: 100,
  concurrentLimit: 2,
  requestsPerMinute: 30,
  maxAttempts: 3,
};
const manage = (f, action, id = null, version = null, data = {}, person = f.ids.owner) =>
  rpc(person, 'communication_manage', [f.org, action, id, version, data]);
const read = (f, kind, id = null, query = {}, person = f.ids.owner) =>
  rpc(person, 'communication_read', [f.org, kind, id, query]);
async function setup(run) {
  const f = await fixture();
  try {
    f.contact = randomUUID();
    f.lead = randomUUID();
    f.recipient = `synthetic-${randomUUID()}@example.test`;
    await pool.query(
      "insert into public.contacts(id,organization_id,kind,display_name,created_by) values($1,$2,'person','Synthetic recipient',$3)",
      [f.contact, f.org, f.ids.owner.user],
    );
    await pool.query('insert into public.contact_emails values($1,$2,1,$3,$3)', [
      f.org,
      f.contact,
      f.recipient,
    ]);
    await pool.query(
      "insert into public.contact_phones(organization_id,contact_id,position,value,normalized,region) values($1,$2,1,'+12025550123','+12025550123','US')",
      [f.org, f.contact],
    );
    await pool.query(
      "insert into public.leads(id,organization_id,contact_id,title,created_by) values($1,$2,$3,'Synthetic inquiry',$4)",
      [f.lead, f.org, f.contact, f.ids.owner.user],
    );
    f.draft = (channel = 'email', extra = {}) => ({
      id: randomUUID(),
      contactId: f.contact,
      leadId: f.lead,
      channel,
      purpose: 'transactional',
      recipient: channel === 'email' ? f.recipient : '+12025550123',
      subject: channel === 'email' ? 'Cleaning appointment' : '',
      body: 'Your synthetic appointment is ready.',
      ...extra,
    });
    f.consent = (channel = 'email', extra = {}) => ({
      contactId: f.contact,
      channel,
      purpose: 'transactional',
      recipient: channel === 'email' ? f.recipient : '+12025550123',
      status: 'granted',
      source: 'Synthetic explicit request',
      collectedAt: new Date(Date.now() - 1000).toISOString(),
      jurisdiction: 'US',
      policyVersion: 'synthetic-v1',
      evidence: 'fixture-consent',
      ...extra,
    });
    await run(f);
  } finally {
    await f.cleanup();
  }
}
const local = await localIdentity();
const worker = new AutomationDatabase(local.workerDatabaseUrl, 'worker');
const ingress = new AutomationDatabase(local.ingressDatabaseUrl, 'ingress');
after(async () => {
  await worker.close();
  await ingress.close();
  await pool.end();
});

test('communication privilege boundary: no LOGIN table access, RLS and closed private helpers', async () => {
  for (const role of ['leadsfam_communications', 'leadsfam_worker', 'leadsfam_ingress']) {
    const r = (
      await pool.query('select rolsuper,rolbypassrls from pg_roles where rolname=$1', [role])
    ).rows[0];
    assert.deepEqual(r, { rolsuper: false, rolbypassrls: false });
    for (const table of ['auth.users', 'private.app_sessions'])
      assert.equal(
        (await pool.query("select has_table_privilege($1,$2,'SELECT') value", [role, table]))
          .rows[0].value,
        false,
      );
  }
  for (const role of [
    'anon',
    'authenticated',
    'service_role',
    'leadsfam_runtime',
    'leadsfam_worker',
    'leadsfam_ingress',
  ]) {
    for (const table of [
      'private.communication_messages',
      'private.communication_events',
      'private.communication_permissions',
    ])
      assert.equal(
        (
          await pool.query(
            "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') value",
            [role, table],
          )
        ).rows[0].value,
        false,
      );
    assert.equal(
      (
        await pool.query(
          "select has_function_privilege($1,'private.communication_eligible(uuid,uuid,text,text,text)','EXECUTE') value",
          [role],
        )
      ).rows[0].value,
      false,
    );
  }
  const tables = (
    await pool.query(
      "select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relkind='r' and (relname like 'communication_%' or relname='conversations')",
    )
  ).rows;
  assert.equal(tables.filter((t) => !t.relrowsecurity).length, 0);
  assert.equal(tables.length, 9);
});

test('draft tenant ownership, strict sender rejection, validation, CAS and deterministic replay', () =>
  setup(async (f) => {
    const input = f.draft();
    const draft = await manage(f, 'draft', input.id, null, input);
    assert.equal(draft.state, 'draft');
    assert.equal(draft.sender, 'FreshNest <mock@example.test>');
    assert.equal((await manage(f, 'draft', input.id, null, input)).id, draft.id);
    await assert.rejects(
      manage(f, 'draft', input.id, 1, { ...input, sender: 'forged@example.test' }),
      /invalid_fields/,
    );
    await assert.rejects(
      manage(f, 'draft', input.id, 99, { ...input, body: 'New content' }),
      /version_conflict/,
    );
    await assert.rejects(
      manage(f, 'draft', input.id, 1, { ...input, body: 'Other member edit' }, f.ids.member),
      /forbidden/,
    );
    await assert.rejects(read(f, 'history', draft.conversation_id, {}, f.ids.other), /not_found/);
    const changed = await manage(f, 'draft', input.id, 1, {
      ...input,
      body: 'Updated synthetic content',
    });
    assert.equal(changed.version, 2);
    await assert.rejects(
      manage(f, 'draft', randomUUID(), null, { ...f.draft(), contactId: randomUUID() }),
    );
    assert.equal((await read(f, 'conversations')).items.length, 1);
    assert.equal((await read(f, 'history', draft.conversation_id)).messages.length, 1);
  }));

test('consent is channel, purpose and destination specific; send requires admin, evidence and unpaused workspace', () =>
  setup(async (f) => {
    const input = f.draft();
    const draft = await manage(f, 'draft', input.id, null, input);
    await assert.rejects(manage(f, 'send', draft.id, 1), /sending_paused/);
    await manage(f, 'settings', null, null, settings);
    assert.equal(
      (
        await read(f, 'eligibility', f.contact, {
          channel: 'email',
          recipient: f.recipient,
          purpose: 'transactional',
        })
      ).code,
      'CONSENT_REQUIRED',
    );
    await assert.rejects(manage(f, 'send', draft.id, 1), /recipient_ineligible/);
    await assert.rejects(manage(f, 'permission', null, null, f.consent(), f.ids.member));
    await assert.rejects(manage(f, 'permission', null, null, f.consent('email', { evidence: '' })));
    await manage(f, 'permission', null, null, f.consent());
    assert.equal(
      (
        await read(f, 'eligibility', f.contact, {
          channel: 'email',
          recipient: f.recipient,
          purpose: 'marketing',
        })
      ).code,
      'CONSENT_REQUIRED',
    );
    assert.equal(
      (
        await read(f, 'eligibility', f.contact, {
          channel: 'sms',
          recipient: '+12025550123',
          purpose: 'transactional',
        })
      ).code,
      'CONSENT_REQUIRED',
    );
    await assert.rejects(manage(f, 'send', draft.id, 1, {}, f.ids.member), /forbidden/);
    const sends = await Promise.all([
      manage(f, 'send', draft.id, 1),
      manage(f, 'send', draft.id, 1),
    ]);
    assert.equal(sends[0].id, sends[1].id);
    assert.equal(
      (
        await pool.query(
          'select count(*)::int count from private.communication_jobs where organization_id=$1',
          [f.org],
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int count from private.communication_events where organization_id=$1 and event='authorization_granted'",
          [f.org],
        )
      ).rows[0].count,
      1,
    );
  }));

test('suppression and revocation survive a new permission; unknown jurisdiction fails closed', () =>
  setup(async (f) => {
    await manage(f, 'permission', null, null, f.consent('email', { jurisdiction: 'ZZ' })).then(
      () => assert.fail('unknown jurisdiction accepted'),
      () => {},
    );
    await manage(f, 'permission', null, null, f.consent('email', { jurisdiction: 'JP' }));
    assert.equal(
      (
        await read(f, 'eligibility', f.contact, {
          channel: 'email',
          recipient: f.recipient,
          purpose: 'transactional',
        })
      ).code,
      'JURISDICTION_REVIEW_REQUIRED',
    );
    await manage(f, 'permission', null, null, f.consent());
    await manage(f, 'suppression', null, null, {
      channel: 'email',
      recipient: f.recipient,
      suppressed: true,
    });
    assert.equal(
      (
        await read(f, 'eligibility', f.contact, {
          channel: 'email',
          recipient: f.recipient,
          purpose: 'transactional',
        })
      ).code,
      'DESTINATION_SUPPRESSED',
    );
    await manage(f, 'suppression', null, null, {
      channel: 'email',
      recipient: f.recipient,
      suppressed: false,
    });
    await manage(f, 'permission', null, null, f.consent('email', { status: 'revoked' }));
    await manage(f, 'permission', null, null, f.consent());
    await assert.rejects(
      manage(f, 'suppression', null, null, {
        channel: 'email',
        recipient: f.recipient,
        suppressed: false,
      }),
      /suppression_review_required/,
    );
  }));

async function queue(f, channel = 'email', extra = {}) {
  await manage(f, 'settings', null, null, settings);
  await manage(f, 'permission', null, null, f.consent(channel));
  const input = f.draft(channel, extra);
  const m = await manage(f, 'draft', input.id, null, input);
  return manage(f, 'send', m.id, m.version);
}
async function state(f, id) {
  return (
    await pool.query(
      'select state,code from private.communication_messages where organization_id=$1 and id=$2',
      [f.org, id],
    )
  ).rows[0];
}
async function due(f) {
  await pool.query(
    "update private.communication_jobs set run_at=clock_timestamp()-interval '1 second' where organization_id=$1",
    [f.org],
  );
}

test('mock email and SMS acceptance, distinct delivery and ordered CRM-linked history', () =>
  setup(async (f) => {
    await worker.start();
    await ingress.start();
    for (const channel of ['email', 'sms']) {
      const m = await queue(f, channel);
      const claim = await worker.claimCommunication();
      assert.ok(claim);
      await processCommunication(worker, claim);
      assert.equal((await state(f, m.id)).state, 'submitted');
      await due(f);
      await processCommunication(worker, await worker.claimCommunication());
      assert.equal((await state(f, m.id)).state, 'delivered');
      const h = await read(f, 'history', m.conversation_id);
      assert.equal(h.messages[0].lead_id, f.lead);
      assert.equal(h.messages[0].contact_id, f.contact);
      assert.ok(h.events.some((e) => e.event === 'provider_accepted'));
      assert.ok(h.events.some((e) => e.event === 'delivered'));
    }
    assert.equal((await read(f, 'conversations', null, { contactId: f.contact })).items.length, 2);
  }));

test('competing claims, expired lease fencing and restart reconcile without a second send', () =>
  setup(async (f) => {
    const m = await queue(f);
    const claims = await Promise.all([worker.claimCommunication(), worker.claimCommunication()]);
    assert.equal(claims.filter(Boolean).length, 1);
    const first = claims.find(Boolean);
    const envelope = await worker.prepareCommunication(first.id, first.token, first.generation);
    assert.equal(envelope.operation, 'send');
    await pool.query(
      "update private.communication_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [first.id],
    );
    const second = await worker.claimCommunication();
    assert.ok(second.generation > first.generation);
    await assert.rejects(
      worker.finishCommunication(first.id, first.token, first.generation, {
        state: 'accepted',
        reference: `mock:${m.id}`,
      }),
      /lease_lost/,
    );
    const restarted = new AutomationDatabase(local.workerDatabaseUrl, 'worker');
    try {
      await restarted.start();
      await processCommunication(restarted, second);
      assert.equal((await state(f, m.id)).state, 'delivered');
    } finally {
      await restarted.close();
    }
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from private.communication_events where organization_id=$1 and event='submission_started'",
          [f.org],
        )
      ).rows[0].n,
      1,
    );
  }));

test('opt-out, changed recipient, pause and revoked approval are checked immediately before dispatch', () =>
  setup(async (f) => {
    let m = await queue(f);
    await manage(f, 'settings', null, null, { ...settings, paused: true });
    await processCommunication(worker, await worker.claimCommunication());
    assert.equal((await state(f, m.id)).state, 'queued');
    await manage(f, 'settings', null, null, settings);
    await due(f);
    await manage(f, 'permission', null, null, f.consent('email', { status: 'revoked' }));
    await processCommunication(worker, await worker.claimCommunication());
    assert.equal((await state(f, m.id)).state, 'suppressed');
    m = await queue(f, 'sms');
    await pool.query(
      "update public.organization_memberships set role='owner' where organization_id=$1 and user_id=$2",
      [f.org, f.ids.admin.user],
    );
    await pool.query(
      'update public.organization_memberships set revoked_at=clock_timestamp() where organization_id=$1 and user_id=$2',
      [f.org, f.ids.owner.user],
    );
    await processCommunication(worker, await worker.claimCommunication());
    assert.deepEqual(await state(f, m.id), { state: 'suppressed', code: 'AUTHORITY_REVOKED' });
  }));

test('provider timeout is attention, explicit reconciliation never resends; retry exhaustion terminates', () =>
  setup(async (f) => {
    const m = await queue(f);
    let sends = 0;
    const timeoutProvider = {
      ...mockProvider,
      async send() {
        sends++;
        return new Promise(() => {});
      },
    };
    await processCommunication(worker, await worker.claimCommunication(), timeoutProvider, 10);
    assert.deepEqual(await state(f, m.id), { state: 'attention', code: 'SUBMISSION_UNKNOWN' });
    assert.equal(await worker.claimCommunication(), null);
    const current = (await read(f, 'history', m.conversation_id)).messages[0];
    await manage(f, 'reconcile', m.id, current.version);
    await processCommunication(worker, await worker.claimCommunication(), timeoutProvider);
    assert.equal((await state(f, m.id)).state, 'delivered');
    assert.equal(sends, 1);
    const n = await queue(f);
    const rejected = {
      ...mockProvider,
      async send() {
        throw new UnsubmittedProviderError(true);
      },
    };
    for (let i = 0; i < 3; i++) {
      await processCommunication(worker, await worker.claimCommunication(), rejected);
      await due(f);
    }
    await processCommunication(worker, await worker.claimCommunication(), rejected);
    assert.deepEqual(await state(f, n.id), { state: 'failed', code: 'ATTEMPTS_EXHAUSTED' });
  }));

test('provider event ownership, idempotency, monotonic final state, STOP and START', () =>
  setup(async (f) => {
    const m = await queue(f);
    await processCommunication(worker, await worker.claimCommunication());
    const event = {
      eventId: randomUUID(),
      reference: `mock:${m.id}`,
      channel: 'email',
      type: 'delivered',
    };
    await ingress.communicationEvent(event);
    await ingress.communicationEvent(event);
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from private.communication_events where organization_id=$1 and provider_event_id=$2',
          [f.org, event.eventId],
        )
      ).rows[0].n,
      1,
    );
    await ingress.communicationEvent({ ...event, eventId: randomUUID(), type: 'failed' });
    assert.equal((await state(f, m.id)).state, 'delivered');
    await ingress.communicationEvent({ ...event, eventId: randomUUID(), type: 'opt_out' });
    await ingress.communicationEvent({ ...event, eventId: randomUUID(), type: 'start' });
    assert.equal(
      (
        await read(f, 'eligibility', f.contact, {
          channel: 'email',
          recipient: f.recipient,
          purpose: 'transactional',
        })
      ).code,
      'DESTINATION_SUPPRESSED',
    );
    await assert.rejects(ingress.communicationEvent({ ...event, organizationId: f.otherOrg }));
    const bad = { ...event, eventId: randomUUID(), channel: 'sms', type: 'bounced' };
    await ingress.communicationEvent(bad);
    assert.equal((await state(f, m.id)).state, 'delivered');
  }));

test('PostgreSQL budgets reserve atomically across jobs and block per-recipient overrun', () =>
  setup(async (f) => {
    const a = await queue(f);
    const b = await queue(f);
    await manage(f, 'settings', null, null, { ...settings, recipientDailyLimit: 1 });
    await Promise.all([worker.claimCommunication(), worker.claimCommunication()]).then((claims) =>
      Promise.all(claims.map((c) => processCommunication(worker, c))),
    );
    const states = await Promise.all([state(f, a.id), state(f, b.id)]);
    assert.equal(states.filter((s) => s.state === 'submitted').length, 1);
    assert.equal(states.filter((s) => s.code === 'DAILY_LIMIT').length, 1);
  }));

test('actual worker process death after submission admission is recovered by reconciliation on restart', () =>
  setup(async (f) => {
    const { fork } = await import('node:child_process');
    const m = await queue(f);
    const spawn = (mode) =>
      fork(new URL('./worker-process.mjs', import.meta.url), [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...process.env,
          WORKER_DATABASE_URL: local.workerDatabaseUrl,
          PHASE04_WORKER_MODE: mode,
        },
      });
    const wait = (child) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Synthetic worker deadline'));
        }, 10000);
        child.once('message', (m) => {
          clearTimeout(timer);
          resolve(m.claim);
        });
        child.once('error', reject);
      });
    const child = spawn('prepare');
    let first;
    try {
      first = await wait(child);
    } finally {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await pool.query(
      "update private.communication_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [first.id],
    );
    const restarted = spawn('reconcile');
    const second = await wait(restarted);
    await new Promise((resolve) => restarted.once('exit', resolve));
    assert.equal(first.id, second.id);
    assert.ok(second.generation > first.generation);
    assert.equal((await state(f, m.id)).state, 'delivered');
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from private.communication_events where organization_id=$1 and event='submission_started'",
          [f.org],
        )
      ).rows[0].n,
      1,
    );
  }));

test('changed CRM destination is suppressed and message/conversation pagination is bounded', () =>
  setup(async (f) => {
    const m = await queue(f);
    await pool.query(
      'delete from public.contact_emails where organization_id=$1 and contact_id=$2',
      [f.org, f.contact],
    );
    await processCommunication(worker, await worker.claimCommunication());
    assert.deepEqual(await state(f, m.id), { state: 'suppressed', code: 'RECIPIENT_CHANGED' });
    for (let i = 0; i < 51; i++) {
      const input = f.draft('email', { subject: `Page ${i}` });
      await manage(f, 'draft', input.id, null, input);
    }
    const first = await read(f, 'history', m.conversation_id);
    assert.equal(first.messages.length, 50);
    assert.ok(first.next);
    const second = await read(f, 'history', m.conversation_id, { cursor: first.next });
    assert.equal(second.messages.length, 2);
    assert.equal(second.next, null);
    assert.equal(new Set([...first.messages, ...second.messages].map((x) => x.id)).size, 52);
    await assert.rejects(read(f, 'history', m.conversation_id, { cursor: 'not-a-cursor' }));
  }));

test('authorization and outbox are atomic; a claim alone cannot bypass dispatch preparation', () =>
  setup(async (f) => {
    await manage(f, 'settings', null, null, settings);
    await manage(f, 'permission', null, null, f.consent());
    const input = f.draft(),
      m = await manage(f, 'draft', input.id, null, input);
    const functionName = `communication_fault_${f.org.replaceAll('-', '')}`;
    await pool.query(
      `create function private.${functionName}() returns trigger language plpgsql as $$ begin if new.organization_id='${f.org}'::uuid then raise exception 'synthetic outbox failure'; end if; return new; end $$`,
    );
    await pool.query(
      `create trigger ${functionName} before insert on private.communication_jobs for each row execute function private.${functionName}()`,
    );
    try {
      await assert.rejects(manage(f, 'send', m.id, 1), /synthetic outbox failure/);
      assert.equal((await state(f, m.id)).state, 'draft');
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from private.communication_events where organization_id=$1 and event='authorization_granted'",
            [f.org],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await pool.query(`drop trigger ${functionName} on private.communication_jobs`);
      await pool.query(`drop function private.${functionName}()`);
    }
    await manage(f, 'send', m.id, 1);
    const claim = await worker.claimCommunication();
    await assert.rejects(
      worker.finishCommunication(claim.id, claim.token, claim.generation, {
        state: 'delivered',
        reference: null,
      }),
      /invalid_fields/,
    );
    assert.equal((await state(f, m.id)).state, 'queued');
  }));

for (const dimension of ['dailyLimit', 'channelDailyLimit'])
  test(`${dimension} is enforced independently of the destination budget`, () =>
    setup(async (f) => {
      const a = await queue(f),
        b = await queue(f);
      await manage(f, 'settings', null, null, { ...settings, [dimension]: 1 });
      for (let i = 0; i < 2; i++)
        await processCommunication(worker, await worker.claimCommunication());
      const states = await Promise.all([state(f, a.id), state(f, b.id)]);
      assert.equal(states.filter((s) => s.code === 'DAILY_LIMIT').length, 1);
    }));

test('concurrent submission and per-minute provider request limits defer work durably', () =>
  setup(async (f) => {
    const a = await queue(f),
      b = await queue(f);
    await manage(f, 'settings', null, null, {
      ...settings,
      concurrentLimit: 1,
      requestsPerMinute: 1,
    });
    const first = await worker.claimCommunication(),
      second = await worker.claimCommunication();
    const prepared = await worker.prepareCommunication(first.id, first.token, first.generation);
    assert.equal(prepared.operation, 'send');
    assert.equal(
      await worker.prepareCommunication(second.id, second.token, second.generation),
      null,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from private.communication_messages where organization_id=$1 and state='submitting'",
          [f.org],
        )
      ).rows[0].n,
      1,
    );
    await worker.finishCommunication(first.id, first.token, first.generation, {
      state: 'accepted',
      reference: prepared.providerReference,
    });
    await pool.query(
      "update private.communication_jobs set run_at=clock_timestamp()-interval '1 second' where organization_id=$1 and message_id=$2",
      [f.org, b.id],
    );
    const blocked = await worker.claimCommunication();
    assert.equal(
      await worker.prepareCommunication(blocked.id, blocked.token, blocked.generation),
      null,
    );
    assert.equal((await state(f, a.id)).state, 'submitted');
    assert.equal((await state(f, b.id)).state, 'queued');
    assert.equal(
      (
        await pool.query(
          "select used from private.communication_budgets where organization_id=$1 and dimension='requests' order by bucket desc limit 1",
          [f.org],
        )
      ).rows[0].used,
      1,
    );
  }));

test('immutable lifecycle events have complete bounded keyset pagination and tenant authorization', () =>
  setup(async (f) => {
    const input = f.draft(),
      m = await manage(f, 'draft', input.id, null, input);
    await pool.query(
      "insert into private.communication_events(organization_id,message_id,event) select $1,$2,'synthetic_history' from generate_series(1,105)",
      [f.org, m.id],
    );
    const first = await read(f, 'events', m.id);
    assert.equal(first.items.length, 100);
    assert.ok(first.next);
    const next = await read(f, 'events', m.id, { cursor: first.next });
    assert.equal(next.items.length, 6);
    assert.equal(next.next, null);
    assert.equal(new Set([...first.items, ...next.items].map((x) => x.id)).size, 106);
    await assert.rejects(read(f, 'events', m.id, {}, f.ids.other), /not_found/);
  }));

const inboundHash = (key) => createHash('sha256').update(key).digest('hex');
async function connector(f, capability = 'mock_inbound', person = f.ids.owner) {
  const key = 'lf_inb_' + randomBytes(32).toString('base64url');
  const integration = await rpc(person, 'automation_manage', [
    f.org,
    'integration',
    'create',
    null,
    null,
    { name: 'Synthetic replies', capability, credentialHash: inboundHash(key) },
  ]);
  return { key, hash: inboundHash(key), integration };
}
const incoming = (f, extra = {}) => ({
  eventId: randomUUID(),
  channel: 'email',
  sender: f.recipient,
  subject: 'Synthetic reply',
  body: '  Actually three bedrooms.\nPlease confirm an estimate. 🙂  ',
  replyTo: null,
  occurredAt: null,
  ...extra,
});

test('inbound capability, least privilege, revoked and rotated authority fail closed', () =>
  setup(async (f) => {
    const intake = await connector(f, 'lead_intake'),
      c = await connector(f);
    for (const role of [
      'anon',
      'authenticated',
      'service_role',
      'leadsfam_runtime',
      'leadsfam_worker',
      'leadsfam_ingress',
    ])
      assert.equal(
        (
          await pool.query(
            "select has_table_privilege($1,'private.inbound_receipts','SELECT') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
    assert.equal(
      (
        await pool.query(
          "select has_function_privilege('leadsfam_ingress','private.inbound_context(text,boolean)','EXECUTE') allowed",
        )
      ).rows[0].allowed,
      false,
    );
    await assert.rejects(ingress.authorizeInbound(intake.hash), {
      message: 'credentials_rejected',
    });
    await assert.rejects(ingress.ingest(intake.hash, {}, randomUUID())); // Shape is still checked on the intake-only path.
    await assert.rejects(ingress.ingest(c.hash, {}, randomUUID()), {
      message: 'credentials_rejected',
    });
    await assert.rejects(worker.ingestInbound(c.hash, incoming(f)), {
      message: 'Invalid runtime capability',
    });
    await assert.rejects(
      ingress.ingestInbound(c.hash, { ...incoming(f), organizationId: f.otherOrg }),
      { message: 'invalid_fields' },
    );
    await assert.rejects(
      pool.query("update private.source_integrations set capability='lead_intake' where id=$1", [
        c.integration.id,
      ]),
      { message: 'immutable_identity' },
    );
    let current = await rpc(f.ids.owner, 'automation_manage', [
      f.org,
      'integration',
      'paused',
      c.integration.id,
      1,
      {},
    ]);
    await assert.rejects(ingress.authorizeInbound(c.hash), { message: 'credentials_rejected' });
    current = await rpc(f.ids.owner, 'automation_manage', [
      f.org,
      'integration',
      'active',
      current.id,
      current.version,
      {},
    ]);
    await ingress.authorizeInbound(c.hash);
    assert.equal(current.credential_generation, 1);
    const replacement = 'lf_inb_' + randomBytes(32).toString('base64url');
    current = await rpc(f.ids.owner, 'automation_manage', [
      f.org,
      'integration',
      'rotate',
      current.id,
      current.version,
      { credentialHash: inboundHash(replacement) },
    ]);
    assert.equal(current.credential_generation, 4);
    await assert.rejects(ingress.authorizeInbound(c.hash), { message: 'credentials_rejected' });
    await ingress.authorizeInbound(inboundHash(replacement));
    await pool.query(
      "update private.source_integrations set expires_at=now()-interval '1 second' where id=$1",
      [current.id],
    );
    await assert.rejects(ingress.authorizeInbound(inboundHash(replacement)), {
      message: 'credentials_rejected',
    });
    const delegated = await connector(f, 'mock_inbound', f.ids.admin);
    await pool.query(
      'update public.organization_memberships set revoked_at=now() where organization_id=$1 and user_id=$2',
      [f.org, f.ids.admin.user],
    );
    await assert.rejects(ingress.authorizeInbound(delegated.hash), {
      message: 'credentials_rejected',
    });
  }));

test('inbound email/SMS replies retain exact normalized content, provenance and one effect under replay', () =>
  setup(async (f) => {
    const c = await connector(f);
    await manage(f, 'settings', null, null, settings);
    const initialEvents = (
      await pool.query(
        'select count(*)::int n from private.domain_events where organization_id=$1',
        [f.org],
      )
    ).rows[0].n;
    for (const channel of ['email', 'sms']) {
      const draft = f.draft(channel),
        input = incoming(f, {
          channel,
          sender: channel === 'email' ? f.recipient : '+12025550123',
          subject: channel === 'email' ? 'Synthetic reply' : '',
          occurredAt: '2001-01-01T00:00:00Z',
        });
      await manage(f, 'permission', null, null, f.consent(channel));
      await manage(f, 'draft', draft.id, null, draft);
      await manage(f, 'send', draft.id, 1);
      await processCommunication(worker, await worker.claimCommunication());
      await due(f);
      await processCommunication(worker, await worker.claimCommunication());
      input.replyTo = draft.id;
      const results = await Promise.all([
        ingress.ingestInbound(c.hash, input),
        ingress.ingestInbound(c.hash, input),
      ]);
      assert.equal(results[0].messageId, results[1].messageId);
      assert.equal(results[0].state, 'linked');
      assert.equal(results.filter((r) => r.replayed).length, 1);
      await assert.rejects(
        ingress.ingestInbound(c.hash, { ...input, body: 'Conflicting synthetic text' }),
        { message: 'idempotency_conflict' },
      );
      const message = (
        await pool.query('select * from private.communication_messages where id=$1', [
          results[0].messageId,
        ])
      ).rows[0];
      assert.equal(message.body, input.body);
      assert.equal(message.created_by, null);
      assert.equal(message.created_by_integration, c.integration.id);
      assert.equal(message.direction, 'inbound');
      assert.equal(message.lead_id, f.lead);
      assert.equal(message.contact_id, f.contact);
      assert.equal(message.authorized_by, null);
      assert.equal(message.approved_at, null);
      assert.equal(message.state, 'delivered');
      assert.ok(message.created_at.getUTCFullYear() > 2001);
      const late = await ingress.ingestInbound(c.hash, {
        ...input,
        eventId: randomUUID(),
        occurredAt: '1999-01-01T00:00:00Z',
      });
      const timeline = await read(f, 'history', message.conversation_id);
      assert.deepEqual(
        timeline.messages.filter((m) => m.direction === 'inbound').map((m) => m.id),
        [message.id, late.messageId],
      );
      const storedTime = (
        await pool.query(
          'select occurred_at,received_at from private.inbound_receipts where id=$1',
          [late.receiptId],
        )
      ).rows[0];
      assert.equal(storedTime.occurred_at.getUTCFullYear(), 1999);
      assert.ok(storedTime.received_at >= message.created_at);
      const readBack = await read(f, 'message', message.id);
      assert.equal(readBack.integration_name, 'Synthetic replies');
      await assert.rejects(manage(f, 'send', message.id, message.version), {
        message: 'forbidden',
      });
      await assert.rejects(
        manage(f, 'draft', message.id, message.version, { ...draft, id: message.id }),
        { message: 'forbidden' },
      );
      await assert.rejects(
        pool.query(
          'insert into private.communication_jobs(organization_id,message_id) values($1,$2)',
          [f.org, message.id],
        ),
        { message: 'inbound_not_sendable' },
      );
      await assert.rejects(
        pool.query("update private.inbound_receipts set body='Changed' where id=$1", [
          results[0].receiptId,
        ]),
        { message: 'immutable_identity' },
      );
      await assert.rejects(
        pool.query("update private.communication_messages set body='Changed' where id=$1", [
          message.id,
        ]),
        { message: 'immutable_identity' },
      );
    }
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from private.domain_events where organization_id=$1',
          [f.org],
        )
      ).rows[0].n,
      initialEvents,
    );
    assert.equal(
      (await pool.query('select status from public.leads where id=$1', [f.lead])).rows[0].status,
      'new',
    );
    assert.equal(
      (
        await pool.query('select count(*)::int n from private.ai_runs where organization_id=$1', [
          f.org,
        ])
      ).rows[0].n,
      0,
    );
  }));

test('inbound matching isolates identical senders and defers unknown, ambiguous and unverifiable references', () =>
  setup(async (f) => {
    const c = await connector(f),
      foreign = randomUUID();
    await pool.query(
      "insert into public.contacts(id,organization_id,kind,display_name,created_by) values($1,$2,'person','Foreign synthetic customer',$3)",
      [foreign, f.otherOrg, f.ids.other.user],
    );
    await pool.query('insert into public.contact_emails values($1,$2,1,$3,$3)', [
      f.otherOrg,
      foreign,
      f.recipient,
    ]);
    const unique = await ingress.ingestInbound(c.hash, incoming(f));
    assert.equal(unique.state, 'linked');
    const unknown = await ingress.ingestInbound(
      c.hash,
      incoming(f, { sender: 'unknown@example.test' }),
    );
    assert.equal(unknown.state, 'needs_review');
    let review = await read(f, 'inbound');
    assert.equal(review.items.find((r) => r.id === unknown.receiptId).reason, 'unknown_customer');
    const otherLead = randomUUID();
    await pool.query(
      "insert into public.leads(id,organization_id,contact_id,title,created_by) values($1,$2,$3,'Another synthetic inquiry',$4)",
      [otherLead, f.org, f.contact, f.ids.owner.user],
    );
    const ambiguous = await ingress.ingestInbound(c.hash, incoming(f));
    assert.equal(ambiguous.state, 'needs_review');
    const foreignConversation = randomUUID(),
      foreignMessage = randomUUID();
    await pool.query(
      "insert into private.conversations(id,organization_id,contact_id,channel) values($1,$2,$3,'email')",
      [foreignConversation, f.otherOrg, foreign],
    );
    await pool.query(
      "insert into private.communication_messages(id,organization_id,conversation_id,contact_id,channel,purpose,sender,recipient,subject,body,state,created_by) values($1,$2,$3,$4,'email','transactional','FreshNest <mock@example.test>',$5,'Synthetic','Synthetic','delivered',$6)",
      [foreignMessage, f.otherOrg, foreignConversation, foreign, f.recipient, f.ids.other.user],
    );
    const wrong = await ingress.ingestInbound(c.hash, incoming(f, { replyTo: foreignMessage }));
    assert.equal(wrong.state, 'needs_review');
    assert.equal(wrong.messageId, null);
    review = await read(f, 'inbound');
    assert.equal(review.items.find((r) => r.id === wrong.receiptId).reason, 'reply_unverified');
    assert.equal(
      review.items.find((r) => r.id === ambiguous.receiptId).reason,
      'multiple_conversations',
    );
    await assert.rejects(read(f, 'inbound', null, {}, f.ids.other), { message: 'not_found' });
    await assert.rejects(
      manage(f, 'resolve_inbound', unknown.receiptId, null, { contactId: foreign, leadId: f.lead }),
      { message: 'not_found' },
    );
    await assert.rejects(
      manage(
        f,
        'resolve_inbound',
        unknown.receiptId,
        null,
        { contactId: f.contact, leadId: f.lead },
        f.ids.other,
      ),
      { message: 'not_found' },
    );
    const links = await Promise.all(
      [0, 1].map(() =>
        manage(f, 'resolve_inbound', unknown.receiptId, null, {
          contactId: f.contact,
          leadId: f.lead,
        }),
      ),
    );
    assert.equal(links[0].id, links[1].id);
    assert.equal(links[0].created_by_integration, c.integration.id);
    await assert.rejects(
      manage(f, 'resolve_inbound', unknown.receiptId, null, {
        contactId: f.contact,
        leadId: otherLead,
      }),
      { message: 'idempotency_conflict' },
    );
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from private.communication_messages where organization_id=$1 and created_by_integration=$2',
          [f.org, c.integration.id],
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from private.communication_jobs where organization_id=$1',
          [f.org],
        )
      ).rows[0].n,
      0,
    );
    const noLead = randomUUID();
    await pool.query(
      "insert into public.contacts(id,organization_id,kind,display_name,created_by) values($1,$2,'person','No-lead synthetic customer',$3)",
      [noLead, f.org, f.ids.owner.user],
    );
    await pool.query('insert into public.contact_emails values($1,$2,1,$3,$3)', [
      f.org,
      noLead,
      'nolead@example.test',
    ]);
    const unassigned = await ingress.ingestInbound(
      c.hash,
      incoming(f, { sender: 'nolead@example.test' }),
    );
    assert.equal(
      (await read(f, 'inbound')).items.find((r) => r.id === unassigned.receiptId).reason,
      'no_matching_lead',
    );
    await assert.rejects(
      manage(f, 'resolve_inbound', unassigned.receiptId, null, {
        contactId: noLead,
        leadId: f.lead,
      }),
      { message: 'not_found' },
    );
    await pool.query(
      'update public.contact_emails set value=$1,normalized=$1 where organization_id=$2 and contact_id=$3',
      [f.recipient, f.org, noLead],
    );
    const shared = await ingress.ingestInbound(c.hash, incoming(f));
    assert.equal(
      (await read(f, 'inbound')).items.find((r) => r.id === shared.receiptId).reason,
      'multiple_contacts',
    );
  }));

test('inbound receipt retries survive rollback and lost acknowledgment without changing history', () =>
  setup(async (f) => {
    const c = await connector(f),
      input = incoming(f),
      direct = createSessionPool(local.ingressDatabaseUrl),
      client = await direct.connect();
    try {
      await client.query('begin');
      await client.query('select private.inbound_ingest($1,$2::jsonb)', [
        c.hash,
        JSON.stringify(input),
      ]);
      await client.query('rollback');
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from private.inbound_receipts where integration_id=$1',
            [c.integration.id],
          )
        ).rows[0].n,
        0,
      );
      await ingress.ingestInbound(c.hash, input); // Model a successful commit whose response was lost.
      const replay = await ingress.ingestInbound(c.hash, input);
      assert.equal(replay.replayed, true);
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from private.inbound_receipts where integration_id=$1',
            [c.integration.id],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from private.communication_messages where created_by_integration=$1',
            [c.integration.id],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await client.query('rollback');
      client.release();
      await direct.end();
    }
  }));

test('inbound revocation wins before a blocked admission and admitted work linearizes before revocation', async () => {
  for (const order of ['revoke_first', 'admit_first'])
    await setup(async (f) => {
      const c = await connector(f),
        direct = createSessionPool(local.ingressDatabaseUrl),
        client = await direct.connect(),
        revoker = await pool.connect();
      try {
        if (order === 'revoke_first') {
          await revoker.query('begin');
          await revoker.query('select 1 from public.organizations where id=$1 for update', [f.org]);
          await revoker.query(
            "update private.source_integrations set status='revoked' where id=$1",
            [c.integration.id],
          );
          const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
          const pending = client.query('select private.inbound_ingest($1,$2::jsonb)', [
            c.hash,
            JSON.stringify(incoming(f)),
          ]);
          const rejected = assert.rejects(pending, { message: 'credentials_rejected' });
          await waitForLock(pid);
          await revoker.query('commit');
          await rejected;
          assert.equal(
            (
              await pool.query(
                'select count(*)::int n from private.inbound_receipts where integration_id=$1',
                [c.integration.id],
              )
            ).rows[0].n,
            0,
          );
        } else {
          await client.query('begin');
          await client.query('select private.inbound_ingest($1,$2::jsonb)', [
            c.hash,
            JSON.stringify(incoming(f)),
          ]);
          const pid = (await revoker.query('select pg_backend_pid() pid')).rows[0].pid;
          const pending = revoker.query(
            'select 1 from public.organizations where id=$1 for update',
            [f.org],
          );
          await waitForLock(pid);
          await client.query('commit');
          await pending;
          await revoker.query(
            "update private.source_integrations set status='revoked' where id=$1",
            [c.integration.id],
          );
          await assert.rejects(ingress.ingestInbound(c.hash, incoming(f)), {
            message: 'credentials_rejected',
          });
          assert.equal(
            (
              await pool.query(
                'select count(*)::int n from private.inbound_receipts where integration_id=$1',
                [c.integration.id],
              )
            ).rows[0].n,
            1,
          );
        }
      } finally {
        await client.query('rollback');
        await revoker.query('rollback');
        client.release();
        revoker.release();
        await direct.end();
      }
    });
});
