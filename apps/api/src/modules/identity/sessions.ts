import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { createSessionPool } from '@leadops/database';
import { AuthProvider, type Tokens } from './provider.js';
import { IdentityFailure } from './failure.js';

export interface IdentityConfig {
  url: string;
  publicKey: string;
  databaseUrl: string;
  activeKey: string;
  keys: Record<string, string>;
  onboardingEnabled: boolean;
}
const tokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  userId: z.uuid(),
  email: z.email(),
  sessionId: z.uuid(),
});
const payloadSchema = z.object({ csrf: z.string(), tokens: tokensSchema.nullable() });
const envelopeSchema = z.object({
  kid: z.string(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});
type Purpose = 'anonymous' | 'recovery' | 'application';
type Payload = z.infer<typeof payloadSchema>;
interface Row {
  id_hash: string;
  user_id: string | null;
  provider_session_id: string | null;
  purpose: Purpose;
  token_envelope: unknown;
  csrf_hash: string;
}
export interface AppSession {
  hash: string;
  purpose: Purpose;
  csrf: string;
  tokens: Tokens | null;
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fresh = () => randomBytes(32).toString('base64url');
export function matches(left: string, right: string) {
  const a = Buffer.from(hash(left)),
    b = Buffer.from(hash(right));
  return timingSafeEqual(a, b);
}
export class SessionStore {
  readonly pool: ReturnType<typeof createSessionPool>;
  readonly provider: AuthProvider;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly config: IdentityConfig,
    provider?: AuthProvider,
  ) {
    this.pool = createSessionPool(config.databaseUrl);
    this.provider = provider ?? new AuthProvider(config.url, config.publicKey);
  }
  async start(onCleanupFailure: () => void = () => {}) {
    const result = await this.pool.query(
      "select current_user name, rolsuper, rolbypassrls, pg_has_role(current_user,'leadsfam_policy','MEMBER') policy, has_table_privilege(current_user,'public.organization_notes','SELECT') tenant from pg_roles where rolname=current_user",
    );
    const role = result.rows[0] as {
      name: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      policy: boolean;
      tenant: boolean;
    };
    if (
      role.name !== 'leadsfam_runtime' ||
      role.rolsuper ||
      role.rolbypassrls ||
      role.policy ||
      role.tenant
    )
      throw new Error('Unsafe identity runtime database role');
    await this.cleanup();
    this.timer = setInterval(() => {
      void this.cleanup().catch(() => {
        onCleanupFailure(); // Expiry remains enforced; the next bounded sweep retries.
      });
    }, 60_000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.pool.end();
  }
  async cleanup() {
    await this.pool.query(
      'delete from private.app_sessions where id_hash in (select id_hash from private.app_sessions where expires_at<=clock_timestamp() or idle_expires_at<=clock_timestamp() or revoked_at is not null limit 500)',
    );
  }
  private aad(row: Pick<Row, 'id_hash' | 'user_id' | 'provider_session_id' | 'purpose'>) {
    return Buffer.from(
      JSON.stringify([row.id_hash, row.user_id, row.provider_session_id, row.purpose]),
    );
  }
  seal(
    row: Pick<Row, 'id_hash' | 'user_id' | 'provider_session_id' | 'purpose'>,
    payload: Payload,
  ) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(this.config.keys[this.config.activeKey] ?? '', 'base64'),
      iv,
    );
    cipher.setAAD(this.aad(row));
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return {
      kid: this.config.activeKey,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  }
  open(row: Row): Payload {
    try {
      const env = envelopeSchema.parse(row.token_envelope),
        key = this.config.keys[env.kid];
      if (!key) throw new Error('Missing key');
      const cipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(key, 'base64'),
        Buffer.from(env.iv, 'base64'),
      );
      cipher.setAAD(this.aad(row));
      cipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      const data = Buffer.concat([cipher.update(Buffer.from(env.data, 'base64')), cipher.final()]);
      const payload = payloadSchema.parse(JSON.parse(data.toString()));
      if (!matches(hash(payload.csrf), row.csrf_hash)) throw new Error('Invalid binding');
      return payload;
    } catch {
      throw new IdentityFailure(401, 'SESSION_EXPIRED');
    }
  }
  async clock() {
    return (await this.pool.query<{ now: Date }>('select clock_timestamp() now')).rows[0]!.now;
  }
  async create(
    purpose: Purpose,
    tokens: Tokens | null,
    previousHash?: string,
    signInStartedAt?: Date,
  ) {
    const cookie = fresh(),
      id_hash = hash(cookie),
      csrf = fresh();
    const row = {
      id_hash,
      user_id: tokens?.userId ?? null,
      provider_session_id: tokens?.sessionId ?? null,
      purpose,
    };
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      if (purpose === 'application' && tokens) {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [tokens.userId]);
        const fence = await client.query<{ blocked: boolean; changed_at: Date }>(
          'select blocked,changed_at from private.auth_guards where user_id=$1',
          [tokens.userId],
        );
        const guard = fence.rows[0];
        if (guard && (guard.blocked || !signInStartedAt || guard.changed_at >= signInStartedAt))
          throw new IdentityFailure(401, 'SIGN_IN_AGAIN');
      }
      if (previousHash)
        await client.query(
          'update private.app_sessions set revoked_at=clock_timestamp() where id_hash=$1',
          [previousHash],
        );
      const minutes = purpose === 'application' ? 30 : purpose === 'recovery' ? 10 : 15;
      await client.query(
        "insert into private.app_sessions(id_hash,user_id,provider_session_id,purpose,token_envelope,csrf_hash,idle_expires_at,expires_at) values($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 minute',clock_timestamp()+$8*interval '1 minute')",
        [
          id_hash,
          row.user_id,
          row.provider_session_id,
          purpose,
          JSON.stringify(this.seal(row, { csrf, tokens })),
          hash(csrf),
          minutes,
          purpose === 'application' ? 720 : minutes,
        ],
      );
      await client.query('commit');
      return { cookie, session: { hash: id_hash, purpose, csrf, tokens } satisfies AppSession };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async load(cookie?: string): Promise<AppSession | null> {
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
    const id = hash(cookie),
      client = await this.pool.connect();
    try {
      await client.query('begin');
      const found = await client.query<Row>(
        'select * from private.app_sessions where id_hash=$1 and revoked_at is null and expires_at>clock_timestamp() and idle_expires_at>clock_timestamp() for update',
        [id],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query('commit');
        return null;
      }
      const payload = this.open(row);
      if (payload.tokens) {
        if (payload.tokens.expiresAt <= Date.now() / 1000 + 60) {
          payload.tokens = await this.provider.tokens('/token?grant_type=refresh_token', {
            refresh_token: payload.tokens.refreshToken,
          });
          if (
            payload.tokens.userId !== row.user_id ||
            payload.tokens.sessionId !== row.provider_session_id
          )
            throw new IdentityFailure(401, 'SESSION_EXPIRED');
        } else {
          const verified = await this.provider.user(payload.tokens.accessToken);
          if (verified.id !== row.user_id || !verified.email_confirmed_at)
            throw new IdentityFailure(401, 'SESSION_EXPIRED');
          payload.tokens.email = verified.email;
        }
      }
      await client.query(
        "update private.app_sessions set token_envelope=$2,last_seen_at=clock_timestamp(),idle_expires_at=least(expires_at,clock_timestamp()+$3*interval '1 minute') where id_hash=$1",
        [
          id,
          JSON.stringify(this.seal(row, payload)),
          row.purpose === 'application' ? 30 : row.purpose === 'recovery' ? 10 : 15,
        ],
      );
      await client.query('commit');
      return { hash: id, purpose: row.purpose, csrf: payload.csrf, tokens: payload.tokens };
    } catch (error) {
      await client.query('rollback');
      if (error instanceof IdentityFailure && error.statusCode === 401) {
        await this.pool.query(
          'update private.app_sessions set revoked_at=clock_timestamp() where id_hash=$1',
          [id],
        );
        return null;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  async revoke(session: AppSession) {
    await this.pool.query(
      'update private.app_sessions set revoked_at=clock_timestamp() where id_hash=$1',
      [session.hash],
    );
  }
  async audit(event: string, requestId: string, userId?: string) {
    await this.pool.query(
      'insert into private.security_events(actor_id,event,request_id) values($1,$2,$3)',
      [userId ?? null, event, requestId],
    );
  }
  async recover(session: AppSession, password: string) {
    const tokens = session.tokens;
    if (session.purpose !== 'recovery' || !tokens)
      throw new IdentityFailure(403, 'RECOVERY_REQUIRED');
    const client = await this.pool.connect();
    try {
      // A session advisory lock spans the committed revocation and remote call.
      await client.query('select pg_advisory_lock(hashtextextended($1,0))', [tokens.userId]);
      await client.query('begin');
      await client.query(
        'insert into private.auth_guards(user_id,blocked) values($1,true) on conflict(user_id) do update set blocked=true,changed_at=clock_timestamp()',
        [tokens.userId],
      );
      await client.query(
        "update private.app_sessions set revoked_at=clock_timestamp() where user_id=$1 and purpose='application'",
        [tokens.userId],
      );
      await client.query('commit');
      await this.provider.request('/user', { password }, tokens.accessToken, 'PUT');
      await client.query('begin');
      await client.query(
        'update private.auth_guards set blocked=false,changed_at=clock_timestamp() where user_id=$1',
        [tokens.userId],
      );
      await client.query(
        'update private.app_sessions set revoked_at=clock_timestamp() where user_id=$1',
        [tokens.userId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      // Never return a connection with a session advisory lock to the pool.
      try {
        await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [tokens.userId]);
        client.release();
      } catch {
        client.release(true);
      }
    }
  }
}
