import { ApiClientError } from '../../lib/api-client';
export function identityMessage(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.status === 401)
      return 'Your session or credentials could not be verified. Please sign in again.';
    if (error.status === 403)
      return 'You do not have permission, or your form expired. Refresh and try again.';
    if (error.status === 404) return 'This workspace, record or invitation is unavailable.';
    if (error.status === 409)
      return 'This change conflicts with the current state. Owners cannot be removed.';
    if (error.status === 400) return 'Check the form and try again.';
    if (error.status === 429) return 'Too many attempts. Please wait before trying again.';
  }
  return 'We could not complete the request. Please try again.';
}
