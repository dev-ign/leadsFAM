import type { Database } from './database.types.js';

type Functions = Database['public']['Functions'];
const reasons = new Set([
  'unauthenticated',
  'not_found',
  'invitation_invalid',
  'forbidden',
  'onboarding_disabled',
  'email_unverified',
  'last_owner',
  'already_member',
  'version_conflict',
  'idempotency_conflict',
  'duplicate_review_required',
  'archived_record',
  'closed_record',
  'invalid_transition',
  'contact_has_open_leads',
  'archived_contact',
  'reopen_reason_required',
  'invalid_fields',
  'invalid_channels',
  'invalid_resolution',
  'delivery_job_conflict',
  'invalid_manifest',
  'source_limit',
]);
export class DatabaseRpcFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    public readonly sqlCode: string,
  ) {
    super('Database request failed');
    this.name = 'DatabaseRpcFailure';
  }
}
// A public project key identifies the API, while the verified user's JWT carries
// identity. There is deliberately no service key or administrator connection.
export class UserDatabase {
  constructor(private readonly config: { url: string; publicKey: string }) {}
  async rpc<N extends keyof Functions>(
    token: string,
    name: N,
    args: Functions[N]['Args'],
    requestId: string,
  ): Promise<unknown> {
    let response: Response;
    let result: unknown;
    try {
      response = await fetch(`${this.config.url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          apikey: this.config.publicKey,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-request-id': requestId,
        },
        body: JSON.stringify(args),
      });
      result = (await response.json()) as unknown;
    } catch {
      throw new DatabaseRpcFailure(503, '', '');
    }
    if (!response.ok) {
      const data = result as { message?: unknown; code?: unknown } | null;
      throw new DatabaseRpcFailure(
        response.status,
        typeof data?.message === 'string' && reasons.has(data.message) ? data.message : '',
        typeof data?.code === 'string' && /^[A-Z0-9]{5}$/.test(data.code) ? data.code : '',
      );
    }
    return result;
  }
}
