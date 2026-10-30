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
  apiErrorSchema,
  contactSchema,
  contactPageSchema,
  leadSchema,
  leadPageSchema,
  activityPageSchema,
  sourceSchema,
  csvPreviewSchema,
  importResultSchema,
  importStatusSchema,
  importJobsSchema,
  type ContactInput,
  type LeadIntake,
  type CrmQuery,
  type csvPreviewInputSchema,
  type importSubmissionSchema,
  csvColumnsSchema,
} from '@leadops/shared';
import { z } from 'zod';
import { apiBaseUrl, parseApiBaseUrl } from './env';
const zArrayContacts = z.array(contactSchema).max(10),
  zArraySources = z.array(sourceSchema);

export class ApiClientError extends Error {
  constructor(
    public readonly reason: 'network' | 'http' | 'invalid-response',
    public readonly status?: number,
    public readonly code?: string,
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
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    if (method !== 'GET' && !csrfToken) await getSession(signal);
    let response: Response;
    try {
      response = await fetcher(new URL(`/v1${path}`, origin), {
        method,
        headers: {
          ...extraHeaders,
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
      let code: string | undefined;
      try {
        const parsed = apiErrorSchema.safeParse(await response.json());
        if (parsed.success && /^[A-Z_]{1,60}$/.test(parsed.data.error.code))
          code = parsed.data.error.code;
      } catch {
        /* The safe fallback does not echo provider response bodies. */
      }
      throw new ApiClientError('http', response.status, code);
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
  const queryString = (query: Record<string, unknown>) => {
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== null && value !== '') parameters.set(key, String(value));
    return parameters.size ? `?${parameters.toString()}` : '';
  };
  const resource = (id: string, kind: 'contacts' | 'leads', key: string) =>
    `${org(id)}/${kind}/${encodeURIComponent(key)}`;
  return {
    csvColumns: (id: string, csv: string) =>
      request(`${org(id)}/lead-imports/columns`, csvColumnsSchema, 'POST', { csv }),
    contacts: (id: string, query: Partial<CrmQuery> = {}, signal?: AbortSignal) =>
      request(
        `${org(id)}/contacts${queryString(query)}`,
        contactPageSchema,
        'GET',
        undefined,
        signal,
      ),
    leads: (id: string, query: Partial<CrmQuery> = {}, signal?: AbortSignal) =>
      request(`${org(id)}/leads${queryString(query)}`, leadPageSchema, 'GET', undefined, signal),
    contact: (id: string, key: string, signal?: AbortSignal) =>
      request(resource(id, 'contacts', key), contactSchema, 'GET', undefined, signal),
    lead: (id: string, key: string, signal?: AbortSignal) =>
      request(resource(id, 'leads', key), leadSchema, 'GET', undefined, signal),
    createContact: (id: string, input: ContactInput, key: string) =>
      request(`${org(id)}/contacts`, contactSchema, 'POST', input, undefined, {
        'Idempotency-Key': key,
      }),
    updateContact: (id: string, key: string, version: number, input: ContactInput) =>
      request(resource(id, 'contacts', key), contactSchema, 'PATCH', { version, contact: input }),
    candidates: (id: string, input: ContactInput, signal?: AbortSignal) =>
      request(`${org(id)}/contacts/candidates`, zArrayContacts, 'POST', input, signal),
    createLead: (id: string, input: LeadIntake, key: string) =>
      request(`${org(id)}/leads`, leadSchema, 'POST', input, undefined, { 'Idempotency-Key': key }),
    updateLead: (
      id: string,
      key: string,
      version: number,
      input: { title: string; description: string; priority: 'low' | 'normal' | 'high' },
    ) => request(resource(id, 'leads', key), leadSchema, 'PATCH', { version, lead: input }),
    transitionLead: (
      id: string,
      key: string,
      input: {
        version: number;
        status: 'in_progress' | 'qualified' | 'closed';
        outcome?: 'won' | 'lost' | 'unqualified';
        reason?: string;
      },
    ) => request(`${resource(id, 'leads', key)}/transitions`, leadSchema, 'POST', input),
    assignLead: (id: string, key: string, version: number, userId: string | null) =>
      request(`${resource(id, 'leads', key)}/assignee`, leadSchema, 'PUT', { version, userId }),
    archiveContact: (id: string, key: string, version: number, restore = false) =>
      request(
        `${resource(id, 'contacts', key)}/${restore ? 'restore' : 'archive'}`,
        contactSchema,
        'POST',
        { version },
      ),
    archiveLead: (id: string, key: string, version: number, restore = false) =>
      request(
        `${resource(id, 'leads', key)}/${restore ? 'restore' : 'archive'}`,
        leadSchema,
        'POST',
        { version },
      ),
    activity: (
      id: string,
      kind: 'contacts' | 'leads',
      key: string,
      query: { pageSize?: number; cursor?: string } = {},
      signal?: AbortSignal,
    ) =>
      request(
        `${resource(id, kind, key)}/activity${queryString(query)}`,
        activityPageSchema,
        'GET',
        undefined,
        signal,
      ),
    sources: (id: string, signal?: AbortSignal) =>
      request(`${org(id)}/lead-sources`, zArraySources, 'GET', undefined, signal),
    createSource: (id: string, input: { name: string; archived: boolean }) =>
      request(`${org(id)}/lead-sources`, sourceSchema, 'POST', input),
    updateSource: (
      id: string,
      key: string,
      version: number,
      input: { name: string; archived: boolean },
    ) =>
      request(`${org(id)}/lead-sources/${encodeURIComponent(key)}`, sourceSchema, 'PATCH', {
        version,
        source: input,
      }),
    previewCsv: (id: string, input: z.input<typeof csvPreviewInputSchema>, signal?: AbortSignal) =>
      request(`${org(id)}/lead-imports/preview`, csvPreviewSchema, 'POST', input, signal),
    executeImport: (id: string, input: z.input<typeof importSubmissionSchema>) =>
      request(`${org(id)}/lead-imports`, importResultSchema, 'POST', input),
    importJobs: (id: string, signal?: AbortSignal) =>
      request(`${org(id)}/lead-imports`, importJobsSchema, 'GET', undefined, signal),
    importStatus: (id: string, job: string, signal?: AbortSignal) =>
      request(
        `${org(id)}/lead-imports/${encodeURIComponent(job)}`,
        importStatusSchema,
        'GET',
        undefined,
        signal,
      ),
    importAttempt: (id: string, job: string, attempt: string, signal?: AbortSignal) =>
      request(
        `${org(id)}/lead-imports/${encodeURIComponent(job)}/attempts/${encodeURIComponent(attempt)}`,
        importResultSchema,
        'GET',
        undefined,
        signal,
      ),
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
