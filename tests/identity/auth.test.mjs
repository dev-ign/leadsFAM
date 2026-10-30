import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { createApp } from '../../apps/api/dist/app/create-app.js';
import { parseEnv } from '../../apps/api/dist/config/env.js';
import { SessionStore } from '../../apps/api/dist/modules/identity/sessions.js';
import { localIdentity } from '../../scripts/local-identity.mjs';
import { localStack } from '../../scripts/local-stack.mjs';
import { createSessionPool } from '../../packages/database/dist/index.js';
const identity = await localIdentity(),
  stack = localStack();
const admin = createSessionPool(stack.databaseUrl);
const app = createApp({ ...parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }), identity });
const store = new SessionStore(identity);
const emails = [];
after(async () => {
  await app.close();
  await store.stop();
  // Tests use only synthetic identities. Account cleanup must respect owner constraints.
  const syntheticOrgs = (
    await admin.query(
      'select distinct organization_id from public.organization_memberships where user_id in (select id from auth.users where email=any($1::text[]))',
      [emails],
    )
  ).rows.map((row) => row.organization_id);
  const cleanup = await admin.connect();
  try {
    await cleanup.query('begin');
    for (const table of [
      'organization_notes',
      'organization_invitations',
      'organization_memberships',
    ])
      await cleanup.query(`delete from public.${table} where organization_id=any($1::uuid[])`, [
        syntheticOrgs,
      ]);
    await cleanup.query('delete from public.organizations where id=any($1::uuid[])', [
      syntheticOrgs,
    ]);
    await cleanup.query('commit');
    await cleanup.query('delete from auth.users where email=any($1::text[])', [emails]);
  } catch (error) {
    await cleanup.query('rollback');
    throw error;
  } finally {
    cleanup.release();
  }
  await admin.end();
});
let browserCount = 1;
const origin = 'http://127.0.0.1:5173';
function browser() {
  const remoteAddress = `127.0.0.${browserCount++}`;
  let cookie = '',
    csrf = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path, body, extra = {}) {
      const response = await app.inject({
        remoteAddress,
        method: body === undefined ? 'GET' : 'POST',
        url: `/v1${path}`,
        headers: { origin, cookie, 'x-csrf-token': csrf, ...extra },
        ...(body === undefined ? {} : { payload: body }),
      });
      const changed = response.headers['set-cookie'];
      if (changed) cookie = (Array.isArray(changed) ? changed[0] : changed).split(';')[0];
      return response;
    },
    async session() {
      const r = await this.request('/auth/session');
      assert.equal(r.statusCode, 200);
      const data = r.json();
      csrf = data.csrfToken;
      return data;
    },
  };
}
async function otp(email) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(
      `http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    const result = await response.json();
    const message = result.messages?.[0];
    if (message) {
      const detail = await (
        await fetch(`http://127.0.0.1:54324/api/v1/message/${message.ID}`)
      ).json();
      const code = (detail.Text ?? detail.HTML ?? '').match(/\b\d{6}\b/);
      if (code) return code[0];
    }
    await setTimeout(50);
  }
  throw new Error('Local Mailpit code was not delivered');
}
async function account() {
  const email = `security-${randomUUID()}@example.test`,
    password = `test-${randomUUID()}-A9!`;
  emails.push(email);
  const client = browser();
  await client.session();
  assert.equal(
    (await client.request('/auth/sign-up', { email, password, displayName: 'Synthetic tester' }))
      .statusCode,
    200,
  );
  const code = await otp(email);
  assert.equal(
    (await client.request('/auth/verify-email', { email, token: code })).statusCode,
    200,
  );
  assert.equal((await client.request('/auth/sign-in', { email, password })).statusCode, 200);
  const session = await client.session();
  assert.equal(session.purpose, 'application');
  assert.equal(session.user.email, email);
  return { client, email, password, session };
}
test('real Auth signup, OTP verification, opaque login, CSRF, logout and expiry boundaries', async (t) => {
  const client = browser();
  const initial = await client.session();
  assert.equal(initial.purpose, 'anonymous');
  assert.equal(initial.user, null);
  const accountA = await account();
  await t.test('cookie rotation and flags; raw provider tokens never returned', async () => {
    assert.notEqual(client.cookie, accountA.client.cookie);
    const response = await app.inject('/v1/auth/session');
    assert.match(response.headers['set-cookie'], /HttpOnly; SameSite=Lax/);
    assert.doesNotMatch(
      JSON.stringify(accountA.session),
      /access_token|refresh_token|accessToken|refreshToken/,
    );
    assert.equal(
      (await accountA.client.request('/auth/sign-out', {}, { 'x-csrf-token': 'forged' }))
        .statusCode,
      403,
    );
    assert.equal(
      (await accountA.client.request('/auth/sign-out', {}, { origin: 'https://attacker.example' }))
        .statusCode,
      403,
    );
  });
  await t.test('malformed and incorrect credentials return safe errors', async () => {
    const response = await client.request('/auth/sign-in', {
      email: accountA.email,
      password: 'bad',
    });
    assert.equal(response.statusCode, 400);
    assert.doesNotMatch(response.body, /stack|postgres|password/);
    assert.equal(
      (
        await client.request('/auth/sign-in', {
          email: accountA.email,
          password: `wrong-${randomUUID()}`,
        })
      ).statusCode,
      401,
    );
  });
  await t.test('expired and forged opaque sessions are rejected', async () => {
    const actual = await store.load(accountA.client.cookie.split('=')[1]);
    assert.ok(actual);
    await admin.query(
      "update private.app_sessions set idle_expires_at=clock_timestamp()-interval '1 second' where id_hash=$1",
      [actual.hash],
    );
    assert.equal((await accountA.client.session()).purpose, 'anonymous');
    assert.equal(await store.load('f'.repeat(43)), null);
  });
  await t.test('signout revokes the local enrollment even on replay', async () => {
    const b = await account();
    const stolen = b.client.cookie.split('=')[1];
    assert.equal((await b.client.request('/auth/sign-out', {})).statusCode, 200);
    assert.equal(await store.load(stolen), null);
    assert.equal((await b.client.session()).purpose, 'anonymous');
  });
});
test('real recovery JWT cannot reach organizations before or after reset; fresh password login is required', async () => {
  const a = await account(),
    recovery = browser();
  await recovery.session();
  assert.equal(
    (await recovery.request('/auth/forgot-password', { email: a.email })).statusCode,
    200,
  );
  // Search returns latest messages first; confirmation and recovery codes differ.
  const code = await otp(a.email);
  assert.equal(
    (await recovery.request('/auth/recovery', { email: a.email, token: code })).statusCode,
    200,
  );
  assert.equal((await recovery.session()).purpose, 'recovery');
  const recovered = await store.load(recovery.cookie.split('=')[1]);
  assert.equal(recovered.purpose, 'recovery');
  const rpc = await fetch(`${identity.url}/rest/v1/rpc/list_organizations`, {
    method: 'POST',
    headers: {
      apikey: identity.publicKey,
      authorization: `Bearer ${recovered.tokens.accessToken}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(rpc.status, 403);
  const read = await fetch(`${identity.url}/rest/v1/organizations?select=id`, {
    headers: {
      apikey: identity.publicKey,
      authorization: `Bearer ${recovered.tokens.accessToken}`,
    },
  });
  assert.deepEqual(await read.json(), []);
  const oldCookie = a.client.cookie.split('=')[1];
  const password = `new-${randomUUID()}-A9!`;
  assert.equal((await recovery.request('/auth/reset-password', { password })).statusCode, 200);
  assert.equal(await store.load(oldCookie), null);
  const afterReset = await fetch(`${identity.url}/rest/v1/rpc/list_organizations`, {
    method: 'POST',
    headers: {
      apikey: identity.publicKey,
      authorization: `Bearer ${recovered.tokens.accessToken}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.ok([401, 403].includes(afterReset.status));
  assert.equal((await recovery.session()).purpose, 'anonymous');
  assert.equal((await a.client.session()).purpose, 'anonymous');
  assert.equal(
    (await a.client.request('/auth/sign-in', { email: a.email, password: a.password })).statusCode,
    401,
  );
  assert.equal(
    (await a.client.request('/auth/sign-in', { email: a.email, password })).statusCode,
    200,
  );
  assert.equal((await a.client.session()).purpose, 'application');
});
test('row-locked refresh rotates once across concurrent requests, and encryption keys rotate lazily', async () => {
  const a = await account(),
    raw = a.client.cookie.split('=')[1];
  const { AuthProvider } = await import('../../apps/api/dist/modules/identity/provider.js');
  let refreshes = 0;
  const provider = new AuthProvider(identity.url, identity.publicKey, async (...args) => {
    if (String(args[0]).includes('grant_type=refresh_token')) refreshes++;
    return fetch(...args);
  });
  const locked = new SessionStore(identity, provider);
  try {
    const old = await locked.load(raw);
    const record = (
      await admin.query('select * from private.app_sessions where id_hash=$1', [old.hash])
    ).rows[0];
    const payload = locked.open(record);
    payload.tokens.expiresAt = 0;
    await admin.query('update private.app_sessions set token_envelope=$2 where id_hash=$1', [
      old.hash,
      JSON.stringify(locked.seal(record, payload)),
    ]);
    const results = await Promise.all(Array.from({ length: 5 }, () => locked.load(raw)));
    assert.equal(refreshes, 1);
    assert.ok(results.every((s) => s.tokens.sessionId === old.tokens.sessionId));
    const { randomBytes } = await import('node:crypto');
    const rotated = new SessionStore({
      ...identity,
      activeKey: 'local-v2',
      keys: { ...identity.keys, 'local-v2': randomBytes(32).toString('base64') },
    });
    try {
      assert.ok(await rotated.load(raw));
      const updated = (
        await admin.query('select token_envelope from private.app_sessions where id_hash=$1', [
          old.hash,
        ])
      ).rows[0];
      assert.equal(updated.token_envelope.kid, 'local-v2');
      assert.equal(await locked.load(raw), null); // Old-only worker fails closed; rolling rotation retains both keys.
    } finally {
      await rotated.stop();
    }
  } finally {
    await locked.stop();
  }
});
test('provider outage, ciphertext tampering and bounded cleanup fail safely', async () => {
  const a = await account(),
    raw = a.client.cookie.split('=')[1],
    original = await store.load(raw);
  const { IdentityFailure } = await import('../../apps/api/dist/modules/identity/failure.js');
  const failing = new SessionStore(identity, {
    user: async () => {
      throw new IdentityFailure(503, 'IDENTITY_UNAVAILABLE');
    },
  });
  try {
    await assert.rejects(failing.load(raw), (e) => e.statusCode === 503);
  } finally {
    await failing.stop();
  }
  assert.ok(await store.load(raw));
  await admin.query(
    "update private.app_sessions set token_envelope=jsonb_set(token_envelope,'{data}','\"tampered\"') where id_hash=$1",
    [original.hash],
  );
  assert.equal(await store.load(raw), null);
  await store.cleanup();
  assert.equal(
    (
      await admin.query('select count(*)::int count from private.app_sessions where id_hash=$1', [
        original.hash,
      ])
    ).rows[0].count,
    0,
  );
});
test('password update failure leaves sessions revoked and enrollment fenced until recovery retry succeeds', async () => {
  const a = await account(),
    raw = a.client.cookie.split('=')[1],
    before = await store.load(raw),
    started = await store.clock();
  const b = browser();
  await b.session();
  await b.request('/auth/forgot-password', { email: a.email });
  assert.equal(
    (await b.request('/auth/recovery', { email: a.email, token: await otp(a.email) })).statusCode,
    200,
  );
  await b.session();
  const recovery = await store.load(b.cookie.split('=')[1]);
  const { IdentityFailure } = await import('../../apps/api/dist/modules/identity/failure.js');
  const failing = new SessionStore(identity, {
    request: async () => {
      throw new IdentityFailure(503, 'IDENTITY_UNAVAILABLE');
    },
  });
  try {
    await assert.rejects(
      failing.recover(recovery, `new-${randomUUID()}`),
      (e) => e.statusCode === 503,
    );
  } finally {
    await failing.stop();
  }
  assert.equal(await store.load(raw), null);
  await assert.rejects(
    store.create('application', before.tokens, undefined, await store.clock()),
    (e) => e.code === 'SIGN_IN_AGAIN',
  );
  const password = `changed-${randomUUID()}!9`;
  assert.equal((await b.request('/auth/reset-password', { password })).statusCode, 200);
  await assert.rejects(
    store.create('application', before.tokens, undefined, started),
    (e) => e.code === 'SIGN_IN_AGAIN',
  );
  await a.client.session();
  assert.equal(
    (await a.client.request('/auth/sign-in', { email: a.email, password })).statusCode,
    200,
  );
});
test('real authenticated HTTP requests enforce current tenant membership and role permissions', async (t) => {
  const owner = await account(),
    other = await account(),
    member = await account();
  const organizations = [];
  for (const [client, name] of [
    [owner.client, 'Synthetic workspace A'],
    [other.client, 'Synthetic workspace B'],
    [owner.client, 'Synthetic shared workspace'],
  ]) {
    const r = await client.request('/organizations', { name });
    assert.equal(r.statusCode, 200);
    organizations.push(r.json());
  }
  const [a, b, c] = organizations;
  await t.test('atomic initial ownership and multi-organization list', async () => {
    const members = await owner.client.request(`/organizations/${a.id}/members`);
    assert.equal(members.statusCode, 200);
    assert.deepEqual(
      members.json().map((m) => m.role),
      ['owner'],
    );
    assert.equal((await owner.client.request('/organizations')).json().length, 2);
    assert.equal((await owner.client.request(`/organizations/${b.id}/notes`)).statusCode, 404);
    assert.equal((await app.inject(`/v1/organizations/${a.id}/notes`)).statusCode, 401);
  });
  const note = (
    await owner.client.request(`/organizations/${a.id}/notes`, {
      title: 'Synthetic isolation record',
      body: 'Only workspace A',
    })
  ).json();
  await t.test('cross-tenant reads, writes and guessed resource IDs fail', async () => {
    assert.equal((await other.client.request(`/organizations/${a.id}/notes`)).statusCode, 404);
    const raw = await store.load(other.client.cookie.split('=')[1]);
    const response = await fetch(`${identity.url}/rest/v1/organization_notes?id=eq.${note.id}`, {
      headers: { apikey: identity.publicKey, authorization: `Bearer ${raw.tokens.accessToken}` },
    });
    assert.deepEqual(await response.json(), []);
    const mutation = await app.inject({
      method: 'PATCH',
      url: `/v1/organizations/${b.id}/notes/${note.id}`,
      headers: {
        origin,
        cookie: other.client.cookie,
        'x-csrf-token': (await other.client.session()).csrfToken,
      },
      payload: { title: 'Stolen', body: '' },
    });
    assert.equal(mutation.statusCode, 404);
    assert.equal(
      (
        await owner.client.request(`/organizations/${a.id}/notes`, {
          title: 'Bad move',
          body: '',
          organizationId: b.id,
        })
      ).statusCode,
      400,
    );
  });
  const invite = (
    await owner.client.request(`/organizations/${a.id}/invitations`, {
      email: member.email,
      role: 'member',
    })
  ).json();
  await t.test(
    'invitation requires the matching verified email and accepts only once',
    async () => {
      assert.equal(
        (await other.client.request('/invitations/accept', { token: invite.token })).statusCode,
        404,
      );
      assert.equal(
        (await member.client.request('/invitations/accept', { token: invite.token })).statusCode,
        200,
      );
      assert.equal(
        (await member.client.request('/invitations/accept', { token: invite.token })).statusCode,
        404,
      );
      assert.equal((await member.client.request(`/organizations/${a.id}/notes`)).json().length, 1);
    },
  );
  await t.test('member cannot promote itself, administer invitations or remove owner', async () => {
    const csrf = (await member.client.session()).csrfToken,
      headers = { origin, cookie: member.client.cookie, 'x-csrf-token': csrf };
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/organizations/${a.id}/members/${member.session.user.id}`,
          headers,
          payload: { role: 'admin' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await member.client.request(`/organizations/${a.id}/invitations`, {
          email: other.email,
          role: 'admin',
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/organizations/${a.id}/members/${owner.session.user.id}`,
          headers,
        })
      ).statusCode,
      409,
    );
  });
  await t.test(
    'revocation denies the same active session without affecting a different organization',
    async () => {
      const headers = {
        origin,
        cookie: owner.client.cookie,
        'x-csrf-token': (await owner.client.session()).csrfToken,
      };
      assert.equal(
        (
          await app.inject({
            method: 'DELETE',
            url: `/v1/organizations/${a.id}/members/${member.session.user.id}`,
            headers,
          })
        ).statusCode,
        200,
      );
      assert.equal((await member.client.request(`/organizations/${a.id}/notes`)).statusCode, 404);
      assert.equal((await owner.client.request(`/organizations/${c.id}/notes`)).statusCode, 200);
      assert.equal(
        (await owner.client.request(`/organizations/${a.id}/notes`)).json()[0].body,
        'Only workspace A',
      );
    },
  );
});
test('authentication rate limiting rejects repeated attempts', async () => {
  const b = browser();
  await b.session();
  let last;
  for (let i = 0; i < 21; i++)
    last = await b.request('/auth/sign-in', {
      email: 'invalid@example.test',
      password: `bad-${randomUUID()}`,
    });
  assert.equal(last.statusCode, 429);
  assert.equal(last.json().error.code, 'RATE_LIMITED');
});

