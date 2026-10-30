import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from './fixture.mjs';
const h = await harness();
after(h.cleanup);
test('dependency readiness is bounded and fails safely when Auth is unavailable', async (t) => {
  const ready = await h.app.inject('/ready');
  assert.equal(ready.statusCode, 200, ready.body);
  assert.deepEqual(ready.json(), { status: 'ready' });
  const original = globalThis.fetch,
    mocked = t.mock.method(globalThis, 'fetch', async (...args) =>
      String(args[0]).endsWith('/auth/v1/health')
        ? new Response('', { status: 503 })
        : original(...args),
    );
  try {
    const failed = await h.app.inject('/ready');
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { status: 'unavailable' });
  } finally {
    mocked.mock.restore();
  }
});

test('real authenticated CRM HTTP contracts, normalization, replay, version and tenant boundaries', async (t) => {
  const person = await h.account(),
    org = await h.organization(person),
    base = `/organizations/${org}`;
  const input = {
    kind: 'person',
    displayName: 'Synthetic prospect',
    emails: ['CRM.Example+Tag@example.test'],
    phones: [{ value: '(202) 555-0123', region: 'US' }],
  };
  const key = randomUUID(),
    headers = { 'idempotency-key': key };
  let contact;
  await t.test('ordinary cookie and CSRF are required', async () => {
    assert.equal((await h.browser().request(`${base}/contacts/${randomUUID()}`)).statusCode, 401);
    assert.equal(
      (
        await person.client.request(`${base}/contacts`, {
          method: 'POST',
          body: input,
          headers: { ...headers, 'x-csrf-token': 'forged' },
        })
      ).statusCode,
      403,
    );
  });
  await t.test('keys, strict fields and normalization are enforced', async () => {
    assert.equal(
      (await person.client.request(`${base}/contacts`, { method: 'POST', body: input })).statusCode,
      400,
    );
    assert.equal(
      (
        await person.client.request(`${base}/contacts`, {
          method: 'POST',
          body: { ...input, created_by: person.user },
          headers,
        })
      ).statusCode,
      400,
    );
    const response = await person.client.request(`${base}/contacts`, {
      method: 'POST',
      body: input,
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    contact = response.json();
    assert.equal(contact.emails[0].normalized, 'crm.example+tag@example.test');
    assert.equal(contact.phones[0].normalized, '+12025550123');
    assert.equal(contact.created_by, person.user);
  });
  await t.test('replay preserves IDs and changed payload conflicts safely', async () => {
    assert.equal(
      (
        await person.client.request(`${base}/contacts`, { method: 'POST', body: input, headers })
      ).json().id,
      contact.id,
    );
    const changed = await person.client.request(`${base}/contacts`, {
      method: 'POST',
      body: { ...input, displayName: 'Changed' },
      headers,
    });
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json().error.code, 'IDEMPOTENCY_CONFLICT');
    assert.doesNotMatch(changed.body, /CRM.Example|example.test|SELECT|constraint/);
  });
  await t.test(
    'candidate review never automatically links and failed CAS preserves the winner',
    async () => {
      assert.equal(
        (
          await person.client.request(`${base}/contacts/candidates`, {
            method: 'POST',
            body: input,
          })
        ).json()[0].id,
        contact.id,
      );
      assert.equal(
        (
          await person.client.request(`${base}/contacts`, {
            method: 'POST',
            body: input,
            headers: { 'idempotency-key': randomUUID() },
          })
        ).statusCode,
        409,
      );
      const body = { version: 1, contact: { ...input, displayName: 'Current synthetic prospect' } };
      assert.equal(
        (await person.client.request(`${base}/contacts/${contact.id}`, { method: 'PATCH', body }))
          .statusCode,
        200,
      );
      const conflict = await person.client.request(`${base}/contacts/${contact.id}`, {
        method: 'PATCH',
        body,
      });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.json().error.code, 'VERSION_CONFLICT');
    },
  );
  await t.test(
    'foreign IDs remain unavailable even to a user with another organization',
    async () => {
      const other = await h.organization(person);
      assert.equal(
        (await person.client.request(`/organizations/${other}/contacts/${contact.id}`)).statusCode,
        404,
      );
    },
  );
  await t.test(
    'members cannot administer sources and revocation blocks the same cookie',
    async () => {
      const member = await h.account();
      await h.admin.query(
        "insert into public.organization_memberships(organization_id,user_id,role) values($1,$2,'member')",
        [org, member.user],
      );
      assert.equal(
        (
          await member.client.request(`${base}/lead-sources`, {
            method: 'POST',
            body: { name: 'Forbidden' },
          })
        ).statusCode,
        403,
      );
      assert.equal((await member.client.request(`${base}/contacts/${contact.id}`)).statusCode, 200);
      await h.admin.query(
        'update public.organization_memberships set revoked_at=now() where organization_id=$1 and user_id=$2',
        [org, member.user],
      );
      assert.equal((await member.client.request(`${base}/contacts/${contact.id}`)).statusCode, 404);
    },
  );
});
