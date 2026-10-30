import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionStore } from '../../apps/api/dist/modules/identity/sessions.js';
import { OrganizationService } from '../../apps/api/dist/modules/organizations/service.js';
import { harness } from './fixture.mjs';
const h = await harness();
after(h.cleanup);

test('PostgREST enforces the search deadline and releases resources after timeouts', async () => {
  const person = await h.account(),
    org = await h.organization(person);
  const store = new SessionStore(h.identity),
    lock = await h.admin.connect();
  const name = `crm_deadline_probe_${randomUUID().replaceAll('-', '')}`;
  try {
    const config = (
      await h.admin.query(
        "select proconfig from pg_proc where oid='public.crm_query(uuid,text,jsonb,jsonb)'::regprocedure",
      )
    ).rows[0].proconfig;
    assert.ok(config.includes('statement_timeout=4s'));
    // A disposable invoker function with the SAME setting verifies actual
    // PostgREST hoisting, including that SQL work ends before transport expiry.
    await h.admin.query(
      `create function public.${name}(p_slow boolean) returns text language sql volatile security invoker set search_path='' set statement_timeout='4s' as $$ select pg_sleep(case when p_slow then 6 else 0 end); select current_setting('statement_timeout') $$`,
    );
    await h.admin.query(
      `revoke all on function public.${name}(boolean) from public,anon,authenticated,service_role,leadsfam_runtime`,
    );
    await h.admin.query(`grant execute on function public.${name}(boolean) to authenticated`);
    await h.admin.query("notify pgrst,'reload schema'");
    const session = await store.load(person.client.credentials.cookie.split('=')[1]);
    assert.ok(session?.tokens);
    const request = (slow) =>
      fetch(`${h.identity.url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        signal: AbortSignal.timeout(6500),
        headers: {
          apikey: h.identity.publicKey,
          authorization: `Bearer ${session.tokens.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ p_slow: slow }),
      });
    let ready;
    for (let i = 0; i < 40; i++) {
      ready = await request(false);
      if (ready.status !== 404) break;
      await ready.body?.cancel();
      await delay(50);
    }
    assert.equal(ready.status, 200);
    assert.equal(await ready.json(), '4s');
    const timedOut = await request(true);
    assert.equal((await timedOut.json()).code, '57014');
    assert.equal(
      (
        await h.admin.query(
          "select count(*)::integer n from pg_stat_activity where pid<>pg_backend_pid() and state='active' and query like $1",
          [`%${name}%`],
        )
      ).rows[0].n,
      0,
    );
    assert.equal((await request(false)).status, 200);

    await lock.query('begin');
    // Contend only on this fixture's organization; never lock the shared leads
    // table, which could disrupt unrelated integration tests running in parallel.
    await lock.query('select 1 from public.organizations where id=$1 for update', [org]);
    await assert.rejects(
      new OrganizationService(store).rpc(
        session,
        'crm_query',
        {
          p_org: org,
          p_kind: 'leads',
          p_query: {
            q: '',
            status: 'all',
            priority: 'all',
            sourceId: null,
            assignee: 'all',
            archived: 'active',
            from: null,
            to: null,
            sort: 'created',
            pageSize: 25,
          },
        },
        randomUUID(),
      ),
      (error) =>
        error.statusCode === 503 &&
        error.code === 'DATA_UNAVAILABLE' &&
        !/statement|postgres|lock|select/i.test(error.message),
    );
    await lock.query('rollback');
    assert.equal((await person.client.request(`/organizations/${org}/leads`)).statusCode, 200);
  } finally {
    await lock.query('rollback');
    lock.release();
    await h.admin.query(`drop function if exists public.${name}(boolean)`);
    await h.admin.query("notify pgrst,'reload schema'");
    await store.stop();
  }
});
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

