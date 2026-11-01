import { ApiClientError } from '../../lib/api-client';
import { crmMessage } from '../crm/errors';
export function communicationReason(code: string | null) {
  return (
    (
      {
        CONSENT_REQUIRED:
          'Record explicit permission for this destination, channel and purpose before sending.',
        DESTINATION_SUPPRESSED:
          'This destination is blocked. Opt-outs and bounced destinations require a separate review.',
        CONTACT_UNAVAILABLE: 'Restore the contact before sending.',
        RECIPIENT_CHANGED:
          'The destination is not on this contact. Choose a current email or international phone number.',
        JURISDICTION_REVIEW_REQUIRED:
          'This jurisdiction needs a policy review. Sending is blocked.',
        AUTHORITY_REVOKED:
          'The approving administrator no longer has authority. This message was blocked.',
        DAILY_LIMIT:
          'The workspace, channel or recipient daily limit was reached. This message was blocked.',
        SUBMISSION_UNKNOWN:
          'The submission outcome needs attention. Check delivery status before considering another message.',
        ATTEMPTS_EXHAUSTED:
          'The processing attempt limit was reached. Review the message and check delivery status.',
        PROVIDER_REJECTED: 'The mock provider rejected this message.',
        DESTINATION_BOUNCED: 'The mock destination bounced and is now blocked.',
      } as Record<string, string>
    )[code ?? ''] ??
    (code
      ? 'This message needs administrator review.'
      : 'Eligible under the explicit-permission mock policy.')
  );
}
export function communicationError(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.code === 'RECIPIENT_INELIGIBLE')
      return 'This recipient cannot receive this message. Check permission and blocked-destination status.';
    if (error.code === 'SENDING_PAUSED')
      return 'Sending is paused. Open communication settings to enable mock sending.';
    if (error.code === 'SUPPRESSION_REVIEW_REQUIRED')
      return 'An opt-out or bounce cannot be removed here. A separate repermission review is required.';
  }
  return crmMessage(error);
}
