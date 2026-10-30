import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, pool, rpc } from './fixture.mjs';
import { importContract } from '../crm/import-contract.mjs';
after(() => pool.end());

async function setup(run) {
  const f = await fixture();
  try {
    f.contact = await rpc(f.ids.owner, 'crm_save_contact', [
      f.org,
      'create',
      { kind: 'person', displayName: 'Synthetic import contact', emails: [], phones: [] },
      null,
      null,
      randomUUID(),
    ]);
    f.intake = (title) => ({
      contact: { mode: 'existing', id: f.contact.id },
      lead: { title, description: '', priority: title === 'INVALID' ? 'invalid' : 'normal' },
      attribution: {},
    });
    await run(f);
  } finally {
    await f.cleanup();
  }
}
const importRpc = (person, org, job, attempt, rows) =>
  rpc(person, 'crm_import_execute', [org, job, attempt, JSON.stringify(rows)]);
const errorCode = (error) =>
  Object.assign(error, {
    code: ['idempotency_conflict', 'delivery_job_conflict', 'invalid_manifest'].includes(
      error.message,
    )
      ? error.message.toUpperCase()
      : error.code,
  });

test('PostgreSQL passes the pre-implementation retry contract', (t) =>
  setup(async (f) => {
    function adapter() {
      const result = {
        async execute(job, attempt, rows) {
          try {
            return await importRpc(
              f.ids.owner,
              f.org,
              job,
              attempt,
              rows.map(({ value, ...row }) => ({ ...row, intake: f.intake(value) })),
            );
          } catch (error) {
            throw errorCode(error);
          }
        },
        count: async () =>
          (
            await pool.query('select count(*)::int n from public.leads where organization_id=$1', [
              f.org,
            ])
          ).rows[0].n,
        reconnect: adapter,
        async loseResponse(...args) {
          await result.execute(...args);
          throw Object.assign(new Error('SIMULATED_RESPONSE_LOSS'), {
            code: 'SIMULATED_RESPONSE_LOSS',
          });
        },
      };
      return result;
    }
    await importContract(t, adapter());
  }));

test('manual intake is atomic, idempotent, tenant scoped and cannot forge the channel or lifecycle', () =>
  setup(async (f) => {
    const key = randomUUID(),
      data = f.intake('Manual synthetic');
    const first = await rpc(f.ids.member, 'crm_intake_manual', [f.org, data, key]);
    const second = await rpc(f.ids.member, 'crm_intake_manual', [f.org, data, key]);
    assert.equal(first.id, second.id);
    assert.equal(first.status, 'new');
    assert.equal(first.attribution.channel, 'manual');
    await assert.rejects(
      rpc(f.ids.member, 'crm_intake_manual', [
        f.org,
        { ...data, lead: { ...data.lead, status: 'qualified' } },
        randomUUID(),
      ]),
      { message: 'invalid_fields' },
    );
    await assert.rejects(rpc(f.ids.member, 'crm_intake_manual', [f.otherOrg, data, randomUUID()]), {
      message: 'not_found',
    });
    assert.equal(
      (
        await pool.query(
          'select count(*)::int n from public.crm_activities where organization_id=$1 and lead_id=$2',
          [f.org, first.id],
        )
      ).rows[0].n,
      1,
    );
    const created = {
      ...data,
      contact: {
        mode: 'create',
        data: { kind: 'person', displayName: 'Rolled back contact', emails: [], phones: [] },
      },
      attribution: { sourceId: randomUUID() },
    };
    await assert.rejects(rpc(f.ids.owner, 'crm_intake_manual', [f.org, created, randomUUID()]), {
      message: 'not_found',
    });
    assert.equal(
      (
        await pool.query(
          "select count(*)::int n from public.contacts where organization_id=$1 and display_name='Rolled back contact'",
          [f.org],
        )
      ).rows[0].n,
      0,
    );
  }));

test('import authority, immutable successful delivery and retained manifests are database boundaries', () =>
  setup(async (f) => {
    const job = randomUUID(),
      attempt = randomUUID(),
      row = { deliveryId: randomUUID(), rowNumber: 1, intake: f.intake('Synthetic') };
    await assert.rejects(importRpc(f.ids.member, f.org, job, attempt, [row]), {
      message: 'forbidden',
    });
    await importRpc(f.ids.admin, f.org, job, attempt, [row]);
    await assert.rejects(
      pool.query(
        'update private.lead_import_rows set lead_id=$1 where organization_id=$2 and job_id=$3',
        [randomUUID(), f.org, job],
      ),
      { message: 'immutable_delivery' },
    );
    const status = await rpc(f.ids.owner, 'crm_import_status', [f.org, job]);
    assert.equal(status.deliveries[0].deliveryId, row.deliveryId);
    assert.equal(status.attempts[0].attemptId, attempt);
    assert.equal(JSON.stringify(status).includes('Synthetic'), false);
    await rpc(f.ids.owner, 'change_member', [f.org, f.ids.admin.user, null, true]);
    await assert.rejects(importRpc(f.ids.admin, f.org, job, attempt, [row]), {
      message: 'not_found',
    });
  }));

