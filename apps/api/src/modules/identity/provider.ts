import { z } from 'zod';
import { IdentityFailure } from './failure.js';

const userSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  email_confirmed_at: z.string().nullable().optional(),
});
const tokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().optional(),
  expires_in: z.number(),
  user: userSchema,
});
export type Tokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  email: string;
  sessionId: string;
};
export class AuthProvider {
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetcher = globalThis.fetch,
  ) {}
  async request(
    path: string,
    body?: unknown,
    accessToken?: string,
    method = 'POST',
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.url}/auth/v1${path}`, {
        method,
        headers: {
          apikey: this.key,
          'content-type': 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch {
      throw new IdentityFailure(503, 'IDENTITY_UNAVAILABLE');
    }
    if (!response.ok) {
      if (response.status === 429) throw new IdentityFailure(429, 'RATE_LIMITED');
      if (response.status >= 500) throw new IdentityFailure(503, 'IDENTITY_UNAVAILABLE');
      throw new IdentityFailure(401, 'CREDENTIALS_REJECTED');
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') return null;
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new IdentityFailure(503, 'IDENTITY_UNAVAILABLE');
    }
  }
  async user(accessToken: string) {
    const parsed = userSchema.safeParse(await this.request('/user', undefined, accessToken, 'GET'));
    if (!parsed.success) throw new IdentityFailure(401, 'CREDENTIALS_REJECTED');
    return parsed.data;
  }
  async tokens(path: string, body: unknown): Promise<Tokens> {
    const parsed = tokensSchema.safeParse(await this.request(path, body));
    if (!parsed.success) throw new IdentityFailure(503, 'IDENTITY_UNAVAILABLE');
    const data = parsed.data;
    // This payload is used only AFTER the Auth server verifies the bearer token.
    const verified = await this.user(data.access_token);
    let claims: { session_id: string; sub: string };
    try {
      claims = z
        .object({ session_id: z.uuid(), sub: z.uuid() })
        .parse(
          JSON.parse(Buffer.from(data.access_token.split('.')[1] ?? '', 'base64url').toString()),
        );
    } catch {
      throw new IdentityFailure(401, 'CREDENTIALS_REJECTED');
    }
    if (verified.id !== data.user.id || claims.sub !== verified.id || !verified.email_confirmed_at)
      throw new IdentityFailure(401, 'CREDENTIALS_REJECTED');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + data.expires_in,
      userId: verified.id,
      email: verified.email,
      sessionId: claims.session_id,
    };
  }
}
