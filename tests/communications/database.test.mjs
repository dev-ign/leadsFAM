import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AutomationDatabase } from '../../packages/database/dist/index.js';
import { localIdentity } from '../../scripts/local-identity.mjs';
import { processCommunication } from '../../apps/api/dist/modules/communications/dispatch.js';
import {
  UnsubmittedProviderError,
  mockProvider,
} from '../../apps/api/dist/modules/communications/providers.js';
import { fixture, pool, rpc } from '../database/fixture.mjs';

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