test('two jobs with reversed contact order complete without a deadlock', () =>
  setup(async (f) => {
    const other = await rpc(f.ids.owner, 'crm_save_contact', [
      f.org,
      'create',
      { kind: 'person', displayName: 'Second synthetic contact', emails: [], phones: [] },
      null,
      null,
      randomUUID(),
    ]);
    const rows = (contacts) =>
      contacts.map((id, i) => ({
        deliveryId: randomUUID(),
        rowNumber: i + 1,
        intake: { ...f.intake('Concurrent import'), contact: { mode: 'existing', id } },
      }));
    const results = await Promise.all([
      importRpc(f.ids.owner, f.org, randomUUID(), randomUUID(), rows([f.contact.id, other.id])),
      importRpc(f.ids.admin, f.org, randomUUID(), randomUUID(), rows([other.id, f.contact.id])),
    ]);
    assert.ok(results.every((result) => result.rows.every((r) => r.status === 'succeeded')));
  }));

test('intra-batch matches require an explicit resolution for both rows', () =>
  setup(async (f) => {
    const job = randomUUID(),
      rows = [1, 2].map((rowNumber) => ({
        deliveryId: randomUUID(),
        rowNumber,
        intake: {
          ...f.intake('Batch review'),
          contact: {
            mode: 'create',
            data: { kind: 'person', displayName: 'Same synthetic person', emails: [], phones: [] },
          },
        },
      }));
    const first = await importRpc(f.ids.owner, f.org, job, randomUUID(), rows);
    assert.deepEqual(
      first.rows.map((r) => r.code),
      ['DUPLICATE_REVIEW_REQUIRED', 'DUPLICATE_REVIEW_REQUIRED'],
    );
    assert.equal(
      (
        await pool.query('select count(*)::int n from public.leads where organization_id=$1', [
          f.org,
        ])
      ).rows[0].n,
      0,
    );
    const resolved = await importRpc(
      f.ids.owner,
      f.org,
      job,
      randomUUID(),
      rows.map((r) => ({
        ...r,
        intake: {
          ...r.intake,
          contact: {
            mode: 'create',
            data: { ...r.intake.contact.data, duplicateResolution: 'create_distinct' },
          },
        },
      })),
    );
    assert.ok(resolved.rows.every((r) => r.status === 'succeeded'));
    assert.notEqual(resolved.rows[0].contactId, resolved.rows[1].contactId);
  }));

test('a synthetic infrastructure failure rolls back the entire attempt and all business writes', () =>
  setup(async (f) => {
    const suffix = randomUUID().replaceAll('-', ''),
      name = `crm_test_fault_${suffix}`;
    const job = randomUUID(),
      attempt = randomUUID();
    try {
      await pool.query(
        `create function private.${name}() returns trigger language plpgsql security invoker set search_path='' as $$ begin if new.organization_id='${f.org}'::uuid and new.title='Synthetic fault' then raise exception using errcode='XX000',message='synthetic_infrastructure_failure'; end if; return new; end $$`,
      );
      await pool.query(
        `revoke all on function private.${name}() from public,anon,authenticated,service_role,leadsfam_runtime`,
      );
      await pool.query(
        `create trigger ${name} before insert on public.leads for each row execute function private.${name}()`,
      );
      const rows = ['Successful before fault', 'Synthetic fault'].map((title, i) => ({
        deliveryId: randomUUID(),
        rowNumber: i + 1,
        intake: f.intake(title),
      }));
      await assert.rejects(importRpc(f.ids.owner, f.org, job, attempt, rows), { code: 'XX000' });
      assert.equal(
        (
          await pool.query('select count(*)::int n from public.leads where organization_id=$1', [
            f.org,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from private.lead_import_jobs where organization_id=$1',
            [f.org],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "select count(*)::int n from private.crm_request_receipts where organization_id=$1 and operation='lead_intake'",
            [f.org],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'select count(*)::int n from public.crm_activities where organization_id=$1 and lead_id is not null',
            [f.org],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await pool.query(`drop trigger if exists ${name} on public.leads`);
      await pool.query(`drop function if exists private.${name}()`);
    }
  }));

test('competing jobs with overlapping delivery sets have one winner and no deadlock', () =>
  setup(async (f) => {
    const rows = [1, 2].map((rowNumber) => ({
      deliveryId: randomUUID(),
      rowNumber,
      intake: f.intake('Overlapping manifest'),
    }));
    const results = await Promise.allSettled([
      importRpc(f.ids.owner, f.org, randomUUID(), randomUUID(), rows),
      importRpc(f.ids.admin, f.org, randomUUID(), randomUUID(), [...rows].reverse()),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      results.find((r) => r.status === 'rejected').reason.message,
      'delivery_job_conflict',
    );
    assert.equal(
      (
        await pool.query('select count(*)::int n from public.leads where organization_id=$1', [
          f.org,
        ])
      ).rows[0].n,
      2,
    );
  }));
