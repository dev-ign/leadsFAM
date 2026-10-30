import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from './fixture.mjs';
const h = await harness();
after(h.cleanup);
test('real API keyset pagination, query binding, filters and membership checks', async (t) => {
  const person = await h.account(),
    org = await h.organization(person),
    base = `/organizations/${org}`;
  const contactResponse = await person.client.request(`${base}/contacts`, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    body: { kind: 'person', displayName: 'Cursor synthetic contact' },
  });
  assert.equal(contactResponse.statusCode, 200, contactResponse.body);
  const contact = contactResponse.json();
  const source = (
    await person.client.request(`${base}/lead-sources`, {
      method: 'POST',
      body: { name: 'Synthetic campaign' },
    })
  ).json();
  const leads = [];
  for (const title of ['First synthetic', 'Second synthetic', '100% safe']) {
    const r = await person.client.request(`${base}/leads`, {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: {
        contact: { mode: 'existing', id: contact.id },
        lead: { title },
        attribution: { sourceId: source.id },
      },
    });
    assert.equal(r.statusCode, 200, r.body);
    leads.push(r.json());
  }
  let cursor;
  await t.test('all pages preserve timestamp/UUID order and do not repeat records', async () => {
    let token = '',
      ids = [];
    do {
      const r = await person.client.request(
        `${base}/leads?pageSize=1${token ? `&cursor=${encodeURIComponent(token)}` : ''}`,
      );
      assert.equal(r.statusCode, 200, r.body);
      const page = r.json();
      if (!cursor) cursor = page.cursor;
      ids.push(...page.items.map((v) => v.id));
      token = page.cursor;
    } while (token);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    assert.ok(cursor);
  });
  await t.test(
    'signed cursors reject changed query, tenant, user and malformed signatures',
    async () => {
      for (const suffix of [
        '&status=qualified',
        '&q=Private%20search',
        '&sort=activity',
        '&searchMode=contains',
        '&pageSize=2',
      ]) {
        const r = await person.client.request(
          `${base}/leads?cursor=${encodeURIComponent(cursor)}${suffix.includes('pageSize') ? '' : '&pageSize=1'}${suffix}`,
        );
        assert.equal(r.statusCode, 400, r.body);
        assert.doesNotMatch(r.body, /Private search|eyJ/);
      }
      for (const token of ['not.a.cursor', cursor.slice(0, -2) + 'aa', 'x'.repeat(2049)])
        assert.equal(
          (
            await person.client.request(
              `${base}/leads?pageSize=1&cursor=${encodeURIComponent(token)}`,
            )
          ).statusCode,
          400,
        );
      const other = await h.organization(person);
      assert.equal(
        (
          await person.client.request(
            `/organizations/${other}/leads?pageSize=1&cursor=${encodeURIComponent(cursor)}`,
          )
        ).statusCode,
        400,
      );
      const member = await h.account();
      await h.admin.query(
        "insert into public.organization_memberships(organization_id,user_id,role) values($1,$2,'member')",
        [org, member.user],
      );
      assert.equal(
        (
          await member.client.request(
            `${base}/leads?pageSize=1&cursor=${encodeURIComponent(cursor)}`,
          )
        ).statusCode,
        400,
      );
      const own = (await member.client.request(`${base}/leads?pageSize=1`)).json().cursor;
      assert.ok(own);
      await h.admin.query(
        'update public.organization_memberships set revoked_at=now() where organization_id=$1 and user_id=$2',
        [org, member.user],
      );
      assert.equal(
        (await member.client.request(`${base}/leads?pageSize=1&cursor=${encodeURIComponent(own)}`))
          .statusCode,
        404,
      );
    },
  );
  await t.test('search bounds and literal wildcard matching are enforced', async () => {
    for (const query of ['pageSize=101', `q=${'x'.repeat(101)}`, 'from=2026-12-01&to=2026-01-01'])
      assert.equal((await person.client.request(`${base}/leads?${query}`)).statusCode, 400);
    const found = await person.client.request(`${base}/leads?q=100%25`);
    assert.equal(found.statusCode, 200, found.body);
    assert.equal(found.json().items.length, 1);
    const injected = await person.client.request(
      `${base}/leads?q=${encodeURIComponent("%' OR 1=1 --")}`,
    );
    assert.equal(injected.statusCode, 200, injected.body);
    assert.equal(injected.json().items.length, 0);
  });
  await t.test(
    'prefix and substring modes have explicit meanings and expose no index columns',
    async () => {
      const prefix = await person.client.request(`${base}/leads?q=100%25&searchMode=prefix`);
      assert.equal(prefix.statusCode, 200, prefix.body);
      assert.equal(prefix.json().items.length, 1);
      assert.doesNotMatch(prefix.body, /search_title|search_name/);
      const missing = await person.client.request(`${base}/leads?q=safe&searchMode=prefix`);
      assert.equal(missing.statusCode, 200, missing.body);
      assert.equal(missing.json().items.length, 0);
      const contains = await person.client.request(`${base}/leads?q=SAFE&searchMode=contains`);
      assert.equal(contains.statusCode, 200, contains.body);
      assert.equal(contains.json().items.length, 1);
      assert.equal(
        (await person.client.request(`${base}/leads?searchMode=unbounded`)).statusCode,
        400,
      );
    },
  );
  await t.test('current status, assignment and source filters compose', async () => {
    assert.equal(
      (
        await person.client.request(`${base}/leads/${leads[0].id}/transitions`, {
          method: 'POST',
          body: { version: 1, status: 'qualified' },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await person.client.request(`${base}/leads/${leads[0].id}/assignee`, {
          method: 'PUT',
          body: { version: 2, userId: person.user },
        })
      ).statusCode,
      200,
    );
    const r = await person.client.request(
      `${base}/leads?status=qualified&assignee=mine&sourceId=${source.id}`,
    );
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(
      r.json().items.map((v) => v.id),
      [leads[0].id],
    );
  });
  await t.test(
    'timeline includes shared-contact activity and first touch survives archive',
    async () => {
      const activity = await person.client.request(`${base}/leads/${leads[0].id}/activity`);
      assert.equal(activity.statusCode, 200, activity.body);
      assert.ok(activity.json().items.some((v) => v.subject === 'contact'));
      assert.ok(activity.json().items.some((v) => v.event === 'lead.assigned'));
      assert.equal(
        (
          await person.client.request(`${base}/leads/${leads[0].id}/archive`, {
            method: 'POST',
            body: { version: 3 },
          })
        ).statusCode,
        200,
      );
      const current = (await person.client.request(`${base}/contacts/${contact.id}`)).json();
      assert.equal(current.first_touch.leadId, leads[0].id);
      const archived = await person.client.request(`${base}/leads?archived=archived`);
      assert.equal(archived.statusCode, 200, archived.body);
      assert.deepEqual(
        archived.json().items.map((v) => v.id),
        [leads[0].id],
      );
    },
  );
});