test('the API refuses a migration-administrator session-store connection', async () => {
  const unsafe = new SessionStore({ ...identity, databaseUrl: stack.databaseUrl });
  try {
    await assert.rejects(unsafe.start(), /Unsafe identity runtime database role/);
  } finally {
    await unsafe.stop();
  }
});

test('invalid provider credentials and provider-side revocation cannot preserve an application session', async () => {
  const a = await account(),
    raw = a.client.cookie.split('=')[1],
    current = await store.load(raw);
  const row = (
    await admin.query('select * from private.app_sessions where id_hash=$1', [current.hash])
  ).rows[0];
  const payload = store.open(row);
  payload.tokens.accessToken = 'invalid-provider-credential';
  await admin.query('update private.app_sessions set token_envelope=$2 where id_hash=$1', [
    current.hash,
    JSON.stringify(store.seal(row, payload)),
  ]);
  assert.equal(await store.load(raw), null);
  const b = await account(),
    other = b.client.cookie.split('=')[1],
    session = await store.load(other);
  await store.provider.request('/logout?scope=local', undefined, session.tokens.accessToken);
  assert.equal(await store.load(other), null);
});

test('refresh succeeded but persistence failed: no partial credentials are returned and retry stays identity-bound', async () => {
  const a = await account(),
    raw = a.client.cookie.split('=')[1],
    current = await store.load(raw);
  const row = (
    await admin.query('select * from private.app_sessions where id_hash=$1', [current.hash])
  ).rows[0];
  const payload = store.open(row);
  payload.tokens.expiresAt = 0;
  const envelope = store.seal(row, payload);
  await admin.query('update private.app_sessions set token_envelope=$2 where id_hash=$1', [
    current.hash,
    JSON.stringify(envelope),
  ]);
  assert.match(current.hash, /^[a-f0-9]{64}$/);
  await admin.query(
    "create function private.fixture_refresh_failure() returns trigger language plpgsql set search_path='' as $$ begin if new.id_hash=tg_argv[0] then raise exception using errcode='40001',message='synthetic_persistence_failure'; end if;return new;end $$",
  );
  try {
    await admin.query(
      `create trigger fixture_refresh_failure before update on private.app_sessions for each row execute function private.fixture_refresh_failure('${current.hash}')`,
    );
    const response = await a.client.request('/auth/session');
    assert.equal(response.statusCode, 500);
    assert.doesNotMatch(
      response.body,
      /synthetic_persistence_failure|accessToken|refreshToken|postgres|stack/,
    );
    const saved = (
      await admin.query('select token_envelope from private.app_sessions where id_hash=$1', [
        current.hash,
      ])
    ).rows[0];
    assert.ok(saved.token_envelope.data === envelope.data); // Rollback kept the complete previous envelope.
  } finally {
    await admin.query('drop trigger if exists fixture_refresh_failure on private.app_sessions');
    await admin.query('drop function private.fixture_refresh_failure()');
  }
  const retried = await store.load(raw);
  assert.ok(retried === null || retried.tokens.userId === current.tokens.userId);
});

test('production cookie and credentialed CORS attributes are explicit and host-only', async () => {
  const production = createApp({
    ...parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    nodeEnv: 'production',
    corsOrigins: ['https://app.example'],
    identity,
  });
  try {
    const response = await production.inject({
      url: '/v1/auth/session',
      headers: { origin: 'https://app.example' },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['set-cookie'], /^__Host-leadsfam=/);
    assert.match(response.headers['set-cookie'], /HttpOnly; SameSite=Lax; Max-Age=900; Secure$/);
    assert.doesNotMatch(response.headers['set-cookie'], /Domain=/i);
    assert.equal(response.headers['access-control-allow-origin'], 'https://app.example');
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    const health = await production.inject({
      url: '/health',
      headers: { origin: 'https://app.example' },
    });
    assert.equal(health.headers['access-control-allow-credentials'], undefined);
  } finally {
    await production.close();
  }
});
