import {
  healthResponseSchema,
  sessionSchema,
  organizationSchema,
  organizationsSchema,
  membersSchema,
  invitationsSchema,
  invitationCreatedSchema,
  noteSchema,
  notesSchema,
  okSchema,
  type HealthResponse,
} from '@leadops/shared';
import type { z } from 'zod';
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
  let csrfToken: string | undefined;
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (method !== 'GET' && !csrfToken) await getSession(signal);
    let response: Response;
    try {
      response = await fetcher(new URL(`/v1${path}`, origin), {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrfToken ?? '' }),
        },
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiClientError('network');
    }
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('leadsfam-session-expired'));
      throw new ApiClientError('http', response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiClientError('invalid-response');
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new ApiClientError('invalid-response');
    return parsed.data;
  }
  async function getSession(signal?: AbortSignal) {
    const session = await request('/auth/session', sessionSchema, 'GET', undefined, signal);
    csrfToken = session.csrfToken;
    return session;
  }
  const auth = async (path: string, body: unknown) => {
    const result = await request(`/auth/${path}`, okSchema, 'POST', body);
    csrfToken = undefined;
    return result;
  };
  const org = (id: string) => `/organizations/${encodeURIComponent(id)}`;
  return {
    getSession,
    signIn: (input: { email: string; password: string }) => auth('sign-in', input),
    signUp: (input: { email: string; password: string; displayName: string }) =>
      auth('sign-up', input),
    verifyEmail: (input: { email: string; token: string }) => auth('verify-email', input),
    resend: (email: string) => auth('resend', { email }),
    forgotPassword: (email: string) => auth('forgot-password', { email }),
    beginRecovery: (input: { email: string; token: string }) => auth('recovery', input),
    resetPassword: (password: string) => auth('reset-password', { password }),
    signOut: () => auth('sign-out', {}),
    organizations: (signal?: AbortSignal) =>
      request('/organizations', organizationsSchema, 'GET', undefined, signal),
    createOrganization: (name: string) =>
      request('/organizations', organizationSchema, 'POST', { name }),
    organization: (id: string, signal?: AbortSignal) =>
      request(org(id), organizationSchema, 'GET', undefined, signal),
    renameOrganization: (id: string, name: string) =>
      request(org(id), organizationSchema, 'PATCH', { name }),
    members: (id: string, signal?: AbortSignal) =>
      request(`${org(id)}/members`, membersSchema, 'GET', undefined, signal),
    changeMember: (id: string, user: string, role: 'admin' | 'member') =>
      request(`${org(id)}/members/${encodeURIComponent(user)}`, okSchema, 'PATCH', { role }),
    removeMember: (id: string, user: string) =>
      request(`${org(id)}/members/${encodeURIComponent(user)}`, okSchema, 'DELETE'),
    invitations: (id: string, signal?: AbortSignal) =>
      request(`${org(id)}/invitations`, invitationsSchema, 'GET', undefined, signal),
    invite: (id: string, email: string, role: 'admin' | 'member') =>
      request(`${org(id)}/invitations`, invitationCreatedSchema, 'POST', { email, role }),
    revokeInvitation: (id: string, invitation: string) =>
      request(`${org(id)}/invitations/${encodeURIComponent(invitation)}`, okSchema, 'DELETE'),
    acceptInvitation: (token: string) =>
      request('/invitations/accept', organizationSchema, 'POST', { token }),
    notes: (id: string, signal?: AbortSignal) =>
      request(`${org(id)}/notes`, notesSchema, 'GET', undefined, signal),
    writeNote: (id: string, input: { title: string; body: string }, noteId?: string) =>
      request(
        `${org(id)}/notes${noteId ? `/${encodeURIComponent(noteId)}` : ''}`,
        noteSchema,
        noteId ? 'PATCH' : 'POST',
        input,
      ),
    deleteNote: (id: string, noteId: string) =>
      request(`${org(id)}/notes/${encodeURIComponent(noteId)}`, okSchema, 'DELETE'),
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
