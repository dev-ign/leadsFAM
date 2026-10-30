import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const dockerBin = '/Applications/Docker.app/Contents/Resources/bin';
export const localEnvironment = {
  ...process.env,
  SUPABASE_TELEMETRY_DISABLED: '1',
  PATH: existsSync(dockerBin)
    ? `${dockerBin}${path.delimiter}${process.env.PATH ?? ''}`
    : process.env.PATH,
};
export const networkName = `leadsfam-local-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)}`;
const projectId = readFileSync(path.join(projectRoot, 'supabase/config.toml'), 'utf8').match(
  /^project_id = "([a-zA-Z0-9_-]+)"/m,
)?.[1];
if (!projectId) throw new Error('Invalid local project identifier');
function docker(args) {
  const result = spawnSync('docker', args, {
    env: localEnvironment,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Local Docker ${args[0]} failed; check Docker Desktop daemon health.`);
  return result.stdout;
}
function ensureNetwork() {
  const names = docker([
    'network',
    'ls',
    '--filter',
    `name=^${networkName}$`,
    '--format',
    '{{.Name}}',
  ])
    .trim()
    .split('\n');
  if (!names.includes(networkName))
    docker([
      'network',
      'create',
      '--driver',
      'bridge',
      '--opt',
      'com.docker.network.bridge.host_binding_ipv4=127.0.0.1',
      networkName,
    ]);
  const [network] = JSON.parse(docker(['network', 'inspect', networkName]));
  if (
    network.Driver !== 'bridge' ||
    network.Options?.['com.docker.network.bridge.host_binding_ipv4'] !== '127.0.0.1'
  )
    throw new Error('Unsafe local network configuration; refuse to start.');
}
export function assertLocalBindings() {
  const names = ['db', 'kong', 'studio', 'inbucket'].map(
    (service) => `supabase_${service}_${projectId}`,
  );
  const containers = JSON.parse(docker(['inspect', ...names]));
  let published = 0;
  for (const container of containers) {
    for (const bindings of Object.values(container.NetworkSettings.Ports ?? {})) {
      if (bindings?.length) published++;
      for (const binding of bindings ?? []) {
        if (binding.HostIp !== '127.0.0.1' && binding.HostIp !== '::1')
          throw new Error(
            'Unsafe local port binding; stop the stack and restart using pnpm db:start.',
          );
      }
    }
  }
  if (published !== 4) throw new Error('Unexpected local published-port topology');
}
export function runLocalCLI(args) {
  if (args[0] === 'start') ensureNetwork();
  // CLI 2.122 generates types in-process against host loopback; it explicitly
  // rejects --network-id. Container-backed commands still use our bridge.
  const networkArgs = args[0] === 'gen' && args[1] === 'types' ? [] : ['--network-id', networkName];
  const result = spawnSync(
    path.join(projectRoot, 'node_modules/.bin/supabase'),
    [...args, ...networkArgs],
    {
      cwd: projectRoot,
      env: localEnvironment,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 600_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    let safeCode = '';
    try {
      const parsed = JSON.parse(result.stdout);
      const code = parsed.error?.code;
      if (typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code)) safeCode = ` ${code}`;
    } catch {
      /* Raw CLI output can contain credentials; never dump it. */
    }
    throw new Error(
      `Local Supabase command failed (${args.slice(0, 2).join(' ')}), exit ${result.status}.${safeCode}`,
    );
  }
  if (args[0] === 'start') {
    try {
      assertLocalBindings();
    } catch (error) {
      try {
        runLocalCLI(['stop']);
      } catch {
        throw new Error(
          'Unsafe local binding and automatic stack shutdown failed; stop this project in Docker Desktop.',
        );
      }
      throw error;
    }
  }
  return result.stdout;
}
export function localStack() {
  assertLocalBindings();
  const status = JSON.parse(runLocalCLI(['status', '-o', 'json']));
  const url = status.API_URL;
  const key = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  const databaseUrl = status.DB_URL;
  for (const value of [url, databaseUrl]) {
    if (
      typeof value !== 'string' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)
    )
      throw new Error('Only an explicitly local Supabase stack is permitted.');
  }
  if (typeof key !== 'string') throw new Error('Local public API key is unavailable.');
  return { url, key, databaseUrl };
}
