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
