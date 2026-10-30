import { healthResponseSchema, type HealthResponse } from '@leadops/shared';
import { apiBaseUrl, parseApiBaseUrl } from './env';

export class ApiClientError extends Error {
  constructor(
    public readonly reason: 'network' | 'http' | 'invalid-response',
    public readonly status?: number,
  ) {
    super(
      reason === 'invalid-response'
        ? 'The API returned an unexpected response.'
        : 'The API is unavailable. Please try again.',
    );
    this.name = 'ApiClientError';
  }
}
export function createApiClient(baseUrl: string, fetcher: typeof fetch = globalThis.fetch) {
  const origin = parseApiBaseUrl(baseUrl);
  return {
    async getHealth(signal?: AbortSignal): Promise<HealthResponse> {
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(5000);
        response = await fetcher(new URL('/health', origin), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          credentials: 'omit',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ApiClientError('network');
      }
      if (!response.ok) throw new ApiClientError('http', response.status);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ApiClientError('invalid-response');
      }
      const parsed = healthResponseSchema.safeParse(payload);
      if (!parsed.success) throw new ApiClientError('invalid-response');
      return parsed.data;
    },
  };
}
export const apiClient = createApiClient(apiBaseUrl);
