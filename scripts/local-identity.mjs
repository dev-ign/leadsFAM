import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localStack, projectRoot } from './local-stack.mjs';
import { createSessionPool } from '../packages/database/dist/index.js';

// Generated local-only credentials live outside the repository. Never print them.
export async function localIdentity() {
  const stack = localStack();
  const file = path.join(
    tmpdir(),
    `leadsfam-local-${createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)}.json`,
  );
  let secrets;
  try {
    secrets = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secrets = {
      password: randomBytes(32).toString('hex'),
      key: randomBytes(32).toString('base64'),
    };
    await writeFile(file, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
  }
  await chmod(file, 0o600);
  if (!/^[a-f0-9]{64}$/.test(secrets.password) || Buffer.from(secrets.key, 'base64').length !== 32)
    throw new Error('Invalid local identity credentials');
  const admin = createSessionPool(stack.databaseUrl);
  try {
    // PostgreSQL passwords cannot be bind parameters in ALTER ROLE. The value is
    // generated locally, validated as hex, and never taken from request input.
    await admin.query(`alter role leadsfam_runtime password '${secrets.password}'`);
  } finally {
    await admin.end();
  }
  const database = new URL(stack.databaseUrl);
  database.username = 'leadsfam_runtime';
  database.password = secrets.password;
  return {
    url: stack.url,
    publicKey: stack.key,
    databaseUrl: database.toString(),
    activeKey: 'local-v1',
    keys: { 'local-v1': secrets.key },
    onboardingEnabled: true,
  };
}
