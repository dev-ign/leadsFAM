import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// The same observable contract is run against the pre-implementation reference
// model and the real database adapter. No production code imports this model.
export async function importContract(t, adapter) {
  const job = randomUUID(),
    attempt = randomUUID(),
    a = randomUUID(),
    b = randomUUID(),
    c = randomUUID();
  const rows = [
    { deliveryId: a, rowNumber: 1, value: 'Original A' },
    { deliveryId: b, rowNumber: 2, value: 'INVALID' },
    { deliveryId: c, rowNumber: 3, value: 'Original C' },
  ];
  let original;
  await t.test('partial success returns durable safe results', async () => {
    original = await adapter.execute(job, attempt, rows);
    assert.deepEqual(
      original.rows.map((r) => r.status),
      ['succeeded', 'failed', 'succeeded'],
    );
    assert.equal(await adapter.count(), 2);
  });
  await t.test('identical execution replay returns the exact stored result', async () => {
    assert.deepEqual(await adapter.execute(job, attempt, rows), original);
    assert.equal(await adapter.count(), 2);
  });
  await t.test('changed payload cannot reuse an attempt identity', async () => {
    await assert.rejects(
      adapter.execute(
        job,
        attempt,
        rows.map((r) => (r.deliveryId === b ? { ...r, value: 'Fixed B' } : r)),
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    assert.equal(await adapter.count(), 2);
  });
  await t.test(
    'corrected retry has a new attempt and retains every successful delivery',
    async () => {
      const fixed = await adapter.execute(
        job,
        randomUUID(),
        rows.map((r) => (r.deliveryId === b ? { ...r, value: 'Fixed B' } : r)),
      );
      assert.deepEqual(
        fixed.rows.map((r) => r.status),
        ['succeeded', 'succeeded', 'succeeded'],
      );
      assert.equal(fixed.rows[0].leadId, original.rows[0].leadId);
      assert.equal(fixed.rows[2].leadId, original.rows[2].leadId);
      assert.equal(await adapter.count(), 3);
      // The failed original attempt stays immutable even after a later correction.
      assert.deepEqual(await adapter.execute(job, attempt, rows), original);
    },
  );
  await t.test(
    'changed successful delivery is rejected without creating another record',
    async () => {
      const changed = await adapter.execute(job, randomUUID(), [
        { ...rows[0], value: 'Different logical content' },
      ]);
      assert.equal(changed.rows[0].code, 'DELIVERY_ALREADY_SUCCEEDED');
      assert.equal(await adapter.count(), 3);
    },
  );
  await t.test('duplicate deliveries and cross-job reuse cannot relabel a manifest', async () => {
    await assert.rejects(adapter.execute(job, randomUUID(), [rows[0], rows[0]]), {
      code: 'INVALID_MANIFEST',
    });
    await assert.rejects(adapter.execute(randomUUID(), randomUUID(), [rows[0]]), {
      code: 'DELIVERY_JOB_CONFLICT',
    });
    await assert.rejects(adapter.execute(job, randomUUID(), [{ ...rows[0], rowNumber: 9 }]), {
      code: 'INVALID_MANIFEST',
    });
    assert.equal(await adapter.count(), 3);
  });
  await t.test('commit-before-response loss survives a new client instance', async () => {
    const nextAttempt = randomUUID(),
      nextRows = [{ deliveryId: randomUUID(), rowNumber: 4, value: 'After timeout' }];
    await assert.rejects(adapter.loseResponse(job, nextAttempt, nextRows), {
      code: 'SIMULATED_RESPONSE_LOSS',
    });
    const replacement = adapter.reconnect();
    const recovered = await replacement.execute(job, nextAttempt, nextRows);
    assert.equal(recovered.rows[0].status, 'succeeded');
    assert.equal(await replacement.count(), 4);
  });
  await t.test('competing attempts cannot recreate one logical delivery', async () => {
    const row = { deliveryId: randomUUID(), rowNumber: 5, value: 'Racing delivery' };
    const [first, second] = await Promise.all([
      adapter.execute(job, randomUUID(), [row]),
      adapter.execute(job, randomUUID(), [row]),
    ]);
    assert.equal(first.rows[0].leadId, second.rows[0].leadId);
    assert.equal(await adapter.count(), 5);
  });
}
