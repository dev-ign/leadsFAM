import { z } from 'zod';

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
}

// Errors name the invalid fields, never the supplied environment values.
export function parseEnv(environment: Record<string, string | undefined>): AppConfig {
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
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigins: [...new Set(origins)],
  };
}
