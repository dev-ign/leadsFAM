import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, fixture, hash, pool, rpc, waitForLock } from './fixture.mjs';

after(() => pool.end());
async function withFixture(run) {
  const f = await fixture();
  try {
    await run(f);
  } finally {
    await f.cleanup();
  }
}

test('queued admin mutation rechecks permission after owner demotion', () =>
  withFixture(async (f) => {
    const owner = await actor(f.ids.owner);
    const admin = await actor(f.ids.admin);
    try {
      await owner.client.query('select public.change_member($1,$2,$3)', [
        f.org,
        f.ids.admin.user,
        'member',
      ]);
      const waiting = admin.client
        .query('select public.create_invitation($1,$2,$3,$4)', [
          f.org,
          f.ids.guest.email,
          'member',
          hash(randomUUID()),
        ])
        .then(
          () => null,
          (error) => error,
        );
      await waitForLock(admin.pid);
      await owner.close(true);
      const error = await waiting;
      assert.equal(error?.message, 'forbidden');
    } finally {
      await admin.close();
    }
  }));

test('revocation wins over a queued membership role change', () =>
  withFixture(async (f) => {
    const remove = await actor(f.ids.owner);
    const promote = await actor(f.ids.owner);
    try {
      await remove.client.query('select public.change_member($1,$2,null,true)', [
        f.org,
        f.ids.member.user,
      ]);
      const waiting = promote.client
        .query('select public.change_member($1,$2,$3)', [f.org, f.ids.member.user, 'admin'])
        .then(
          () => null,
          (error) => error,
        );
      await waitForLock(promote.pid);
      await remove.close(true);
      assert.equal((await waiting)?.message, 'not_found');
      const result = await pool.query(
        'select role,revoked_at from public.organization_memberships where organization_id=$1 and user_id=$2',
        [f.org, f.ids.member.user],
      );
      assert.equal(result.rows[0].role, 'member');
      assert.ok(result.rows[0].revoked_at);
    } finally {
      await promote.close();
    }
  }));

test('competing owner removals cannot commit an ownerless organization', () =>
  withFixture(async (f) => {
    await pool.query(
      "insert into public.organization_memberships(organization_id,user_id,role) values($1,$2,'owner')",
      [f.org, f.ids.other.user],
    );
    // Privileged fixture transactions deliberately exercise the constraint trigger
    // independently of API/RPC policy, which rejects owner changes in this phase.
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('begin');
      await second.query('begin');
      await first.query(
        'update public.organization_memberships set revoked_at=now() where organization_id=$1 and user_id=$2',
        [f.org, f.ids.owner.user],
      );
      await second.query(
        'update public.organization_memberships set revoked_at=now() where organization_id=$1 and user_id=$2',
        [f.org, f.ids.other.user],
      );
      const outcomes = await Promise.allSettled([first.query('commit'), second.query('commit')]);
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
      const rejected = outcomes.find((r) => r.status === 'rejected');
      assert.equal(rejected.reason.code, '23514');
      const result = await pool.query(
        "select count(*)::int owners from public.organization_memberships where organization_id=$1 and role='owner' and revoked_at is null",
        [f.org],
      );
      assert.equal(result.rows[0].owners, 1);
    } finally {
      await first.query('rollback');
      await second.query('rollback');
      first.release();
      second.release();
    }
  }));

test('invitation acceptance race grants membership exactly once', () =>
  withFixture(async (f) => {
    const tokenHash = hash(randomUUID());
    await rpc(f.ids.owner, 'create_invitation', [f.org, f.ids.guest.email, 'member', tokenHash]);
    const first = await actor(f.ids.guest);
    const second = await actor(f.ids.guest);
    try {
      await first.client.query('select public.accept_invitation($1)', [tokenHash]);
      const waiting = second.client.query('select public.accept_invitation($1)', [tokenHash]).then(
        () => null,
        (error) => error,
      );
      await waitForLock(second.pid);
      await first.close(true);
      assert.equal((await waiting)?.message, 'invitation_invalid');
      const result = await pool.query(
        'select count(*)::int members from public.organization_memberships where organization_id=$1 and user_id=$2 and revoked_at is null',
        [f.org, f.ids.guest.user],
      );
      assert.equal(result.rows[0].members, 1);
    } finally {
      await second.close();
    }
  }));

