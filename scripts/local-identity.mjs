import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod, rename } from 'node:fs/promises';
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
  const admin = createSessionPool(stack.databaseUrl);
  const connection = await admin.connect();
  try {
    await connection.query('begin');
    // Multiple local test processes share this role and secret file. Serialize
    // bootstrap only; application requests and database race tests stay parallel.
    await connection.query(
      "select pg_advisory_xact_lock(hashtextextended('leadsfam-local-bootstrap',0))",
    );
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
    if (
      !secrets.cursorKey ||
      !secrets.ingressPassword ||
      !secrets.workerPassword ||
      !secrets.mockWebhookSecret
    ) {
      secrets.cursorKey ??= randomBytes(32).toString('base64');
      secrets.ingressPassword ??= randomBytes(32).toString('hex');
      secrets.workerPassword ??= randomBytes(32).toString('hex');
      secrets.mockWebhookSecret ??= randomBytes(32).toString('base64');
      const replacement = `${file}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(replacement, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
      await rename(replacement, file);
    }
    if (
      !/^[a-f0-9]{64}$/.test(secrets.password) ||
      !/^[a-f0-9]{64}$/.test(secrets.ingressPassword) ||
      !/^[a-f0-9]{64}$/.test(secrets.workerPassword) ||
      Buffer.from(secrets.key, 'base64').length !== 32 ||
      Buffer.from(secrets.cursorKey, 'base64').length !== 32 ||
      secrets.cursorKey === secrets.key
    )
      throw new Error('Invalid local identity credentials');
    // PostgreSQL passwords cannot be bind parameters in ALTER ROLE. The value is
    // generated locally, validated as hex, and never taken from request input.
    await connection.query(`alter role leadsfam_runtime password '${secrets.password}'`);
    await connection.query(`alter role leadsfam_ingress password '${secrets.ingressPassword}'`);
    await connection.query(`alter role leadsfam_worker password '${secrets.workerPassword}'`);
    await connection.query('commit');
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally {
    connection.release();
    await admin.end();
  }
  const database = new URL(stack.databaseUrl);
  database.username = 'leadsfam_runtime';
  database.password = secrets.password;
  const ingress = new URL(stack.databaseUrl),
    worker = new URL(stack.databaseUrl);
  ingress.username = 'leadsfam_ingress';
  ingress.password = secrets.ingressPassword;
  worker.username = 'leadsfam_worker';
  worker.password = secrets.workerPassword;
  return {
    mockWebhookSecret: secrets.mockWebhookSecret,
    ingressDatabaseUrl: ingress.toString(),
    workerDatabaseUrl: worker.toString(),
    url: stack.url,
    publicKey: stack.key,
    databaseUrl: database.toString(),
    activeKey: 'local-v1',
    keys: { 'local-v1': secrets.key },
    onboardingEnabled: true,
    cursorKey: secrets.cursorKey,
  };
}
