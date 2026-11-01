import { z } from 'zod';
import type { IdentityConfig } from '../modules/identity/sessions.js';

const originSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}, 'Use an exact HTTP(S) origin without a path or credentials');
const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.enum(['127.0.0.1', '0.0.0.0', '::1', '::']).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().optional(),
});
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: z.infer<typeof environmentSchema>['LOG_LEVEL'];
  corsOrigins: string[];
  identity?: IdentityConfig;
  crmCursorKey?: string;
  ingressDatabaseUrl?: string;
  mockWebhookSecret?: string;
}

// Errors name the invalid fields, never the supplied environment values.
export function parseEnv(environment: Record<string, string | undefined>): AppConfig {
  const mockWebhookSecret = parseCommunicationEnv(environment);
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid server configuration: ${fields.join(', ')}`);
  }
  const env = result.data;
  if (env.NODE_ENV === 'production' && !env.CORS_ORIGINS) {
    throw new Error('Invalid server configuration: CORS_ORIGINS is required in production');
  }
  const origins = (env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim());
  if (origins.length === 0 || origins.some((origin) => !originSchema.safeParse(origin).success)) {
    throw new Error(
      'Invalid server configuration: CORS_ORIGINS must contain exact HTTP(S) origins',
    );
  }
  if (env.NODE_ENV === 'production' && origins.some((origin) => !origin.startsWith('https://'))) {
    throw new Error('Invalid server configuration: production CORS_ORIGINS must use HTTPS');
  }
  let identity: IdentityConfig | undefined;
  if (environment.SUPABASE_URL || environment.SESSION_DATABASE_URL || environment.SESSION_KEYS) {
    const parsed = z
      .object({
        SUPABASE_URL: z.url(),
        SUPABASE_PUBLIC_KEY: z.string().min(20),
        SESSION_DATABASE_URL: z.url(),
        SESSION_ACTIVE_KEY: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
        SESSION_KEYS: z.string(),
        ALLOW_ORG_CREATION: z.enum(['true', 'false']).default('false'),
      })
      .safeParse(environment);
    if (!parsed.success) throw new Error('Invalid server configuration: identity fields');
    const values = parsed.data;
    let keys: Record<string, string>;
    try {
      keys = z
        .record(
          z.string(),
          z
            .string()
            .refine(
              (v) => /^[A-Za-z0-9+/]{43}=$/.test(v) && Buffer.from(v, 'base64').length === 32,
            ),
        )
        .parse(JSON.parse(values.SESSION_KEYS));
    } catch {
      throw new Error('Invalid server configuration: SESSION_KEYS');
    }
    const providerURL = new URL(values.SUPABASE_URL),
      databaseURL = new URL(values.SESSION_DATABASE_URL);
    let publicKeyValid = values.SUPABASE_PUBLIC_KEY.startsWith('sb_publishable_');
    if (!publicKeyValid) {
      try {
        const claims = JSON.parse(
          Buffer.from(values.SUPABASE_PUBLIC_KEY.split('.')[1] ?? '', 'base64url').toString(),
        ) as { role?: unknown };
        publicKeyValid = claims.role === 'anon';
      } catch {
        publicKeyValid = false;
      }
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'];
    if (
      !publicKeyValid ||
      !keys[values.SESSION_ACTIVE_KEY] ||
      providerURL.username ||
      providerURL.password ||
      providerURL.pathname !== '/' ||
      providerURL.search ||
      providerURL.hash ||
      !['http:', 'https:'].includes(providerURL.protocol) ||
      !['postgres:', 'postgresql:'].includes(databaseURL.protocol) ||
      (!loopback.includes(providerURL.hostname) && providerURL.protocol !== 'https:') ||
      (env.NODE_ENV === 'production' &&
        (providerURL.protocol !== 'https:' ||
          loopback.includes(providerURL.hostname) ||
          databaseURL.searchParams.get('sslmode') !== 'verify-full' ||
          values.ALLOW_ORG_CREATION === 'true'))
    )
      throw new Error('Invalid server configuration: identity security settings');
    identity = {
      url: providerURL.origin,
      publicKey: values.SUPABASE_PUBLIC_KEY,
      databaseUrl: values.SESSION_DATABASE_URL,
      activeKey: values.SESSION_ACTIVE_KEY,
      keys,
      onboardingEnabled: values.ALLOW_ORG_CREATION === 'true',
    };
  }
  if (env.NODE_ENV === 'production' && !identity)
    throw new Error('Invalid server configuration: identity is required in production');
  if (mockWebhookSecret && Object.values(identity?.keys ?? {}).includes(mockWebhookSecret))
    throw new Error('Invalid communication configuration: separate signing key required');
  const crmCursorKey = environment.CRM_CURSOR_KEY;
  if (
    (crmCursorKey !== undefined &&
      (!/^[A-Za-z0-9+/]{43}=$/.test(crmCursorKey) ||
        Buffer.from(crmCursorKey, 'base64').length !== 32 ||
        Object.values(identity?.keys ?? {}).includes(crmCursorKey))) ||
    (env.NODE_ENV === 'production' && !crmCursorKey)
  )
    throw new Error('Invalid server configuration: CRM_CURSOR_KEY');
  const ingressDatabaseUrl = environment.INGRESS_DATABASE_URL;
  if (ingressDatabaseUrl) {
    let url: URL;
    try {
      url = new URL(ingressDatabaseUrl);
    } catch {
      throw new Error('Invalid server configuration: INGRESS_DATABASE_URL');
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      (env.NODE_ENV === 'production' && url.searchParams.get('sslmode') !== 'verify-full')
    )
      throw new Error('Invalid server configuration: INGRESS_DATABASE_URL');
  }
  return {
    ...(ingressDatabaseUrl ? { ingressDatabaseUrl } : {}),
    ...(mockWebhookSecret ? { mockWebhookSecret } : {}),
    ...(crmCursorKey ? { crmCursorKey } : {}),
    ...(identity ? { identity } : {}),
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigins: [...new Set(origins)],
  };
}

export function parseWorkerEnv(environment: Record<string, string | undefined>): string {
  parseCommunicationEnv(environment);
  try {
    const connection = environment.WORKER_DATABASE_URL;
    const mode = environment.NODE_ENV ?? 'development';
    if (!connection || !['development', 'test', 'production'].includes(mode)) throw new Error();
    const url = new URL(connection);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      (mode === 'production' && url.searchParams.get('sslmode') !== 'verify-full')
    )
      throw new Error();
    return connection;
  } catch {
    // URL errors can include their raw input; never let credentials reach logs.
    throw new Error('Invalid worker configuration: WORKER_DATABASE_URL');
  }
}

// No real adapter is installed. Unsupported enablement must fail even in development.
export function parseCommunicationEnv(
  environment: Record<string, string | undefined>,
): string | undefined {
  if (
    (environment.COMMUNICATIONS_MODE !== undefined && environment.COMMUNICATIONS_MODE !== 'mock') ||
    (environment.OUTBOUND_LIVE_ENABLED !== undefined &&
      environment.OUTBOUND_LIVE_ENABLED !== 'false')
  )
    throw new Error('Invalid communication configuration: live sending is unavailable');
  const secret = environment.MOCK_WEBHOOK_SECRET;
  if (
    secret !== undefined &&
    (!/^[A-Za-z0-9+/]{43}=$/.test(secret) || Buffer.from(secret, 'base64').length !== 32)
  )
    throw new Error('Invalid communication configuration: MOCK_WEBHOOK_SECRET');
  return secret;
}
