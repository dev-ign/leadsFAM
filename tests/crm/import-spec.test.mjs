import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { importContract } from './import-contract.mjs';

// Independent executable specification, deliberately without SQL, API code,
// contact normalization, or a production execution path.
function referenceModel() {
  const attempts = new Map(),
    deliveries = new Map();
  let count = 0;
  const fail = (code) => Object.assign(new Error(code), { code });
  const adapter = {
    async execute(job, attempt, rows) {
      const key = `${job}:${attempt}`,
        canonical = JSON.stringify(rows);
      if (attempts.has(key)) {
        const previous = attempts.get(key);
        if (previous.canonical !== canonical) throw fail('IDEMPOTENCY_CONFLICT');
        return structuredClone(previous.result);
      }
      if (new Set(rows.map((r) => r.deliveryId)).size !== rows.length)
        throw fail('INVALID_MANIFEST');
      for (const row of rows) {
        const previous = deliveries.get(row.deliveryId);
        if (previous && previous.job !== job) throw fail('DELIVERY_JOB_CONFLICT');
        if (previous && previous.rowNumber !== row.rowNumber) throw fail('INVALID_MANIFEST');
      }
      const result = {
        jobId: job,
        attemptId: attempt,
        rows: rows.map((row) => {
          let previous = deliveries.get(row.deliveryId);
          if (!previous) {
            previous = { job, rowNumber: row.rowNumber };
            deliveries.set(row.deliveryId, previous);
          }
          const base = { deliveryId: row.deliveryId, rowNumber: row.rowNumber };
          if (previous.success)
            return previous.value === row.value
              ? structuredClone(previous.success)
              : { ...base, status: 'failed', code: 'DELIVERY_ALREADY_SUCCEEDED' };
          if (row.value === 'INVALID') return { ...base, status: 'failed', code: 'INVALID_FIELDS' };
          const success = {
            ...base,
            status: 'succeeded',
            contactId: 'model-contact',
            leadId: randomUUID(),
          };
          previous.value = row.value;
          previous.success = success;
          count++;
          return success;
        }),
      };
      attempts.set(key, { canonical, result: structuredClone(result) });
      return result;
    },
    count: async () => count,
    reconnect: () => adapter,
    async loseResponse(...args) {
      await adapter.execute(...args);
      throw fail('SIMULATED_RESPONSE_LOSS');
    },
  };
  return adapter;
}
test('ADR 0011 retry contract before execution implementation', (t) =>
  importContract(t, referenceModel()));