test('invitation revocation blocks a waiting acceptance', () =>
  withFixture(async (f) => {
    const tokenHash = hash(randomUUID());
    const invitation = await rpc(f.ids.owner, 'create_invitation', [
      f.org,
      f.ids.guest.email,
      'member',
      tokenHash,
    ]);
    const revoke = await actor(f.ids.owner);
    const accept = await actor(f.ids.guest);
    try {
      await revoke.client.query('select public.revoke_invitation($1,$2)', [f.org, invitation.id]);
      const waiting = accept.client.query('select public.accept_invitation($1)', [tokenHash]).then(
        () => null,
        (error) => error,
      );
      await waitForLock(accept.pid);
      await revoke.close(true);
      assert.equal((await waiting)?.message, 'invitation_invalid');
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from public.organization_memberships where organization_id=$1 and user_id=$2',
            [f.org, f.ids.guest.user],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await accept.close();
    }
  }));

test('an active read finishes before a waiting revocation; subsequent access fails', () =>
  withFixture(async (f) => {
    const read = await actor(f.ids.member);
    const revoke = await actor(f.ids.owner);
    try {
      await read.client.query('select public.list_notes($1)', [f.org]);
      const waiting = revoke.client.query('select public.change_member($1,$2,null,true)', [
        f.org,
        f.ids.member.user,
      ]);
      await waitForLock(revoke.pid);
      await read.close(true);
      await waiting;
      await revoke.close(true);
      await assert.rejects(rpc(f.ids.member, 'list_notes', [f.org]), { message: 'not_found' });
    } catch (error) {
      await revoke.close().catch(() => {});
      throw error;
    }
  }));

test('a read waiting behind revocation rechecks membership before returning records', () =>
  withFixture(async (f) => {
    const revoke = await actor(f.ids.owner);
    const read = await actor(f.ids.member);
    try {
      await revoke.client.query('select public.change_member($1,$2,null,true)', [
        f.org,
        f.ids.member.user,
      ]);
      const waiting = read.client.query('select public.list_notes($1)', [f.org]).then(
        () => null,
        (error) => error,
      );
      await waitForLock(read.pid);
      await revoke.close(true);
      assert.equal((await waiting)?.message, 'not_found');
    } finally {
      await read.close();
    }
  }));

test('acceptance committed before revocation remains a membership and revocation reports not found', () =>
  withFixture(async (f) => {
    const tokenHash = hash(randomUUID());
    const invitation = await rpc(f.ids.owner, 'create_invitation', [
      f.org,
      f.ids.guest.email,
      'member',
      tokenHash,
    ]);
    const accept = await actor(f.ids.guest),
      revoke = await actor(f.ids.owner);
    try {
      await accept.client.query('select public.accept_invitation($1)', [tokenHash]);
      const waiting = revoke.client
        .query('select public.revoke_invitation($1,$2)', [f.org, invitation.id])
        .then(
          () => null,
          (error) => error,
        );
      await waitForLock(revoke.pid);
      await accept.close(true);
      assert.equal((await waiting)?.message, 'not_found');
      await revoke.close();
      assert.equal((await rpc(f.ids.guest, 'get_organization', [f.org])).role, 'member');
    } finally {
      await accept.close();
      await revoke.close();
    }
  }));

test('a racing wrong-email acceptance cannot consume an invitation intended for another user', () =>
  withFixture(async (f) => {
    const tokenHash = hash(randomUUID());
    await rpc(f.ids.owner, 'create_invitation', [f.org, f.ids.guest.email, 'member', tokenHash]);
    const guard = await actor(f.ids.owner),
      wrong = await actor(f.ids.other),
      right = await actor(f.ids.guest);
    try {
      await guard.client.query('select public.get_organization($1)', [f.org]);
      const invalid = wrong.client.query('select public.accept_invitation($1)', [tokenHash]).then(
        () => null,
        (error) => error,
      );
      const valid = right.client.query('select public.accept_invitation($1)', [tokenHash]);
      await waitForLock(wrong.pid);
      await waitForLock(right.pid);
      await guard.close(true);
      // Release both transactions after they finish; the loser may otherwise wait
      // for the aborted transaction's organization lock until rollback.
      const wrongFinished = invalid.then(async (error) => {
        await wrong.close();
        return error;
      });
      const rightFinished = valid.then(async (result) => {
        await right.close(true);
        return result;
      });
      assert.equal((await wrongFinished)?.message, 'invitation_invalid');
      assert.equal((await rightFinished).rows[0].accept_invitation.role, 'member');
    } finally {
      await guard.close();
      await wrong.close();
      await right.close();
    }
  }));
