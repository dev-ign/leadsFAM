import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '@leadops/ui';
import {
  can,
  guidedWorkflowSupport,
  workflowDefinitionSchema,
  type AutomationOverview,
  type Workflow,
} from '@leadops/shared';
import { apiClient } from '../../lib/api-client';
import { useOrganization } from '../organizations/context';
import { useQuery } from '../crm/use-query';
import { useDraft } from '../crm/use-draft';
import { useDrafts } from '../crm/draft-context';
import { CrmFailure } from '../crm/ui';
import { crmMessage, uncertain } from '../crm/errors';

type Integration = AutomationOverview['integrations'][number];
type Source = Awaited<ReturnType<typeof apiClient.sources>>[number];
function useAutomationData() {
  const { organization } = useOrganization();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [overview, sources] = await Promise.all([
        apiClient.automations(organization.id, signal),
        apiClient.sources(organization.id, signal),
      ]);
      return { overview, sources };
    },
    [organization.id],
  );
  return useQuery('automation-overview', load);
}
function PermissionNotice() {
  return (
    <p role="status">
      An owner or administrator can manage integrations and automations for this workspace.
    </p>
  );
}
function useAction(refresh: () => void) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const { store } = useDrafts();
  const { organization } = useOrganization();
  const run = async (operation: () => Promise<unknown>) => {
    const token = store.token(organization.id);
    setBusy(true);
    setError('');
    try {
      await operation();
      if (store.visible(token)) refresh();
    } catch (e) {
      if (store.visible(token))
        setError(
          uncertain(e)
            ? 'The request may have completed. Refresh to check its status before trying again.'
            : crmMessage(e),
        );
    } finally {
      if (store.visible(token)) setBusy(false);
    }
  };
  return { busy, error, run };
}
export function AutomationsPage() {
  const { organization } = useOrganization();
  if (!can(organization.role, 'crm_manage')) return <PermissionNotice />;
  return <AutomationList key={organization.id} />;
}
function AutomationList() {
  const { organization } = useOrganization(),
    { state, refresh } = useAutomationData();
  const action = useAction(refresh),
    [review, setReview] = useState<Workflow | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
  }, [review]);
  const base = `/organizations/${organization.id}`;
  return (
    <section className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-3xl font-semibold">Automations</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Give every new inquiry a clear next step.
          </p>
        </div>
        <Link
          className="rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground"
          to={`${base}/automations/new`}
        >
          Create automation
        </Link>
      </div>
      {state.status === 'loading' ? (
        <p role="status">Loading automations…</p>
      ) : state.status === 'error' ? (
        <CrmFailure error={state.error} retry={refresh} />
      ) : (
        <>
          {!state.data.overview.workflows.length && (
            <div className="rounded-xl border border-dashed border-border p-8">
              <h3 className="text-lg font-medium">Your first automation starts here</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Choose when it starts and what your team should see. Review everything before
                turning it on.
              </p>
            </div>
          )}
          {state.data.overview.workflows.map((w) => (
            <article key={w.id} className="space-y-3 rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold">{w.name}</h3>
                <span className="rounded-full bg-accent px-3 py-1 text-xs capitalize">
                  {w.status}
                </span>
              </div>
              <WorkflowSummary workflow={w} sources={state.data.sources} />
              {w.status === 'active' && w.published_version !== w.version && (
                <p className="text-sm text-muted-foreground">
                  Draft changes are saved. Active runs use published version {w.published_version}{' '}
                  until you activate the changes.
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <Link
                  className="inline-flex min-h-11 items-center underline"
                  to={`${base}/automations/${w.id}/edit`}
                >
                  Edit automation
                </Link>
                {w.status !== 'active' || w.version !== w.published_version ? (
                  <Button
                    disabled={action.busy || !guidedWorkflowSupport(w.definition).editable}
                    onClick={() => setReview(w)}
                  >
                    Review & activate
                  </Button>
                ) : null}
                {w.status === 'active' && (
                  <Button
                    variant="outline"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(() =>
                        apiClient.changeWorkflow(organization.id, w.id, w.version, 'pause'),
                      )
                    }
                  >
                    Pause automation
                  </Button>
                )}
              </div>
            </article>
          ))}
          {review && (
            <div
              role="region"
              aria-label="Review activation"
              className="space-y-4 rounded-xl border-2 border-primary bg-card p-5"
            >
              <h3 ref={reviewHeading} tabIndex={-1} className="text-lg font-semibold">
                Ready to activate {review.name}?
              </h3>
              <WorkflowSummary workflow={review} sources={state.data.sources} />
              <p className="text-sm">
                This applies to new leads received after activation. You can pause it at any time.
              </p>
              <div className="flex gap-3">
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await apiClient.changeWorkflow(
                        organization.id,
                        review.id,
                        review.version,
                        'publish',
                      );
                      setReview(null);
                    })
                  }
                >
                  {action.busy ? 'Activating…' : 'Activate automation'}
                </Button>
                <Button variant="outline" disabled={action.busy} onClick={() => setReview(null)}>
                  Cancel activation
                </Button>
              </div>
            </div>
          )}
          <ExecutionHistory overview={state.data.overview} refresh={refresh} />
        </>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      )}
      <Button variant="outline" onClick={refresh}>
        Refresh status
      </Button>
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer py-3">More about automation</summary>
        <p className="mt-2">
          Automations currently record internal activities. Email, SMS and AI decisions will come
          later. A visual editor will use these same workflows in a future release.
        </p>
      </details>
    </section>
  );
}
function WorkflowSummary({
  workflow,
  sources,
}: {
  workflow: Pick<Workflow, 'definition'>;
  sources: Source[];
}) {
  const support = guidedWorkflowSupport(workflow.definition);
  if (!support.editable) return <p className="text-sm text-muted-foreground">{support.reason}</p>;
  return (
    <div className="space-y-2 text-sm">
      <p>When a lead is created{support.definition.conditions.length ? ', if:' : '.'}</p>
      {support.definition.conditions.map((c, i) => (
        <p key={i} className="text-muted-foreground">
          {c.field === 'sourceId'
            ? `Source is ${sources.find((s) => s.id === c.equals)?.name ?? 'a previously selected source'}`
            : `Status is ${c.equals.replaceAll('_', ' ')}`}
        </p>
      ))}
      <p className="whitespace-pre-wrap break-words">
        {support.definition.steps[0]?.tool === 'ai.analyze'
          ? 'Request AI analysis for human review. Workspace AI must be enabled. No message is sent.'
          : `Record an internal activity: “${support.definition.steps[0]?.arguments.message}”`}
      </p>
    </div>
  );
}
export function AutomationEditorPage() {
  const { organization } = useOrganization();
  if (!can(organization.role, 'crm_manage')) return <PermissionNotice />;
  return <EditorLoader key={organization.id} />;
}
function EditorLoader() {
  const { id } = useParams(),
    { state, refresh } = useAutomationData();
  if (state.status === 'loading') return <p role="status">Loading automation builder…</p>;
  if (state.status === 'error') return <CrmFailure error={state.error} retry={refresh} />;
  const workflow = state.data.overview.workflows.find((w) => w.id === id);
  if (id && !workflow) return <p role="alert">This automation is unavailable in this workspace.</p>;
  if (workflow && !guidedWorkflowSupport(workflow.definition).editable)
    return (
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">{workflow.name}</h2>
        <WorkflowSummary workflow={workflow} sources={state.data.sources} />
        <p>Your configuration is preserved. No changes have been made.</p>
      </section>
    );
  return (
    <GuidedEditor
      key={workflow?.id ?? 'new'}
      {...(workflow ? { workflow } : {})}
      sources={state.data.sources}
    />
  );
}
function GuidedEditor({ workflow, sources }: { workflow?: Workflow; sources: Source[] }) {
  const { organization } = useOrganization(),
    navigate = useNavigate();
  const initial = workflow
    ? workflowDefinitionSchema.parse(workflow.definition)
    : {
        schemaVersion: 1 as const,
        trigger: 'lead.created' as const,
        conditions: [],
        steps: [
          {
            id: 'record',
            tool: 'activities.create' as const,
            version: 1 as const,
            arguments: { message: 'Review this new inquiry and choose the next step.' },
          },
        ],
      };
  const form = useDraft(`automation:${workflow?.id ?? 'new'}`, {
      name: workflow?.name ?? 'Review new inquiries',
      definition: initial,
      version: workflow?.version ?? 0,
    }),
    { draft } = form;
  const [review, setReview] = useState(false),
    reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
  }, [review]);
  const replaceCondition = (field: 'sourceId' | 'status', value: string) => {
    const conditions = draft.value.definition.conditions.filter((c) => c.field !== field);
    if (value)
      conditions.push(
        field === 'sourceId'
          ? { field, equals: value }
          : { field, equals: value as 'new' | 'in_progress' | 'qualified' | 'closed' },
      );
    form.change({ ...draft.value, definition: { ...draft.value.definition, conditions } });
  };
  async function save(activate = false) {
    form.update((v) => ({ ...v, phase: 'saving', error: '' }));
    let saved: Workflow | null = null;
    try {
      saved = await apiClient.saveWorkflow(
        organization.id,
        { name: draft.value.name, definition: draft.value.definition },
        workflow?.id,
        workflow ? draft.value.version : undefined,
      );
      if (activate)
        await apiClient.changeWorkflow(organization.id, saved.id, saved.version, 'publish');
      if (form.visible()) {
        form.clear();
        navigate(`/organizations/${organization.id}/automations`);
      }
    } catch (error) {
      form.update((v) => ({
        ...v,
        phase: saved || uncertain(error) ? 'uncertain' : 'editing',
        dirty: saved ? false : v.dirty,
        error: saved
          ? 'Your automation was saved. Return to automations and refresh status to check whether activation completed.'
          : uncertain(error)
            ? 'The draft may have been saved. Return to automations and refresh to check before saving again.'
            : crmMessage(error),
      }));
    }
  }
  const locked = !form.enabled || draft.phase === 'saving' || draft.phase === 'uncertain';
  return (
    <section className="max-w-2xl space-y-6">
      <Link
        className="inline-flex min-h-11 items-center text-sm underline"
        to={`/organizations/${organization.id}/automations`}
      >
        Back to automations
      </Link>
      <div>
        <h2 className="text-3xl font-semibold">
          {workflow ? 'Edit automation' : 'Create an automation'}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          A few simple choices. Nothing runs until you activate it.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-6"
      >
        <fieldset disabled={locked} className="space-y-6">
          {!review ? (
            <>
              <label className="block text-sm">
                Automation name
                <input
                  className="field"
                  required
                  maxLength={80}
                  value={draft.value.name}
                  onChange={(e) => form.change({ ...draft.value, name: e.currentTarget.value })}
                />
              </label>
              <div className="space-y-3 rounded-xl border border-border bg-card p-5">
                <h3 className="font-semibold">1. What should start it?</h3>
                <p className="text-sm">When a new lead is created</p>
                <details>
                  <summary className="cursor-pointer py-2 text-sm text-muted-foreground">
                    Only for some leads (optional)
                  </summary>
                  <div className="mt-3 space-y-4">
                    <label className="block text-sm">
                      Lead source
                      <select
                        className="field"
                        value={
                          draft.value.definition.conditions.find((c) => c.field === 'sourceId')
                            ?.equals ?? ''
                        }
                        onChange={(e) => replaceCondition('sourceId', e.currentTarget.value)}
                      >
                        <option value="">Any source</option>
                        {sources
                          .filter(
                            (s) =>
                              !s.archived_at ||
                              draft.value.definition.conditions.some(
                                (c) => c.field === 'sourceId' && c.equals === s.id,
                              ),
                          )
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                              {s.archived_at ? ' (archived)' : ''}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="block text-sm">
                      Lead status
                      <select
                        className="field"
                        value={
                          draft.value.definition.conditions.find((c) => c.field === 'status')
                            ?.equals ?? ''
                        }
                        onChange={(e) => replaceCondition('status', e.currentTarget.value)}
                      >
                        <option value="">Any status</option>
                        <option value="new">New</option>
                        <option value="in_progress">In progress</option>
                        <option value="qualified">Qualified</option>
                        <option value="closed">Closed</option>
                      </select>
                    </label>
                  </div>
                </details>
              </div>
              <div className="space-y-3 rounded-xl border border-border bg-card p-5">
                <h3 className="font-semibold">2. What should happen next?</h3>
                <p className="text-sm text-muted-foreground">
                  Choose a bounded action for your team.
                </p>
                <label className="block text-sm">
                  Action
                  <select
                    className="field"
                    value={draft.value.definition.steps[0]?.tool ?? 'activities.create'}
                    onChange={(e) =>
                      form.change({
                        ...draft.value,
                        definition: {
                          ...draft.value.definition,
                          steps: draft.value.definition.steps.map((step) => ({
                            ...step,
                            tool: e.currentTarget.value as 'activities.create' | 'ai.analyze',
                            arguments:
                              e.currentTarget.value === 'ai.analyze'
                                ? { message: 'AI analysis requested for human review.' }
                                : step.arguments,
                          })),
                        },
                      })
                    }
                  >
                    <option value="activities.create">Record an internal activity</option>
                    <option value="ai.analyze">Request AI lead analysis</option>
                  </select>
                </label>
                {draft.value.definition.steps[0]?.tool === 'ai.analyze' && (
                  <p className="text-sm">
                    Enable AI in Agents first. This action queues a separate analysis for review. It
                    cannot send communications.
                  </p>
                )}
                {draft.value.definition.steps[0]?.tool !== 'ai.analyze' && (
                  <label className="block text-sm">
                    Internal activity
                    <textarea
                      className="field min-h-28"
                      required
                      maxLength={300}
                      value={draft.value.definition.steps[0]?.arguments.message ?? ''}
                      onChange={(e) =>
                        form.change({
                          ...draft.value,
                          definition: {
                            ...draft.value.definition,
                            steps: draft.value.definition.steps.map((s) => ({
                              ...s,
                              arguments: { message: e.currentTarget.value },
                            })),
                          },
                        })
                      }
                    />
                  </label>
                )}
              </div>
              <Button
                type="button"
                onClick={() => {
                  if (
                    draft.value.name.trim() &&
                    workflowDefinitionSchema.safeParse(draft.value.definition).success
                  )
                    setReview(true);
                  else
                    form.update((v) => ({
                      ...v,
                      error: 'Add a name and an internal activity before reviewing.',
                    }));
                }}
              >
                Review automation
              </Button>
            </>
          ) : (
            <div className="space-y-4 rounded-xl border border-border bg-card p-5">
              <h3 ref={reviewHeading} tabIndex={-1} className="text-lg font-semibold">
                Review your automation
              </h3>
              <p className="font-medium">{draft.value.name}</p>
              <WorkflowSummary
                workflow={{ definition: draft.value.definition }}
                sources={sources}
              />
              <p className="text-sm text-muted-foreground">
                Activate it now, or save a draft to finish later.{' '}
                {workflow?.status === 'active'
                  ? 'Your currently published version keeps running until you activate these changes.'
                  : ''}
              </p>
              <div className="flex gap-3">
                <Button type="button" onClick={() => void save(true)}>
                  {draft.phase === 'saving' ? 'Saving…' : 'Activate automation'}
                </Button>
                <Button type="submit" variant="outline">
                  Save draft
                </Button>
                <Button type="button" variant="outline" onClick={() => setReview(false)}>
                  Back to choices
                </Button>
              </div>
            </div>
          )}
        </fieldset>
        {draft.error && (
          <p role="alert" className="text-sm text-destructive">
            {draft.error}
          </p>
        )}
      </form>
    </section>
  );
}

