import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-boundaries.mjs', import.meta.url));
async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'leadops-boundaries-'));
  const packages = {
    'apps/web': '@leadops/web',
    'apps/api': '@leadops/api',
    'packages/ui': '@leadops/ui',
    'packages/shared': '@leadops/shared',
    'packages/config': '@leadops/config',
  };
  async function write(file, value) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  for (const [location, name] of Object.entries(packages))
    await write(`${location}/package.json`, JSON.stringify({ name, dependencies: {} }));
  function check() {
    const result = spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { code: result.status, output: result.stdout + result.stderr };
  }
  try {
    await run({ write, check });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('allows the intended package graph', () =>
  fixture(async ({ write, check }) => {
    await write(
      'apps/web/package.json',
      JSON.stringify({ name: '@leadops/web', dependencies: { '@leadops/shared': 'workspace:*' } }),
    );
    await write('apps/web/src/client.ts', "import { contract } from '@leadops/shared';");
    assert.equal(check().code, 0);
  }));
test('rejects server modules entering browser code', () =>
  fixture(async ({ write, check }) => {
    await write('apps/web/src/leak.ts', "import 'node:fs/promises';");
    const result = check();
    assert.equal(result.code, 1);
    assert.match(result.output, /Node builtin/);
  }));
test('rejects relative imports across app boundaries', () =>
  fixture(async ({ write, check }) => {
    await write('apps/web/src/leak.ts', "import '../../api/src/private.js';");
    const result = check();
    assert.equal(result.code, 1);
    assert.match(result.output, /crosses a package boundary/);
  }));
test('rejects forbidden and undeclared server package dependencies', () =>
  fixture(async ({ write, check }) => {
    await write('apps/web/src/leak.ts', "import '@leadops/database';");
    const result = check();
    assert.equal(result.code, 1);
    assert.match(result.output, /forbidden package/);
    assert.match(result.output, /undeclared dependency/);
  }));
test('rejects module cycles', () =>
  fixture(async ({ write, check }) => {
    await write('packages/shared/src/a.ts', "import './b.js';");
    await write('packages/shared/src/b.ts', "import './a.js';");
    const result = check();
    assert.equal(result.code, 1);
    assert.match(result.output, /Module cycle/);
  }));
test('rejects workspace cycles and registry fallback', () =>
  fixture(async ({ write, check }) => {
    await write(
      'packages/shared/package.json',
      JSON.stringify({ name: '@leadops/shared', dependencies: { '@leadops/ui': '0.0.0' } }),
    );
    await write(
      'packages/ui/package.json',
      JSON.stringify({ name: '@leadops/ui', dependencies: { '@leadops/shared': 'workspace:*' } }),
    );
    const result = check();
    assert.equal(result.code, 1);
    assert.match(result.output, /Package cycle/);
    assert.match(result.output, /must use workspace/);
  }));
