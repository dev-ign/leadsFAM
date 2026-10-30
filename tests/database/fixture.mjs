import { randomUUID, createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { createSessionPool } from '../../packages/database/dist/index.js';
import { localStack } from '../../scripts/local-stack.mjs';

export const stack = localStack();
export const pool = createSessionPool(stack.databaseUrl);
export const hash = (text) => createHash('sha256').update(text).digest('hex');
export async function fixture() {
  const ids = Object.fromEntries(
    ['owner', 'other', 'member', 'admin', 'guest'].map((name) => [
      name,
      { user: randomUUID(), session: randomUUID(), email: `${name}-${randomUUID()}@example.test` },
    ]),
  );
  const org = randomUUID();
  const otherOrg = randomUUID();
  const connection = await pool.connect();
  try {
    await connection.query('begin');
    for (const person of Object.values(ids)) {
      await connection.query(
        "insert into auth.users(id,email,email_confirmed_at,aud,role) values($1,$2,now(),'authenticated','authenticated')",
        [person.user, person.email],
      );
      await connection.query(
        "insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal1')",
        [person.session, person.user],
      );
      await connection.query(
        "insert into private.app_sessions(id_hash,user_id,provider_session_id,purpose,token_envelope,csrf_hash,idle_expires_at,expires_at) values($1,$2,$3,'application','{}','fixture',now()+interval '30 minutes',now()+interval '12 hours')",
        [hash(person.session), person.user, person.session],
      );
    }
    await connection.query(
      "insert into public.organizations(id,name) values($1,'Race fixture A'),($2,'Race fixture B')",
      [org, otherOrg],
    );
    for (const [name, role] of [
      ['owner', 'owner'],
      ['member', 'member'],
      ['admin', 'admin'],
    ])
      await connection.query(
        'insert into public.organization_memberships(organization_id,user_id,role) values($1,$2,$3)',
        [org, ids[name].user, role],
      );
    await connection.query(
      "insert into public.organization_memberships(organization_id,user_id,role) values($1,$2,'owner')",
      [otherOrg, ids.other.user],
    );
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
  }
  return {
    ids,
    org,
    otherOrg,
    async cleanup() {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          'delete from public.organization_notes where organization_id=any($1::uuid[])',
          [[org, otherOrg]],
        );
        await client.query(
          'delete from public.organization_invitations where organization_id=any($1::uuid[])',
          [[org, otherOrg]],
        );
        await client.query(
          'delete from public.organization_memberships where organization_id=any($1::uuid[])',
          [[org, otherOrg]],
        );
        await client.query('delete from public.organizations where id=any($1::uuid[])', [
          [org, otherOrg],
        ]);
        await client.query('delete from auth.users where id=any($1::uuid[])', [
          Object.values(ids).map((p) => p.user),
        ]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export async function actor(person) {
  const client = await pool.connect();
  await client.query('begin');
  await client.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: person.user, session_id: person.session, role: 'authenticated' }),
  ]);
  await client.query('set local role authenticated');
  const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
  let closed = false;
  return {
    client,
    pid,
    async close(commit = false) {
      if (closed) return;
      closed = true;
      try {
        await client.query(commit ? 'commit' : 'rollback');
      } finally {
        client.release();
      }
    },
  };
}
export async function waitForLock(pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query('select cardinality(pg_blocking_pids($1)) > 0 blocked', [pid]);
    if (result.rows[0].blocked) return;
    await setTimeout(25);
  }
  throw new Error('Expected database lock barrier was not observed.');
}
export async function rpc(person, name, parameters) {
  const session = await actor(person);
  try {
    const result = await session.client.query(
      `select public.${name}(${parameters.map((_, i) => `$${i + 1}`).join(',')}) result`,
      parameters,
    );
    await session.close(true);
    return result.rows[0].result;
  } catch (error) {
    await session.close();
    throw error;
  }
}
