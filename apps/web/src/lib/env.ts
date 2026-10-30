export function parseApiBaseUrl(value: string | undefined): string {
  const candidate = value ?? 'http://127.0.0.1:3001';
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== candidate) throw new Error();
    return url.origin;
  } catch {
    throw new Error('Invalid public configuration: VITE_API_BASE_URL must be an HTTP(S) origin.');
  }
}
export const apiBaseUrl = parseApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
