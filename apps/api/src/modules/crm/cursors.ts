import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { IdentityFailure } from '../identity/failure.js';

export const positionSchema = z.strictObject({
  time: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});
const payloadSchema = z.strictObject({
  v: z.literal(1),
  org: z.uuid(),
  user: z.uuid(),
  kind: z.string().max(80),
  query: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expires: z.int().positive(),
  position: positionSchema,
});
interface Scope {
  org: string;
  user: string;
  kind: string;
  query: Record<string, unknown>;
}
export class CursorCodec {
  private readonly key: Buffer;
  constructor(
    key: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32) throw new Error('Invalid cursor configuration');
  }
  private mac(domain: string, value: string) {
    return createHmac('sha256', this.key).update(domain).update(value).digest();
  }
  private query(scope: Scope) {
    return this.mac(
      'query:',
      JSON.stringify(
        Object.fromEntries(Object.entries(scope.query).sort(([a], [b]) => a.localeCompare(b))),
      ),
    ).toString('base64url');
  }
  encode(scope: Scope, position: z.infer<typeof positionSchema>) {
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        org: scope.org,
        user: scope.user,
        kind: scope.kind,
        query: this.query(scope),
        expires: this.now() + 30 * 60 * 1000,
        position,
      }),
    ).toString('base64url');
    return `${body}.${this.mac('cursor:', body).toString('base64url')}`;
  }
  decode(scope: Scope, token: string) {
    try {
      if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))
        throw new Error();
      const [body = '', signature = ''] = token.split('.'),
        supplied = Buffer.from(signature, 'base64url'),
        expected = this.mac('cursor:', body);
      if (
        supplied.length !== 32 ||
        supplied.toString('base64url') !== signature ||
        !timingSafeEqual(supplied, expected)
      )
        throw new Error();
      const bytes = Buffer.from(body, 'base64url');
      if (bytes.toString('base64url') !== body) throw new Error();
      const value = payloadSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (
        value.org !== scope.org ||
        value.user !== scope.user ||
        value.kind !== scope.kind ||
        value.query !== this.query(scope) ||
        value.expires <= this.now() ||
        value.expires > this.now() + 30 * 60 * 1000
      )
        throw new Error();
      return value.position;
    } catch {
      throw new IdentityFailure(400, 'INVALID_CURSOR');
    }
  }
}
