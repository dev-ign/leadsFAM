import { describe, expect, it } from 'vitest';
import { CursorCodec } from '../src/modules/crm/cursors.js';
describe('cursor integrity and scope', () => {
  const scope = {
    org: '11111111-1111-4111-8111-111111111111',
    user: '22222222-2222-4222-8222-222222222222',
    kind: 'leads',
    query: { q: 'Confidential prospect', sort: 'created', pageSize: 25 },
  };
  const position = {
    time: '2026-10-30T01:02:03.123456+00:00',
    id: '33333333-3333-4333-8333-333333333333',
  };
  it('preserves database timestamp precision without embedding the search input', () => {
    const codec = new CursorCodec(Buffer.alloc(32, 3).toString('base64')),
      token = codec.encode(scope, position);
    expect(codec.decode(scope, token)).toEqual(position);
    expect(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()).not.toContain(
      'Confidential',
    );
  });
  it('rejects query, ordering, organization, user, entity and signature changes', () => {
    const codec = new CursorCodec(Buffer.alloc(32, 3).toString('base64')),
      token = codec.encode(scope, position);
    for (const changed of [
      { ...scope, org: position.id },
      { ...scope, user: position.id },
      { ...scope, kind: 'contacts' },
      { ...scope, query: { ...scope.query, q: 'Changed' } },
      { ...scope, query: { ...scope.query, sort: 'activity' } },
      { ...scope, query: { ...scope.query, pageSize: 100 } },
    ])
      expect(() => codec.decode(changed, token)).toThrow('INVALID_CURSOR');
    expect(() => codec.decode(scope, `${token.slice(0, -2)}aa`)).toThrow('INVALID_CURSOR');
    expect(() =>
      new CursorCodec(Buffer.alloc(32, 4).toString('base64')).decode(scope, token),
    ).toThrow('INVALID_CURSOR');
  });
  it('rejects expired, malformed and oversized tokens and invalid position types', () => {
    let now = 1000;
    const codec = new CursorCodec(Buffer.alloc(32, 3).toString('base64'), () => now),
      token = codec.encode(scope, position);
    now += 1800000;
    expect(() => codec.decode(scope, token)).toThrow('INVALID_CURSOR');
    for (const token of [
      '',
      '{}',
      'a.b.c',
      'x'.repeat(2049),
      codec.encode(scope, { ...position, time: 'infinity' }),
    ])
      expect(() => codec.decode(scope, token)).toThrow('INVALID_CURSOR');
  });
});
