import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, fixture, pool, rpc, waitForLock } from './fixture.mjs';

after(() => pool.end());
const contactData = (extra = {}) => ({
  kind: 'person',
  displayName: `Synthetic ${randomUUID()}`,
  emails: [],
  phones: [],
  ...extra,
});
async function setup(run) {
  const f = await fixture();
  try {
    f.contact = await rpc(f.ids.owner, 'crm_save_contact', [
      f.org,
      'create',
      contactData(),
      null,
      null,
      randomUUID(),
    ]);
    f.lead = randomUUID();
    await pool.query(
      'insert into public.leads(id,organization_id,contact_id,title,created_by) values($1,$2,$3,$4,$5)',
      [f.lead, f.org, f.contact.id, 'Synthetic lead', f.ids.owner.user],
    );
    await run(f);
  } finally {
    await f.cleanup();
  }
}
const change = (f, person, version, action, data) =>
  rpc(person, 'crm_change_lead', [f.org, f.lead, version, action, data]);

test('contact idempotency, explicit duplicate review, bounded channels and actor integrity', () =>
  setup(async (f) => {
    const key = randomUUID(),
      data = contactData({
        emails: [{ value: 'SYNTH@example.test', normalized: 'synth@example.test' }],
      });
    const first = await rpc(f.ids.member, 'crm_save_contact', [
      f.org,
      'create',
      data,
      null,
      null,
      key,
    ]);
    assert.equal(first.created_by, f.ids.member.user);
    assert.equal(
      (await rpc(f.ids.member, 'crm_save_contact', [f.org, 'create', data, null, null, key])).id,
      first.id,
    );
    await assert.rejects(
      rpc(f.ids.member, 'crm_save_contact', [
        f.org,
        'create',
        { ...data, displayName: 'Changed' },
        null,
        null,
        key,
      ]),
      { message: 'idempotency_conflict' },
    );
    await assert.rejects(
      rpc(f.ids.member, 'crm_save_contact', [f.org, 'create', data, null, null, randomUUID()]),
      { message: 'duplicate_review_required' },
    );
    assert.notEqual(
      (
        await rpc(f.ids.member, 'crm_save_contact', [
          f.org,
          'create',
          { ...data, duplicateResolution: 'create_distinct' },
          null,
          null,
          randomUUID(),
        ])
      ).id,
      first.id,
    );
    await assert.rejects(
      rpc(f.ids.member, 'crm_save_contact', [
        f.org,
        'create',
        { ...contactData(), created_by: f.ids.owner.user },
        null,
        null,
        randomUUID(),
      ]),
      { message: 'invalid_fields' },
    );
    await assert.rejects(
      rpc(f.ids.member, 'crm_save_contact', [
        f.otherOrg,
        'create',
        contactData(),
        null,
        null,
        randomUUID(),
      ]),
      { message: 'not_found' },
    );
  }));

test('competing lead edits have one winner and exactly one atomic activity', () =>
  setup(async (f) => {
    const outcomes = await Promise.allSettled([
      change(f, f.ids.member, 1, 'update', { title: 'First', description: '', priority: 'normal' }),
      change(f, f.ids.admin, 1, 'update', { title: 'Second', description: '', priority: 'high' }),
    ]);
    assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find((r) => r.status === 'rejected').reason.message, 'version_conflict');
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from public.crm_activities where organization_id=$1 and lead_id=$2',
          [f.org, f.lead],
        )
      ).rows[0].n,
      1,
    );
  }));

test('closing, reopening, archive and contact archive invariants apply to direct RPC', () =>
  setup(async (f) => {
    await assert.rejects(change(f, f.ids.member, 1, 'transition', { status: 'closed' }), {
      code: '23514',
    });
    await assert.rejects(
      rpc(f.ids.owner, 'crm_save_contact', [f.org, 'archive', {}, f.contact.id, 1]),
      { message: 'contact_has_open_leads' },
    );
    await change(f, f.ids.member, 1, 'transition', { status: 'closed', outcome: 'won' });
    await assert.rejects(
      change(f, f.ids.member, 2, 'update', {
        title: 'Closed edit',
        description: '',
        priority: 'normal',
      }),
      { message: 'closed_record' },
    );
    await assert.rejects(
      change(f, f.ids.member, 2, 'transition', { status: 'in_progress', reason: 'New discussion' }),
      { message: 'forbidden' },
    );
    await assert.rejects(change(f, f.ids.owner, 2, 'transition', { status: 'in_progress' }), {
      message: 'reopen_reason_required',
    });
    const reopened = await change(f, f.ids.admin, 2, 'transition', {
      status: 'in_progress',
      reason: 'New discussion',
    });
    assert.equal(reopened.outcome, null);
    assert.equal(reopened.closed_at, null);
    await assert.rejects(change(f, f.ids.member, 3, 'archive', {}), { message: 'forbidden' });
    await change(f, f.ids.admin, 3, 'archive', {});
    await rpc(f.ids.owner, 'crm_save_contact', [f.org, 'archive', {}, f.contact.id, 1]);
    await assert.rejects(change(f, f.ids.owner, 4, 'restore', {}), { message: 'archived_contact' });
  }));

