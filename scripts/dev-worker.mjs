import { spawn } from 'node:child_process';
import { localIdentity } from './local-identity.mjs';
const identity = await localIdentity();
const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
  cwd: new URL('../apps/api/', import.meta.url),
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development', WORKER_DATABASE_URL: identity.workerDatabaseUrl },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
