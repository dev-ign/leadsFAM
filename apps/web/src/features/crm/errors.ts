import { ApiClientError } from '../../lib/api-client';
export function crmMessage(error: unknown) {
  if (error instanceof ApiClientError) {
    const messages: Record<string, string> = {
      SOURCE_LIMIT: 'This workspace has reached the limit of 100 sources.',
      VERSION_CONFLICT:
        'Someone saved a newer version. Refresh the record and review your changes.',
      DUPLICATE_REVIEW_REQUIRED: 'Review the matching contacts before creating a separate record.',
      IDEMPOTENCY_CONFLICT:
        'This save belongs to different details. Check the saved result before starting again.',
      INVALID_CURSOR: 'This page has changed. Start again from the first page.',
      CONTACT_HAS_OPEN_LEADS: 'Close or archive this contact’s open leads first.',
      CLOSED_RECORD: 'Reopen this lead before editing it.',
      ARCHIVED_RECORD: 'Restore this record before editing it.',
      ARCHIVED_CONTACT: 'Restore the contact before restoring this lead.',
      INVALID_PHONE: 'Check the phone number and remove any extension.',
      INVALID_PHONE_REGION: 'Choose a valid two-letter country code.',
      DUPLICATE_CHANNEL: 'Use each email or phone number only once.',
      FORBIDDEN: 'You do not have permission for this action.',
      NOT_FOUND: 'This record is unavailable in your workspace.',
      INVALID_MANIFEST: 'Keep the original import row identities and row order when retrying.',
      DELIVERY_JOB_CONFLICT: 'This delivery belongs to another import job.',
    };
    const message = error.code ? messages[error.code] : undefined;
    if (message) return message;
    if (error.status === 400 || error.status === 422)
      return 'Check the required fields and their formatting.';
    if (error.status === 401) return 'Sign in again to continue.';
    if (error.status === 403) return 'You do not have permission for this action.';
    if (error.status === 404) return 'This record is unavailable in your workspace.';
  }
  return 'We could not complete the request. Please try again.';
}
export const uncertain = (error: unknown) =>
  error instanceof ApiClientError && (error.reason !== 'http' || (error.status ?? 500) >= 500);
