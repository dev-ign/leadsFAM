import { spawn } from 'node:child_process';
import { localIdentity } from './local-identity.mjs';
const identity = await localIdentity();
const child = spawn(process.execPath, ['--import', 'tsx', '--watch', 'src/server.ts'], {
  cwd: new URL('../apps/api/', import.meta.url),
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    SUPABASE_URL: identity.url,
    SUPABASE_PUBLIC_KEY: identity.publicKey,
    SESSION_DATABASE_URL: identity.databaseUrl,
    SESSION_ACTIVE_KEY: identity.activeKey,
    SESSION_KEYS: JSON.stringify(identity.keys),
    ALLOW_ORG_CREATION: 'true',
  },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
