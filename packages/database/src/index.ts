import pg from 'pg';

// Server-only persistence; callers must verify the runtime role before serving
// requests. Privileged local test fixtures use their own explicit connection.
export function createSessionPool(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10_000,
  });
}

export type { Database, Json } from './database.types.js';
export { UserDatabase, DatabaseRpcFailure } from './rpc.js';
