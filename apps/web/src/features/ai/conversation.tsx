import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@leadops/ui';
import { can, type ConversationRecommendation } from '@leadops/shared';
import { apiClient, ApiClientError } from '../../lib/api-client';
import { useOrganization } from '../organizations/context';
import { useQuery } from '../crm/use-query';
import { useDrafts } from '../crm/draft-context';
import { communicationError } from '../communications/errors';

const labels = {
  ASK_FOR_INFORMATION: 'Ask for missing information',
  PREPARE_FOLLOW_UP: 'Prepare a follow-up',
  HUMAN_ATTENTION: 'Business owner attention needed',
  NO_ACTION: 'No supported next action',
};
const explanations = {
  ASK_FOR_INFORMATION:
    'Some details are still unknown. Review the evidence and questions before preparing a follow-up.',
  PREPARE_FOLLOW_UP:
    'The reviewed inquiry may benefit from a follow-up. Check the proposed wording before preparing a draft.',
  HUMAN_ATTENTION:
    'The inquiry is unclear, conflicting, urgent, unsupported or needs a personal decision. Review it before taking further action.',
  NO_ACTION: 'The available qualification does not justify another application action.',
};
const missingLabels: Record<string, string> = {
  service: 'Requested service',
  scope: 'Scope of work',
  location: 'Service location',
  timeframe: 'Preferred timeframe',
  contact_preference: 'Contact preference',
};
function failure(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.code === 'STALE_RECOMMENDATION')
      return 'The conversation or business settings changed. Refresh and evaluate the latest reply.';
    if (error.code === 'ORCHESTRATION_SIMULATION_REQUIRED')
      return 'Enable simulation in workspace AI settings before evaluating replies. Real AI is not enabled for this workflow.';
    if (error.code === 'CONVERSATION_INELIGIBLE')
      return 'This conversation needs a correctly linked, recent incoming reply first.';
    if (error.code === 'VERSION_CONFLICT')
      return 'Another decision changed this recommendation. Refresh before reviewing it.';
  }
  return communicationError(error);
}
export function ConversationNextAction({ conversationId }: { conversationId: string }) {
  const { organization } = useOrganization();
  const { store } = useDrafts();
  const [cursor, setCursor] = useState<string | undefined>();
  const load = useCallback(
    (signal: AbortSignal) =>
      apiClient.conversationRecommendations(organization.id, conversationId, cursor, signal),
    [organization.id, conversationId, cursor],
  );
  const { state, refresh } = useQuery(`recommendations:${conversationId}:${cursor}`, load);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState<ConversationRecommendation | null>(null),
    [notice, setNotice] = useState('');
  const pending = useRef<{ source: string; id: string } | null>(null);
  const polls = useRef(0),
    status = useRef<HTMLParagraphElement>(null),
    errorStatus = useRef<HTMLParagraphElement>(null),
    confirmButton = useRef<HTMLButtonElement>(null),
    prepareButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (confirm) confirmButton.current?.focus();
  }, [confirm]);
  const evaluating =
    state.status === 'ready' && state.data.items.some((r) => r.state === 'evaluating');
  useEffect(() => {
    if (!evaluating || polls.current >= 20 || document.visibilityState !== 'visible') return;
    const timer = setTimeout(() => {
      polls.current++;
      refresh();
    }, 3000);
    return () => clearTimeout(timer);
  }, [evaluating, refresh, state.status]);
  useEffect(() => {
    if (notice) status.current?.focus();
  }, [notice]);
  useEffect(() => {
    if (error) errorStatus.current?.focus();
  }, [error]);
  async function perform(operation: () => Promise<ConversationRecommendation>, message: string) {
    if (busy) return;
    const token = store.token(organization.id);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
      if (store.visible(token)) {
        setConfirm(null);
        setNotice(message);
        refresh();
      }
    } catch (caught) {
      if (store.visible(token)) {
        setError(failure(caught));
        setConfirm(null);
        refresh();
      }
    } finally {
      if (store.visible(token)) setBusy(false);
    }
  }
  function review(
    r: ConversationRecommendation,
    decision: 'accept' | 'dismiss' | 'defer' | 'prepare',
  ) {
    void perform(
      () => apiClient.reviewRecommendation(organization.id, r.id, { version: r.version, decision }),
      decision === 'prepare'
        ? 'Draft prepared. It remains unapproved; open it to edit, save and separately approve.'
        : decision === 'defer'
          ? 'Deferred for a later human review. Nothing is scheduled.'
          : 'Decision recorded. No message was sent.',
    );
  }
  return (
    <section
      aria-labelledby="next-action-title"
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4"
    >
      <h3 id="next-action-title" className="text-xl font-semibold">
        Suggested next action
      </h3>
      <p className="text-sm">
        Simulation only. Evaluate intentionally; receiving a reply does not run AI or prepare a
        message. All communication needs separate human approval.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={busy} onClick={refresh}>
          Refresh next actions
        </Button>
        {state.status === 'ready' &&
          state.data.eligible &&
          state.data.sourceVersion &&
          can(organization.role, 'crm_write') && (
            <Button
              disabled={busy || evaluating}
              onClick={() => {
                const source = state.data.sourceVersion!;
                if (pending.current?.source !== source)
                  pending.current = { source, id: crypto.randomUUID() };
                polls.current = 0;
                void perform(async () => {
                  const result = await apiClient.evaluateConversation(
                    organization.id,
                    pending.current!.id,
                    { conversationId, sourceVersion: source },
                  );
                  pending.current = null;
                  return result;
                }, 'Evaluation requested. The existing worker will process this simulation.');
              }}
            >
              {evaluating ? 'Evaluating reply…' : 'Evaluate latest reply (simulation)'}
            </Button>
          )}
      </div>
      {notice && (
        <p ref={status} role="status" tabIndex={-1}>
          {notice}
        </p>
      )}
      {busy && <p role="status">Saving your request…</p>}
      {error && (
        <p ref={errorStatus} role="alert" tabIndex={-1}>
          {error}
        </p>
      )}
      {state.status === 'loading' ? (
        <p role="status">Loading suggested actions…</p>
      ) : state.status === 'error' ? (
        <div role="alert">
          <p>{failure(state.error)}</p>
          <Button variant="outline" onClick={refresh}>
            Try next actions again
          </Button>
        </div>
      ) : (
        <>
          {!state.data.eligible && (
            <p>
              {state.data.reason === 'RECENT_CONTEXT_REQUIRED'
                ? 'This reply is outside the recent six-message context. Review the most recent conversation or use the lead’s manual analysis.'
                : state.data.reason === 'LEAD_UNAVAILABLE'
                  ? 'Evaluation needs an active customer and lead plus saved AI simulation settings. Review the lead and workspace AI setup.'
                  : 'No verified incoming reply is available in this conversation. Unmatched replies remain under Needs Review.'}
            </p>
          )}
          {state.data.eligible && !state.data.items.length && (
            <p>
              A linked customer reply is ready for your review. No evaluation has been requested.
            </p>
          )}
          <ol className="space-y-4">
            {state.data.items.map((r) => (
              <li key={r.id} className="min-w-0 space-y-3 rounded-lg border border-border p-4">
                <p className="font-semibold">
                  {r.kind ? labels[r.kind] : 'Evaluating the reply'} ·{' '}
                  {r.state.replaceAll('_', ' ')}
                </p>
                <p className="text-sm">
                  Simulation · {new Date(r.created_at).toLocaleString()} · Business knowledge
                  version {r.knowledge_version}
                </p>
                {r.stale ? (
                  <p role="status">
                    The conversation or approved business settings changed. This suggestion cannot
                    prepare a new draft. Evaluate the latest reply.
                  </p>
                ) : (
                  r.kind && <p>{explanations[r.kind]}</p>
                )}
                {r.state === 'evaluating' && (
                  <p role="status">
                    Waiting for the existing AI worker. You can return later; the request is saved.
                  </p>
                )}
                {r.state === 'failed' && (
                  <p role="status">
                    Evaluation did not complete. No action was taken. Inspect the AI request on the
                    lead before intentionally retrying.
                  </p>
                )}
                {r.reviewed_at && (
                  <p className="text-sm">
                    Last human decision:{' '}
                    {r.decision === 'prepare' ? 'Prepared unapproved draft' : r.decision} ·{' '}
                    {new Date(r.reviewed_at).toLocaleString()}
                  </p>
                )}
                {r.evaluation.result && (
                  <details className="space-y-3">
                    <summary className="cursor-pointer py-2 underline">
                      Review explanation, evidence and proposed wording
                    </summary>
                    <p>{r.evaluation.result.reasoning}</p>
                    <p>Missing information remains unknown:</p>
                    <ul>
                      {[
                        ...new Set([
                          ...r.evaluation.result.analysis.missing.map((v) => missingLabels[v] ?? v),
                          ...(r.evaluation.result.grounding?.questions ?? []),
                        ]),
                      ].map((v) => (
                        <li key={v}>{v}</li>
                      ))}
                    </ul>
                    <p>Attributed customer evidence:</p>
                    <ul>
                      {[
                        r.evaluation.result.analysis.intent,
                        r.evaluation.result.analysis.service,
                        r.evaluation.result.analysis.location,
                        r.evaluation.result.analysis.timeframe,
                        ...(r.evaluation.result.analysis.requirements ?? []),
                      ]
                        .filter((v) => v !== null)
                        .map((v, index) => (
                          <li className="break-words" key={index}>
                            “{v.quote}” ·{' '}
                            {v.source.startsWith('conversation.')
                              ? 'Received conversation message'
                              : 'Original lead inquiry'}
                          </li>
                        ))}
                    </ul>
                    <p className="text-sm">
                      Evidence references are retained with this evaluation; they are observations,
                      not verified CRM facts.
                    </p>
                    {r.evaluation.result.proposal && (
                      <div className="space-y-2">
                        <p className="font-medium">Proposed wording · not a saved message</p>
                        <p className="break-words">{r.evaluation.result.proposal.subject}</p>
                        <p className="whitespace-pre-wrap break-words">
                          {r.evaluation.result.proposal.body}
                        </p>
                      </div>
                    )}
                  </details>
                )}
                {r.message_id && (
                  <Link
                    className="inline-block underline"
                    to={`/organizations/${organization.id}/communications/compose?contactId=${r.contact_id}&leadId=${r.lead_id}&messageId=${r.message_id}`}
                  >
                    Open saved message
                  </Link>
                )}
                {!r.stale && can(organization.role, 'crm_write') && (
                  <div className="flex flex-wrap gap-3">
                    {['pending_review', 'deferred'].includes(r.state) && (
                      <>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => review(r, 'accept')}
                        >
                          Accept recommendation only
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => review(r, 'dismiss')}
                        >
                          Dismiss recommendation
                        </Button>
                        {r.state !== 'deferred' && (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => review(r, 'defer')}
                          >
                            Defer recommendation
                          </Button>
                        )}
                      </>
                    )}
                    {['pending_review', 'deferred', 'accepted'].includes(r.state) &&
                      !r.message_id &&
                      ['ASK_FOR_INFORMATION', 'PREPARE_FOLLOW_UP'].includes(r.kind ?? '') && (
                        <Button
                          disabled={busy}
                          onClick={(event) => {
                            prepareButton.current = event.currentTarget;
                            setConfirm(r);
                          }}
                        >
                          Prepare follow-up draft
                        </Button>
                      )}
                  </div>
                )}
                {confirm?.id === r.id && (
                  <div
                    role="group"
                    aria-label="Confirm follow-up preparation"
                    className="space-y-3 rounded-lg border border-border p-3"
                  >
                    <p>
                      Accept this exact recommendation and save its proposed wording as an
                      unapproved draft to this reply’s saved customer address. Permission and
                      suppression are checked. You will edit and separately approve the saved
                      version; nothing is sent now.
                    </p>
                    <Button
                      ref={confirmButton}
                      disabled={busy}
                      onClick={() => review(confirm, 'prepare')}
                    >
                      Accept and prepare unapproved draft
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setConfirm(null);
                        prepareButton.current?.focus();
                      }}
                    >
                      Cancel preparation
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-3">
            {cursor && (
              <Button variant="outline" disabled={busy} onClick={() => setCursor(undefined)}>
                Latest suggestions
              </Button>
            )}
            {state.data.next && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setCursor(state.data.next ?? undefined)}
              >
                Older suggestions
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
