import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '8.30.1';
const checksums = {
  darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  linux_arm64: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
};
const platform = `${process.platform}_${process.arch}`;
const expected = checksums[platform];
if (!expected)
  throw new Error(
    `Secret scanning supports macOS/Linux arm64/x64; unsupported platform: ${platform}`,
  );
const tools = path.join(root, '.tools', `gitleaks-${version}-${platform}`);
await mkdir(tools, { recursive: true });
const archive = path.join(tools, 'release.tar.gz');
let bytes;
try {
  bytes = await readFile(archive);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (bytes === undefined) {
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${platform}.tar.gz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Gitleaks download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Gitleaks archive checksum mismatch');
  await writeFile(archive, bytes);
}
if (createHash('sha256').update(bytes).digest('hex') !== expected)
  throw new Error('Cached Gitleaks archive checksum mismatch');
// Re-extract from the verified archive on each run rather than trusting a cached executable.
execFileSync('tar', ['-xzf', archive, '-C', tools, 'gitleaks']);
const executable = path.join(tools, 'gitleaks');
const config = path.join(root, '.gitleaks.toml');
function scan(arguments_, capture = false) {
  const result = spawnSync(
    executable,
    [...arguments_, '--config', config, '--redact=100', '--no-banner', '--exit-code=1'],
    { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 120_000 },
  );
  if (result.error) throw result.error;
  return result;
}
const canaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'leadops-secret-canary-'));
try {
  // Nonfunctional random text, assembled at runtime; never an issued credential.
  const canaryDatabase = new URL('postgresql://127.0.0.1/test');
  canaryDatabase.username = 'canary';
  canaryDatabase.password = randomBytes(32).toString('hex');
  await writeFile(
    path.join(canaryDirectory, '.env'),
    `OPENAI_API_KEY=sk-proj-${randomBytes(32).toString('hex')}\nSESSION_KEYS='${JSON.stringify({ canary: randomBytes(32).toString('base64') })}'\nSESSION_DATABASE_URL=${canaryDatabase.href}\n`,
  );
  const reportPath = path.join(canaryDirectory, 'findings.json');
  const canary = scan(
    ['dir', canaryDirectory, '--report-format=json', '--report-path', reportPath],
    true,
  );
  const findings = JSON.parse(await readFile(reportPath, 'utf8'));
  if (
    canary.status !== 1 ||
    !['leadops-sensitive-env', 'leadsfam-session-key', 'leadsfam-database-password'].every((rule) =>
      findings.some((finding) => finding.RuleID === rule),
    )
  )
    throw new Error('Gitleaks detection canary failed');
  console.log(
    'Secret-detection canary passed (scanner rejected synthetic provider, session and database credentials).',
  );
} finally {
  await rm(canaryDirectory, { recursive: true, force: true });
}
const workingTree = scan(['dir', root]);
if (workingTree.status !== 0) process.exit(workingTree.status ?? 1);
const history = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: 'ignore' });
if (history.error) throw history.error;
if (history.status === 0) {
  const result = scan(['git', root, '--log-opts=--all']);
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  console.log(
    'Git history scan skipped: this repository has no commits. Working-tree scan completed.',
  );
}