test('member claim, release, administrative assignment and generation fencing', () =>
  setup(async (f) => {
    await assert.rejects(change(f, f.ids.member, 1, 'assign', { userId: f.ids.admin.user }), {
      message: 'forbidden',
    });
    await change(f, f.ids.member, 1, 'assign', { userId: f.ids.member.user });
    await assert.rejects(change(f, f.ids.member, 2, 'assign', { userId: f.ids.owner.user }), {
      message: 'forbidden',
    });
    await change(f, f.ids.member, 2, 'assign', { userId: null });
    await change(f, f.ids.admin, 3, 'assign', { userId: f.ids.member.user });
    await rpc(f.ids.owner, 'change_member', [f.org, f.ids.member.user, null, true]);
    const before = await rpc(f.ids.owner, 'crm_get', [f.org, 'lead', f.lead]);
    assert.equal(before.current_assignee_id, null);
    assert.equal(before.last_assigned_user_id, f.ids.member.user);
    await pool.query(
      'update public.organization_memberships set revoked_at=null where organization_id=$1 and user_id=$2',
      [f.org, f.ids.member.user],
    );
    assert.equal(
      (await rpc(f.ids.owner, 'crm_get', [f.org, 'lead', f.lead])).current_assignee_id,
      null,
    );
  }));

test('CRM read queued behind revocation rechecks membership', () =>
  setup(async (f) => {
    const revoke = await actor(f.ids.owner),
      read = await actor(f.ids.member);
    try {
      await revoke.client.query('select public.change_member($1,$2,null,true)', [
        f.org,
        f.ids.member.user,
      ]);
      const waiting = read.client
        .query('select public.crm_get($1,$2,$3)', [f.org, 'lead', f.lead])
        .then(
          () => null,
          (error) => error,
        );
      await waitForLock(read.pid);
      await revoke.close(true);
      assert.equal((await waiting).message, 'not_found');
    } finally {
      await revoke.close();
      await read.close();
    }
  }));

test('active CRM mutation commits before a waiting membership revocation', () =>
  setup(async (f) => {
    const edit = await actor(f.ids.member),
      revoke = await actor(f.ids.owner);
    try {
      await edit.client.query('select public.crm_change_lead($1,$2,1,$3,$4)', [
        f.org,
        f.lead,
        'assign',
        { userId: f.ids.member.user },
      ]);
      const waiting = revoke.client.query('select public.change_member($1,$2,null,true)', [
        f.org,
        f.ids.member.user,
      ]);
      await waitForLock(revoke.pid);
      await edit.close(true);
      await waiting;
      await revoke.close(true);
      await assert.rejects(rpc(f.ids.member, 'crm_get', [f.org, 'lead', f.lead]), {
        message: 'not_found',
      });
      assert.equal(
        (await rpc(f.ids.owner, 'crm_get', [f.org, 'lead', f.lead])).current_assignee_id,
        null,
      );
    } finally {
      await edit.close();
      await revoke.close();
    }
  }));

test('competing contact edit and archive serialize under the same version', () =>
  setup(async (f) => {
    const results = await Promise.allSettled([
      rpc(f.ids.owner, 'crm_save_contact', [f.org, 'update', contactData(), f.contact.id, 1]),
      rpc(f.ids.admin, 'crm_save_contact', [f.org, 'archive', {}, f.contact.id, 1]),
    ]);
    // An open lead blocks archiving regardless of who acquires the contact lock.
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.ok(['version_conflict', 'contact_has_open_leads'].includes(results[1].reason.message));
  }));

test('queued administrative CRM action loses authority after membership demotion', () =>
  setup(async (f) => {
    const demote = await actor(f.ids.owner),
      archive = await actor(f.ids.admin);
    try {
      await demote.client.query('select public.change_member($1,$2,$3)', [
        f.org,
        f.ids.admin.user,
        'member',
      ]);
      const waiting = archive.client
        .query('select public.crm_change_lead($1,$2,1,$3,$4)', [f.org, f.lead, 'archive', {}])
        .then(
          () => null,
          (error) => error,
        );
      await waitForLock(archive.pid);
      await demote.close(true);
      assert.equal((await waiting).message, 'forbidden');
    } finally {
      await demote.close();
      await archive.close();
    }
  }));

test('competing contact creations cannot both skip duplicate review', () =>
  setup(async (f) => {
    const data = contactData({ displayName: 'Racing synthetic contact' });
    const results = await Promise.allSettled([
      rpc(f.ids.owner, 'crm_save_contact', [f.org, 'create', data, null, null, randomUUID()]),
      rpc(f.ids.admin, 'crm_save_contact', [f.org, 'create', data, null, null, randomUUID()]),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      results.find((r) => r.status === 'rejected').reason.message,
      'duplicate_review_required',
    );
  }));

test('candidate bounds and constraint failures never expose contact data in error details', () =>
  setup(async (f) => {
    for (const data of [
      contactData({ displayName: 'x'.repeat(161) }),
      contactData({
        emails: [{ value: 'private@example.test', normalized: 'forged@example.test' }],
      }),
    ]) {
      await assert.rejects(
        rpc(f.ids.owner, 'crm_candidates', [f.org, data]),
        (error) =>
          error.code === '22023' &&
          !error.detail &&
          !error.message.includes('private@example.test'),
      );
    }
    await assert.rejects(
      change(f, f.ids.owner, 1, 'update', {
        title: 'Private failing row',
        description: 'Sensitive synthetic description',
        priority: 'invalid',
      }),
      (error) => error.code === '23514' && error.message === 'invalid_fields' && !error.detail,
    );
  }));
test('the source catalog bound is enforced independently of API validation', () =>
  setup(async (f) => {
    await pool.query(
      "insert into public.lead_sources(organization_id,name,created_by) select $1,'Synthetic source '||n,$2 from generate_series(1,100) n",
      [f.org, f.ids.owner.user],
    );
    await assert.rejects(
      rpc(f.ids.owner, 'crm_sources', [f.org, null, null, { name: 'Overflow', archived: false }]),
      { message: 'source_limit' },
    );
  }));
