import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { createApp } from '../../apps/api/dist/app/create-app.js';
import { parseEnv } from '../../apps/api/dist/config/env.js';
import { localIdentity } from '../../scripts/local-identity.mjs';
import { localStack } from '../../scripts/local-stack.mjs';
import { createSessionPool } from '../../packages/database/dist/index.js';

export async function harness() {
  const identity = await localIdentity(),
    stack = localStack();
  const admin = createSessionPool(stack.databaseUrl),
    users = [],
    orgs = [];
  const app = createApp({
    ...parseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    identity,
    crmCursorKey: identity.cursorKey,
  });
  let count = 30;
  function browser() {
    let cookie = '',
      csrf = '';
    const remoteAddress = `127.0.1.${count++}`;
    return {
      get credentials() {
        return { origin: 'http://127.0.0.1:5173', cookie, 'x-csrf-token': csrf };
      },
      async request(path, { method = 'GET', body, headers = {} } = {}) {
        const r = await app.inject({
          remoteAddress,
          method,
          url: `/v1${path}`,
          headers: { origin: 'http://127.0.0.1:5173', cookie, 'x-csrf-token': csrf, ...headers },
          ...(body === undefined ? {} : { payload: body }),
        });
        const changed = r.headers['set-cookie'];
        if (changed) cookie = (Array.isArray(changed) ? changed[0] : changed).split(';')[0];
        return r;
      },
      async session() {
        const r = await this.request('/auth/session');
        assert.equal(r.statusCode, 200);
        csrf = r.json().csrfToken;
        return r.json();
      },
    };
  }
  async function account() {
    const client = browser(),
      email = `crm-${randomUUID()}@example.test`,
      password = `Synthetic-${randomUUID()}-A9!`;
    await client.session();
    assert.equal(
      (
        await client.request('/auth/sign-up', {
          method: 'POST',
          body: { email, password, displayName: 'Synthetic CRM tester' },
        })
      ).statusCode,
      200,
    );
    let code;
    for (let i = 0; i < 100 && !code; i++) {
      const result = await (
        await fetch(
          `http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
        )
      ).json();
      if (result.messages?.[0]) {
        const message = await (
          await fetch(`http://127.0.0.1:54324/api/v1/message/${result.messages[0].ID}`)
        ).json();
        code = (message.Text ?? message.HTML ?? '').match(/\b\d{6}\b/)?.[0];
      }
      if (!code) await setTimeout(50);
    }
    assert.ok(code, 'Local verification email delivered');
    assert.equal(
      (await client.request('/auth/verify-email', { method: 'POST', body: { email, token: code } }))
        .statusCode,
      200,
    );
    assert.equal(
      (await client.request('/auth/sign-in', { method: 'POST', body: { email, password } }))
        .statusCode,
      200,
    );
    const session = await client.session();
    users.push(session.user.id);
    return { client, user: session.user.id, email, password };
  }
  async function organization(person) {
    const r = await person.client.request('/organizations', {
      method: 'POST',
      body: { name: 'Synthetic CRM organization' },
    });
    assert.equal(r.statusCode, 200);
    const org = r.json();
    orgs.push(org.id);
    return org.id;
  }
  async function cleanup() {
    await app.close();
    const connection = await admin.connect();
    try {
      await connection.query('begin');
      await connection.query("set local session_replication_role='replica'");
      for (const [schema, table] of [
        ['private', 'lead_import_rows'],
        ['private', 'lead_import_attempts'],
        ['private', 'lead_import_jobs'],
        ['private', 'crm_request_receipts'],
        ['public', 'crm_activities'],
        ['public', 'lead_attributions'],
        ['public', 'leads'],
        ['public', 'contact_emails'],
        ['public', 'contact_phones'],
        ['public', 'contacts'],
        ['public', 'lead_sources'],
        ['public', 'organization_notes'],
        ['public', 'organization_invitations'],
        ['public', 'organization_memberships'],
      ])
        await connection.query(
          `delete from ${schema}.${table} where organization_id=any($1::uuid[])`,
          [orgs],
        );
      await connection.query('delete from public.organizations where id=any($1::uuid[])', [orgs]);
      await connection.query("set local session_replication_role='origin'");
      await connection.query('delete from auth.users where id=any($1::uuid[])', [users]);
      await connection.query('commit');
    } catch (error) {
      await connection.query('rollback');
      throw error;
    } finally {
      connection.release();
      await admin.end();
    }
  }
  return { app, admin, browser, account, organization, cleanup, identity };
}