export function IntegrationsPage() {
  const { organization } = useOrganization();
  if (!can(organization.role, 'crm_manage')) return <PermissionNotice />;
  return <IntegrationList key={organization.id} />;
}
function IntegrationList() {
  const { organization } = useOrganization(),
    { state, refresh } = useAutomationData();
  const { store } = useDrafts();
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null),
    [confirm, setConfirm] = useState<{
      integration: Integration;
      action: 'revoked' | 'rotate';
    } | null>(null);
  const [checkedAt] = useState(() => Date.now());
  const dialog = useRef<HTMLDialogElement>(null),
    action = useAction(refresh);
  useEffect(() => {
    if (confirm && !dialog.current?.open) dialog.current?.showModal();
    if (!confirm && dialog.current?.open) dialog.current.close();
  }, [confirm]);
  const reveal = (id: string, value: string) => {
    setSecret({ id, value });
    refresh();
  };
  return (
    <section className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-3xl font-semibold">Integrations</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Securely receive inquiries from an authorized website backend or application.
        </p>
      </div>
      <IntegrationForm onCreated={reveal} />
      {secret && (
        <div
          role="region"
          aria-label="Integration credential"
          className="space-y-3 rounded-xl border-2 border-primary bg-card p-5"
        >
          <h3 className="font-semibold">Save your integration key</h3>
          <p className="text-sm">
            This key is shown only now. Store it in your backend’s secret settings. If you lose it,
            create a replacement key.
          </p>
          <label className="block text-sm">
            Integration key
            <input
              className="field font-mono"
              readOnly
              value={secret.value}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <Button variant="outline" onClick={() => setSecret(null)}>
            I have saved the key
          </Button>
        </div>
      )}
      {state.status === 'loading' ? (
        <p role="status">Loading integrations…</p>
      ) : state.status === 'error' ? (
        <CrmFailure error={state.error} retry={refresh} />
      ) : (
        <>
          {!state.data.overview.integrations.length && (
            <p className="rounded-xl border border-dashed border-border p-8 text-sm text-muted-foreground">
              No integrations yet. Add one when your backend is ready to send synthetic inquiries.
            </p>
          )}
          {state.data.overview.integrations.map((i) => (
            <article key={i.id} className="space-y-3 rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold">{i.name}</h3>
                <span className="rounded-full bg-accent px-3 py-1 text-xs capitalize">
                  {Date.parse(i.expires_at) <= checkedAt && i.status !== 'revoked'
                    ? 'Key expired'
                    : i.status}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Source:{' '}
                {state.data.sources.find((s) => s.id === i.source_id)?.name ?? 'No source selected'}{' '}
                · Key expires {new Date(i.expires_at).toLocaleDateString()}
              </p>
              {i.status !== 'revoked' && (
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(() =>
                        apiClient.changeIntegration(
                          organization.id,
                          i.id,
                          i.version,
                          i.status === 'active' ? 'paused' : 'active',
                        ),
                      )
                    }
                  >
                    {i.status === 'active' ? 'Pause intake' : 'Resume intake'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={action.busy}
                    onClick={() => setConfirm({ integration: i, action: 'rotate' })}
                  >
                    Replace key
                  </Button>
                  <Button
                    variant="outline"
                    disabled={action.busy}
                    onClick={() => setConfirm({ integration: i, action: 'revoked' })}
                  >
                    Revoke integration
                  </Button>
                </div>
              )}
            </article>
          ))}
          <section className="space-y-3">
            <h3 className="text-xl font-semibold">Recent incoming leads</h3>
            {state.data.overview.receipts.length ? (
              <ul className="space-y-2">
                {state.data.overview.receipts.map((r) => (
                  <li key={r.id} className="rounded-lg border border-border p-4 text-sm">
                    <Link
                      className="underline"
                      to={`/organizations/${organization.id}/leads/${r.lead_id}`}
                    >
                      View received lead
                    </Link>
                    <span className="ml-2 text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </span>
                    <details className="mt-2">
                      <summary className="cursor-pointer py-2">Delivery details</summary>
                      <p className="break-all">Event: {r.external_event_id}</p>
                      <p className="break-all">Reference: {r.correlation_id}</p>
                    </details>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No incoming leads yet. Accepted deliveries will appear here.
              </p>
            )}
          </section>
        </>
      )}
      {action.error && (
        <p role="alert" className="text-sm text-destructive">
          {action.error}
        </p>
      )}
      {state.status === 'ready' &&
        state.data.overview.attempts.some((a) => a.state === 'rejected') && (
          <section className="space-y-3">
            <h3 className="text-xl font-semibold">Delivery problems</h3>
            {state.data.overview.attempts
              .filter((a) => a.state === 'rejected')
              .map((a) => (
                <div className="rounded-lg border border-border p-4 text-sm" key={a.id}>
                  <p>
                    {a.code === 'duplicate_review_required'
                      ? 'A matching contact needs review. Select the existing contact or confirm a distinct person in your backend, then submit a new event ID.'
                      : a.code === 'idempotency_conflict'
                        ? 'This event ID was already used with different details. Keep the original details for a retry; use a new ID only for a new delivery.'
                        : 'We could not process this delivery. Check the required fields before submitting a new event.'}
                  </p>
                  <details>
                    <summary className="cursor-pointer py-2">Delivery reference</summary>
                    <p className="break-all">{a.correlation_id}</p>
                  </details>
                </div>
              ))}
          </section>
        )}
      <Button variant="outline" onClick={refresh}>
        Refresh integrations
      </Button>
      <details className="space-y-3 rounded-xl border border-border p-5 text-sm">
        <summary className="cursor-pointer py-2 font-medium">Developer setup</summary>
        <p>
          Send JSON from your trusted backend to <code>/ingress/v1/leads</code> on the LeadsFam API
          with an Authorization bearer key and a stable external event ID. Retry the same event with
          identical details after a timeout. Accepted intake creates the lead immediately;
          automation runs in the background.
        </p>
        <p>
          Keep keys on the server. Public website forms need a trusted backend and appropriate bot
          protection. No live business connection is configured by creating an integration.
        </p>
      </details>
      <dialog
        ref={dialog}
        aria-labelledby="integration-confirm-title"
        onCancel={() => setConfirm(null)}
        className="m-auto max-h-[90vh] w-[90vw] max-w-md space-y-4 rounded-xl border border-border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <h3 id="integration-confirm-title" className="text-lg font-semibold">
          {confirm?.action === 'rotate' ? 'Replace this key?' : 'Revoke this integration?'}
        </h3>
        <p className="text-sm">
          {confirm?.action === 'rotate'
            ? 'The old key will stop working immediately. Update your backend with the replacement key.'
            : 'New deliveries and pending automation from this integration will be denied. Revocation cannot be undone. Existing CRM records stay available.'}
        </p>
        <div className="flex gap-3">
          <Button
            variant="outline"
            autoFocus
            disabled={action.busy}
            onClick={() => setConfirm(null)}
          >
            Cancel
          </Button>
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                if (!confirm) return;
                const token = store.token(organization.id);
                const i = confirm.integration;
                if (confirm.action === 'rotate') {
                  const result = await apiClient.rotateIntegration(
                    organization.id,
                    i.id,
                    i.version,
                  );
                  if (store.visible(token)) reveal(i.id, result.credential);
                } else {
                  await apiClient.changeIntegration(organization.id, i.id, i.version, 'revoked');
                  if (store.visible(token)) setSecret((s) => (s?.id === i.id ? null : s));
                }
                if (store.visible(token)) setConfirm(null);
              })
            }
          >
            {action.busy
              ? 'Saving…'
              : confirm?.action === 'rotate'
                ? 'Replace key'
                : 'Revoke integration'}
          </Button>
        </div>
      </dialog>
    </section>
  );
}
function IntegrationForm({ onCreated }: { onCreated: (id: string, secret: string) => void }) {
  const { organization } = useOrganization(),
    form = useDraft('integration:new', { name: 'Website inquiries', sourceId: '' }),
    { draft } = form;
  const load = useCallback(
      (signal: AbortSignal) => apiClient.sources(organization.id, signal),
      [organization.id],
    ),
    { state } = useQuery('integration-source-options', load);
  async function create(e: FormEvent) {
    e.preventDefault();
    form.update((v) => ({ ...v, phase: 'saving', error: '' }));
    try {
      const result = await apiClient.createIntegration(organization.id, {
        name: draft.value.name,
        ...(draft.value.sourceId ? { sourceId: draft.value.sourceId } : {}),
      });
      if (form.visible()) {
        form.clear();
        onCreated(result.integration.id, result.credential);
      }
    } catch (error) {
      form.update((v) => ({
        ...v,
        phase: uncertain(error) ? 'uncertain' : 'editing',
        error: uncertain(error)
          ? 'The integration may have been created. Refresh integrations to check, then replace its key if needed.'
          : crmMessage(error),
      }));
    }
  }
  return (
    <form
      className="space-y-3 rounded-xl border border-border bg-card p-5"
      onSubmit={(e) => void create(e)}
    >
      <h3 className="text-lg font-semibold">Add an integration</h3>
      <fieldset
        disabled={!form.enabled || draft.phase === 'saving' || draft.phase === 'uncertain'}
        className="flex flex-wrap items-end gap-4"
      >
        <label className="min-w-48 flex-1 text-sm">
          Integration name
          <input
            className="field"
            required
            maxLength={80}
            value={draft.value.name}
            onChange={(e) => form.change({ ...draft.value, name: e.currentTarget.value })}
          />
        </label>
        <label className="min-w-48 flex-1 text-sm">
          Lead source (optional)
          <select
            className="field"
            value={draft.value.sourceId}
            onChange={(e) => form.change({ ...draft.value, sourceId: e.currentTarget.value })}
          >
            <option value="">No source</option>
            {state.status === 'ready' &&
              state.data
                .filter((s) => !s.archived_at)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
          </select>
        </label>
        <Button type="submit">{draft.phase === 'saving' ? 'Adding…' : 'Add integration'}</Button>
      </fieldset>
      {draft.error && (
        <p role="alert" className="text-sm text-destructive">
          {draft.error}
        </p>
      )}
    </form>
  );
}
function ExecutionHistory({
  overview,
  refresh,
}: {
  overview: AutomationOverview;
  refresh: () => void;
}) {
  const { organization } = useOrganization(),
    action = useAction(refresh);
  return (
    <section className="space-y-4">
      <h3 className="text-xl font-semibold">Recent activity</h3>
      {overview.jobs
        .filter((j) => j.state === 'failed_terminal')
        .map((j) => (
          <div key={j.id} className="space-y-2 rounded-lg border border-border p-4 text-sm">
            <p>
              This {j.type === 'dispatch' ? 'incoming event' : 'automation run'} needs attention.
            </p>
            <p className="text-muted-foreground">
              Restore paused integrations or automations and check access before retrying. Every
              retry checks current permission again.
            </p>
            <details>
              <summary className="cursor-pointer py-2">Troubleshooting reference</summary>
              <p className="break-all">{j.correlation_id}</p>
            </details>
            <Button
              variant="outline"
              disabled={action.busy}
              onClick={() =>
                void action.run(() =>
                  apiClient.retryAutomationJob(organization.id, j.id, j.generation),
                )
              }
            >
              Retry processing
            </Button>
          </div>
        ))}
      {action.error && <p role="alert">{action.error}</p>}
      <p className="text-sm text-muted-foreground">
        {overview.queue.pending} queued · {overview.queue.failed} need attention
        {overview.queue.oldestPendingAt
          ? ` · Oldest queued ${new Date(overview.queue.oldestPendingAt).toLocaleString()}`
          : ''}
      </p>
      {!overview.runs.length ? (
        <p className="text-sm text-muted-foreground">
          Runs appear here after a new lead starts an active automation.
        </p>
      ) : (
        <ol className="space-y-3">
          {overview.runs.map((r) => (
            <li
              key={r.id}
              className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm"
            >
              <div className="flex flex-wrap justify-between gap-2">
                <p className="font-medium">
                  {overview.workflows.find((w) => w.id === r.workflow_id)?.name ?? 'Automation'} ·
                  version {r.workflow_version}
                </p>
                <span>
                  {r.job_state === 'retryable'
                    ? 'Retry scheduled'
                    : r.job_state === 'claimed'
                      ? 'Processing'
                      : r.state === 'succeeded'
                        ? 'Completed'
                        : r.state === 'failed'
                          ? 'Needs attention'
                          : r.state === 'skipped'
                            ? 'Conditions did not match'
                            : 'Queued'}
                </span>
              </div>
              <Link
                className="inline-flex min-h-11 items-center underline"
                to={`/organizations/${organization.id}/leads/${r.lead_id}`}
              >
                View lead
              </Link>
              <p className="text-muted-foreground">
                {r.completed_steps} {r.completed_steps === 1 ? 'action' : 'actions'} recorded ·{' '}
                {r.attempts} {r.attempts === 1 ? 'attempt' : 'attempts'}
              </p>
              {r.code && (
                <p>
                  {r.code === 'AUTHORITY_REVOKED'
                    ? 'This run stopped because access changed or an integration or automation was paused. Review access and use a new inquiry after restoring it.'
                    : r.job_state === 'retryable'
                      ? 'A temporary problem interrupted this run. It will retry automatically.'
                      : 'This run could not finish. Share the reference below with your administrator.'}
                </p>
              )}
              <details>
                <summary className="cursor-pointer py-2">Troubleshooting details</summary>
                <p className="break-all">Reference: {r.correlation_id}</p>
                <p className="break-all">Run: {r.id}</p>
                <p>Started: {r.started_at ? new Date(r.started_at).toLocaleString() : 'Not yet'}</p>
                <p>
                  Finished: {r.finished_at ? new Date(r.finished_at).toLocaleString() : 'Not yet'}
                </p>
                {r.job_state === 'retryable' && (
                  <p>Next attempt: {new Date(r.run_at).toLocaleString()}</p>
                )}
              </details>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
