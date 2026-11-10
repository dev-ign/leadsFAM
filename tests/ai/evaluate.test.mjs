import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateDataset } from './evaluate.mjs';
import { AiFailure, simulationProvider } from '../../apps/api/dist/modules/ai/provider.js';
const dataset = JSON.parse(
  await readFile(new URL('../fixtures/ai/qualification.json', import.meta.url), 'utf8'),
);
const subset = (...cases) => ({ ...dataset, cases });
const first = dataset.cases[0];

test('failed inference stays in every expected accuracy denominator and preserves supplied usage', async () => {
  let calls = 0;
  const report = await evaluateDataset(subset(first, { ...first, id: 'uncertain' }), {
    config: { inputRate: 0.5, outputRate: 1.5, pricingVersion: 'synthetic-v1' },
    provider: {
      async execute(source, signal) {
        if (++calls === 2)
          throw new AiFailure('INFERENCE_UNCERTAIN', { inputTokens: 12, outputTokens: 34 });
        return simulationProvider.execute(source, signal);
      },
    },
  });
  assert.deepEqual(report.metrics.structuredValidity, { passed: 1, total: 2, rate: 0.5 });
  assert.deepEqual(report.metrics.extraction, { passed: 3, total: 6, rate: 0.5 });
  assert.deepEqual(report.metrics.serviceFit, { passed: 1, total: 2, rate: 0.5 });
  assert.deepEqual(report.metrics.intentCategory, { passed: 1, total: 2, rate: 0.5 });
  assert.equal(report.rows[1].error, 'INFERENCE_UNCERTAIN');
  assert.equal(report.rows[1].estimatedCostMicrousd, 57);
  assert.equal(report.automatedThresholdsMet, false);
  assert.equal(calls, 2); // Uncertain paid outcomes are never retried by the evaluator.
});

test('malformed and ungrounded output fail their expected checks rather than being omitted', async () => {
  for (const malformed of [true, false]) {
    const report = await evaluateDataset(subset(first), {
      provider: {
        async execute(source, signal) {
          const result = await simulationProvider.execute(source, signal);
          if (malformed) return { ...result, output: null };
          result.output.analysis.location = { source: 'lead.description', quote: 'Invented city' };
          return result;
        },
      },
    });
    assert.equal(report.metrics.structuredValidity.passed, malformed ? 0 : 1);
    assert.deepEqual(report.metrics.evidenceGrounding, { passed: 0, total: 1, rate: 0 });
    assert.deepEqual(report.metrics.extraction, { passed: 0, total: 3, rate: 0 });
    assert.equal(report.rows[0].error, 'INVALID_OUTPUT');
    assert.equal(report.automatedThresholdsMet, false);
  }
});

test('provider injection judgment is measured separately from enforced application review', async () => {
  const security = dataset.cases.find((c) => c.id === 'injection');
  const report = await evaluateDataset(subset(security), {
    provider: {
      async execute(source, signal) {
        const result = await simulationProvider.execute(source, signal);
        result.output.analysis.humanReview = false;
        result.output.analysis.nextAction = 'acknowledge';
        return result;
      },
    },
  });
  assert.deepEqual(report.metrics.providerInjectionResistance, { passed: 0, total: 1, rate: 0 });
  assert.deepEqual(report.metrics.injectionResistance, { passed: 1, total: 1, rate: 1 });
  assert.equal(report.rows[0].providerRequestedReview, false);
  assert.equal(report.criticalBoundaryAssessment.status, 'not_assessed_by_provider_runner');
  assert.equal(report.automatedThresholdsMet, false);
});

test('valid longer source quotes count the explicit detail without inventing unknown facts', async () => {
  const report = await evaluateDataset(subset(first), {
    provider: {
      async execute(source, signal) {
        const result = await simulationProvider.execute(source, signal);
        for (const field of ['service', 'location', 'timeframe'])
          result.output.analysis[field] = {
            source: 'lead.description',
            quote: source.lead.description,
          };
        // areaFit's exact service-area requirement is preserved by the grounding boundary.
        result.output.analysis.areaFit = 'unknown';
        return result;
      },
    },
  });
  assert.equal(report.metrics.extraction.passed, 3);
  assert.equal(report.metrics.extraction.total, 3);
});

test('invalid or empty datasets are rejected before any inference', async () => {
  let calls = 0;
  const options = {
    provider: {
      async execute() {
        calls++;
        throw new Error('Must not infer');
      },
    },
  };
  for (const invalid of [
    subset(),
    subset(first, first),
    subset(first, { ...first, id: 'oversized', text: 'x'.repeat(2001) }),
    subset({ ...first, expected: {} }),
    subset({ ...first, expected: { typo: true } }),
  ])
    await assert.rejects(evaluateDataset(invalid, options));
  assert.equal(calls, 0);
});

test('a hung provider has a bounded deadline and unknown errors never expose private details', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const report = await evaluateDataset(subset(first), {
      config: { deadlineMs: 10 },
      provider: {
        execute() {
          return new Promise(() => {});
        },
      },
    });
    assert.equal(report.rows[0].error, 'TIMEOUT_UNCERTAIN');
    assert.equal(report.metrics.extraction.total, 3);
    assert.equal(report.automatedThresholdsMet, false);
  } finally {
    clearTimeout(keepAlive);
  }
  const report = await evaluateDataset(subset(first), {
    provider: {
      async execute() {
        throw new Error('private provider body and secret');
      },
    },
  });
  assert.equal(report.rows[0].error, 'INVALID_OUTPUT');
  assert.ok(!JSON.stringify(report).includes('private provider body and secret'));
});

test('the CLI writes its failed report and returns a failing gate status without enabling real inference', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'leadsfam-ai-eval-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'evaluation.json');
  const result = spawnSync(
    process.execPath,
    [
      new URL('./evaluate.mjs', import.meta.url).pathname,
      '--enforce-thresholds',
      `--output=${target}`,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(report.mode, 'deterministic-simulation-not-model-quality');
  assert.equal(report.rows.length, 15);
  assert.equal(report.automatedThresholdsMet, false);
  assert.ok(
    report.rows.every((row) => row.inputTokens === null && row.estimatedCostMicrousd === null),
  );
});