test('search and deep pages equal independent SQL across tenants, ties, channels and archive states', async () => {
  const person = await h.account(),
    org = await h.organization(person),
    foreign = await h.organization(person);
  const contacts = Array.from({ length: 4 }, () => randomUUID()),
    source = randomUUID();
  for (const tenant of [org, foreign]) {
    const ids = tenant === org ? contacts : [randomUUID()];
    for (const [i, id] of ids.entries()) {
      await h.admin.query(
        "insert into public.contacts(id,organization_id,kind,display_name,created_by) values($1,$2,'person',$3,$4)",
        [id, tenant, i === 0 ? 'Éclair shared contact' : `Other contact ${i}`, person.user],
      );
      await h.admin.query(
        'insert into public.contact_emails(organization_id,contact_id,position,value,normalized) values($1,$2,1,$3,$3)',
        [tenant, id, `review-${i}@example.test`],
      );
      await h.admin.query(
        "insert into public.contact_phones(organization_id,contact_id,position,value,normalized) values($1,$2,1,'+12025550123','+12025550123')",
        [tenant, id],
      );
    }
    await h.admin.query(
      `insert into public.leads(organization_id,contact_id,title,status,archived_at,last_assigned_user_id,assigned_membership_generation,created_by,created_at,last_activity_at)
      select $1,($2::uuid[])[1+n%cardinality($2::uuid[])],
        case when n%3=0 then 'Same title' when n%3=1 then 'Éclair 100% !_ safe' else 'Other title' end,
        case when n%3=0 then 'qualified' else 'new' end,
        case when n%5=0 then '2026-10-29Z'::timestamptz end,
        case when n%2=0 then $3::uuid end,case when n%2=0 then 1 end,$3,'2026-10-01Z','2026-10-02Z'
      from generate_series(1,45) n`,
      [tenant, ids, person.user],
    );
  }
  await h.admin.query(
    "insert into public.lead_sources(id,organization_id,name,created_by) values($1,$2,'Reference source',$3)",
    [source, org, person.user],
  );
  await h.admin.query(
    "insert into public.lead_attributions(organization_id,lead_id,source_id,channel) select organization_id,id,$2,'manual' from public.leads where organization_id=$1",
    [org, source],
  );

  for (const [kind, extra] of [
    ['leads', {}],
    ['leads', { q: 'same', searchMode: 'prefix' }],
    ['leads', { q: 'SAFE', searchMode: 'contains' }],
    ['leads', { q: 'éclair', searchMode: 'prefix', archived: 'all' }],
    ['leads', { q: 'review-2', searchMode: 'contains', archived: 'all' }],
    ['leads', { q: '+1202', searchMode: 'prefix', sort: 'activity' }],
    ['leads', { q: '% !_', searchMode: 'contains' }],
    ['leads', { q: 'sa', searchMode: 'contains' }],
    ['leads', { status: 'qualified', sourceId: source, assignee: 'mine' }],
    ['leads', { assignee: 'unassigned', archived: 'archived', sort: 'activity' }],
    ['leads', { q: 'no matching record', searchMode: 'contains' }],
    ['contacts', { q: 'éclair', searchMode: 'prefix' }],
    ['contacts', { q: 'view-2', searchMode: 'contains' }],
  ]) {
    const query = {
      q: '',
      searchMode: 'prefix',
      status: 'all',
      assignee: 'all',
      archived: 'active',
      sort: 'created',
      sourceId: '',
      ...extra,
    };
    // Independent literal matching: strpos/left instead of LIKE/starts_with,
    // with an explicit tenant predicate even on the privileged fixture reader.
    const matches = `(case when $3='prefix' or char_length($2)<3 then left(lower(v),char_length($2))=lower($2) else strpos(lower(v),lower($2))>0 end)`;
    const contactSql = `select c.id from public.contacts c where c.organization_id=$1 and
      ($2='' or exists(select 1 from (
        select c.display_name v union all select normalized from public.contact_emails where organization_id=$1 and contact_id=c.id
        union all select normalized from public.contact_phones where organization_id=$1 and contact_id=c.id
        union all select value from public.contact_phones where organization_id=$1 and contact_id=c.id and $3='contains'
      ) channels where ${matches}))`;
    const expected = (
      await h.admin.query(
        kind === 'contacts'
          ? `${contactSql} order by c.created_at desc,c.id desc`
          : `select l.id from public.leads l where l.organization_id=$1
        and ($4='all' or ($4='active' and l.archived_at is null) or ($4='archived' and l.archived_at is not null))
        and ($5='all' or l.status=$5)
        and ($6='all' or ($6='mine' and l.last_assigned_user_id=$7 and l.assigned_membership_generation=1) or ($6='unassigned' and l.last_assigned_user_id is null))
        and ($8::uuid is null or exists(select 1 from public.lead_attributions a where a.organization_id=$1 and a.lead_id=l.id and a.source_id=$8))
        and ($2='' or exists(select 1 from (select l.title v) title where ${matches}) or l.contact_id in (${contactSql}))
        order by ${query.sort === 'activity' ? 'l.last_activity_at' : 'l.created_at'} desc,l.id desc`,
        kind === 'contacts'
          ? [org, query.q, query.searchMode]
          : [
              org,
              query.q,
              query.searchMode,
              query.archived,
              query.status,
              query.assignee,
              person.user,
              query.sourceId || null,
            ],
      )
    ).rows.map((v) => v.id);
    const ids = [];
    let cursor = '';
    do {
      const params = new URLSearchParams({
        ...query,
        pageSize: '7',
        ...(cursor ? { cursor } : {}),
      });
      if (!query.sourceId) params.delete('sourceId');
      const response = await person.client.request(`/organizations/${org}/${kind}?${params}`);
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json();
      ids.push(...page.items.map((v) => v.id));
      cursor = page.cursor;
      assert.ok(ids.length <= 45, 'Pagination must terminate without duplicating rows');
    } while (cursor);
    assert.deepEqual(ids, expected, JSON.stringify({ kind, ...query }));
  }
});
