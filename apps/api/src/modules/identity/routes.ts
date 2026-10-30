import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { z } from 'zod';
import {
  credentialsSchema,
  signupSchema,
  emailRequestSchema,
  otpSchema,
  passwordRequestSchema,
} from '@leadops/shared';
import { matches, type SessionStore, type AppSession } from './sessions.js';
import { IdentityFailure } from './failure.js';

declare module 'fastify' {
  interface FastifyRequest {
    appSession: AppSession | null;
  }
}
export function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new IdentityFailure(400, 'INVALID_REQUEST');
  return result.data;
}
export function requireApplication(request: FastifyRequest) {
  const session = request.appSession;
  if (!session || session.purpose !== 'application' || !session.tokens)
    throw new IdentityFailure(401, 'SIGN_IN_REQUIRED');
  return { ...session, tokens: session.tokens };
}
export function registerIdentity(
  app: FastifyInstance,
  store: SessionStore,
  secure: boolean,
  origins: string[],
) {
  const cookieName = secure ? '__Host-leadsfam' : 'leadsfam-local';
  const cookie = (request: FastifyRequest) =>
    request.headers.cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  const setCookie = (reply: FastifyReply, value: string, maxAge = 43_200) =>
    reply.header(
      'set-cookie',
      `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
    );
  app.decorateRequest('appSession', null);
  app.addHook('preHandler', async (request) => {
    // No bearer-token shortcut: only opaque application cookies are accepted here.
    request.appSession = await store.load(cookie(request));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (!request.headers.origin || !origins.includes(request.headers.origin))
        throw new IdentityFailure(403, 'ORIGIN_REJECTED');
      if (request.headers['sec-fetch-site'] === 'cross-site')
        throw new IdentityFailure(403, 'ORIGIN_REJECTED');
      const csrf = request.headers['x-csrf-token'];
      if (
        typeof csrf !== 'string' ||
        !request.appSession ||
        !matches(csrf, request.appSession.csrf)
      )
        throw new IdentityFailure(403, 'CSRF_REJECTED');
    }
  });
  app.addHook('onError', async (request, _reply, error) => {
    if (error instanceof IdentityFailure && [401, 403].includes(error.statusCode)) {
      try {
        await store.audit('auth.denied', request.id, request.appSession?.tokens?.userId);
      } catch {
        request.log.error(
          { event: 'security_audit_failed' },
          'Could not persist authentication denial',
        );
      }
    }
  });
  app.get('/auth/session', async (request, reply) => {
    let session = request.appSession;
    if (!session) {
      const created = await store.create('anonymous', null);
      session = created.session;
      setCookie(reply, created.cookie, 900);
    }
    return {
      csrfToken: session.csrf,
      purpose: session.purpose,
      user: session.tokens ? { id: session.tokens.userId, email: session.tokens.email } : null,
      onboardingEnabled: store.config.onboardingEnabled,
    };
  });
  const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  app.post('/auth/sign-in', limited, async (request, reply) => {
    const input = validated(credentialsSchema, request.body),
      started = await store.clock();
    const tokens = await store.provider.tokens('/token?grant_type=password', input);
    const created = await store.create('application', tokens, request.appSession?.hash, started);
    setCookie(reply, created.cookie);
    await store.audit('auth.signed_in', request.id, tokens.userId);
    return { ok: true };
  });
  app.post('/auth/sign-up', limited, async (request) => {
    const { email, password, displayName } = validated(signupSchema, request.body);
    try {
      await store.provider.request('/signup', {
        email,
        password,
        data: { display_name: displayName },
      });
    } catch (error) {
      if (!(error instanceof IdentityFailure) || error.statusCode !== 401) throw error;
    }
    // Same response for an existing account; never return provider user details.
    return { ok: true };
  });
  app.post('/auth/verify-email', limited, async (request) => {
    const input = validated(otpSchema, request.body);
    const tokens = await store.provider.tokens('/verify', { ...input, type: 'email' });
    // Verification credentials never enroll as an ordinary application session.
    await store.provider.request('/logout?scope=local', undefined, tokens.accessToken);
    return { ok: true };
  });
  app.post('/auth/resend', limited, async (request) => {
    const input = validated(emailRequestSchema, request.body);
    try {
      await store.provider.request('/resend', { ...input, type: 'signup' });
    } catch (error) {
      if (!(error instanceof IdentityFailure) || error.statusCode !== 401) throw error;
    }
    return { ok: true };
  });
  app.post('/auth/forgot-password', limited, async (request) => {
    const input = validated(emailRequestSchema, request.body);
    try {
      await store.provider.request('/recover', input);
    } catch (error) {
      if (!(error instanceof IdentityFailure) || error.statusCode !== 401) throw error;
    }
    return { ok: true };
  });
  app.post('/auth/recovery', limited, async (request, reply) => {
    const input = validated(otpSchema, request.body);
    const tokens = await store.provider.tokens('/verify', { ...input, type: 'recovery' });
    const created = await store.create('recovery', tokens, request.appSession?.hash);
    setCookie(reply, created.cookie, 600);
    await store.audit('auth.recovery_started', request.id, tokens.userId);
    return { ok: true };
  });
  app.post('/auth/reset-password', limited, async (request, reply) => {
    const input = validated(passwordRequestSchema, request.body);
    if (!request.appSession) throw new IdentityFailure(403, 'RECOVERY_REQUIRED');
    await store.recover(request.appSession, input.password);
    setCookie(reply, '', 0);
    await store.audit('auth.password_recovered', request.id, request.appSession.tokens?.userId);
    return { ok: true };
  });
  app.post('/auth/sign-out', async (request, reply) => {
    const session = request.appSession;
    if (session) {
      await store.revoke(session); // Local revocation commits even if the provider is unavailable.
      if (session.tokens) {
        try {
          await store.provider.request(
            '/logout?scope=local',
            undefined,
            session.tokens.accessToken,
          );
        } catch {
          request.log.warn(
            { event: 'provider_logout_failed' },
            'Local session revoked; provider logout unavailable',
          );
        }
      }
      await store.audit('auth.signed_out', request.id, session.tokens?.userId);
    }
    setCookie(reply, '', 0);
    return { ok: true };
  });
}
