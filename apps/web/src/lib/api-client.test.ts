import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './api-client';
import { parseApiBaseUrl } from './env';

describe('typed API client', () => {
  it('uses a single public health contract and omits credentials', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: 'ok', service: 'leadops-api' })));
    const result = await createApiClient('https://api.example', fetcher).getHealth();
    expect(result.status).toBe('ok');
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://api.example/health'),
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        method: 'GET',
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it.each([
    { status: 'ok', service: 'wrong-api' },
    { status: 'ok', service: 'leadops-api', secret: 'unexpected' },
  ])('rejects malformed payloads instead of trusting TypeScript assertions', async (payload) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload)));
    await expect(createApiClient('https://api.example', fetcher).getHealth()).rejects.toMatchObject(
      { reason: 'invalid-response' },
    );
  });
  it('rejects non-JSON responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>error</html>'));
    await expect(createApiClient('https://api.example', fetcher).getHealth()).rejects.toMatchObject(
      { reason: 'invalid-response' },
    );
  });
  it('does not surface private server response text', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private internals', { status: 500 }));
    await expect(createApiClient('https://api.example', fetcher).getHealth()).rejects.toMatchObject(
      { reason: 'http', status: 500, message: 'The API is unavailable. Please try again.' },
    );
  });
  it('maps network failures to a safe error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private internals'));
    await expect(createApiClient('https://api.example', fetcher).getHealth()).rejects.toMatchObject(
      { reason: 'network', message: 'The API is unavailable. Please try again.' },
    );
  });
  it('honors caller cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(controller.signal.reason);
    await expect(
      createApiClient('https://api.example', fetcher).getHealth(controller.signal),
    ).rejects.toBe(controller.signal.reason);
  });
  it.each([
    '*',
    'javascript:alert(1)',
    'https://user:password@api.example',
    'https://api.example/path',
  ])('rejects unsafe public origins', (url) => {
    expect(() => parseApiBaseUrl(url)).toThrow('VITE_API_BASE_URL');
  });
});

it('bootstraps cookie sessions and binds mutations to the server-issued CSRF token', async () => {
  const session = {
    csrfToken: 'c'.repeat(43),
    purpose: 'anonymous',
    user: null,
    onboardingEnabled: true,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(session)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
  await createApiClient('https://api.example', fetcher).signIn({
    email: 'synthetic@example.test',
    password: 'synthetic-password-only',
  });
  expect(fetcher).toHaveBeenNthCalledWith(
    1,
    new URL('https://api.example/v1/auth/session'),
    expect.objectContaining({ credentials: 'include', cache: 'no-store', method: 'GET' }),
  );
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    new URL('https://api.example/v1/auth/sign-in'),
    expect.objectContaining({
      credentials: 'include',
      method: 'POST',
      headers: expect.objectContaining({ 'X-CSRF-Token': session.csrfToken }),
    }),
  );
});
it('rejects malformed identity responses before presenting authenticated content', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(JSON.stringify({ purpose: 'application', user: { id: 'forged' } })),
    );
  await expect(createApiClient('https://api.example', fetcher).getSession()).rejects.toMatchObject({
    reason: 'invalid-response',
  });
});
it('invalidates cached CSRF after cookie rotation and never automatically replays a rejected mutation', async () => {
  const session = {
    csrfToken: 'c'.repeat(43),
    purpose: 'anonymous',
    user: null,
    onboardingEnabled: true,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(session)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...session, csrfToken: 'd'.repeat(43) })))
    .mockResolvedValueOnce(new Response('private denial', { status: 403 }));
  const client = createApiClient('https://api.example', fetcher);
  await client.signIn({ email: 'synthetic@example.test', password: 'synthetic-password-only' });
  await expect(client.signOut()).rejects.toMatchObject({ status: 403 });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher).toHaveBeenLastCalledWith(
    new URL('https://api.example/v1/auth/sign-out'),
    expect.objectContaining({
      headers: expect.objectContaining({ 'X-CSRF-Token': 'd'.repeat(43) }),
    }),
  );
});
