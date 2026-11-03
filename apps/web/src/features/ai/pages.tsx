import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@leadops/ui';
import { aiSettingsInput, can, type AiSettings, type AiRun, type Lead } from '@leadops/shared';
import { apiClient, ApiClientError } from '../../lib/api-client';
import { useOrganization } from '../organizations/context';
import { useQuery } from '../crm/use-query';
import { useDraft } from '../crm/use-draft';
import { CrmFailure } from '../crm/ui';
import { crmMessage } from '../crm/errors';
const label = (text: string) => text.replaceAll('_', ' ');
function failure(error: unknown) {
  if (error instanceof ApiClientError) {
    if (error.code === 'AI_DISABLED')
      return 'AI assistance is disabled. Ask a workspace administrator to enable it in Agents.';
    if (error.code === 'AI_LIMIT_REACHED')
      return 'This workspace has reached its AI request or queue limit. Review existing requests or try tomorrow.';
  }
  return crmMessage(error);
}
export function AgentsPage() {
  const { organization } = useOrganization();
  const load = useCallback(
    (s: AbortSignal) => apiClient.aiSettings(organization.id, s),
    [organization.id],
  );
  const settings = useQuery('ai-settings', load);
  return (
    <div className="max-w-3xl space-y-6">
      <h2 className="text-3xl font-semibold">AI assistance</h2>
      <p>
        Analyze leads and prepare responses for human review. Start from a lead. Every communication
        still requires the existing saved-draft approval.
      </p>
      <Link className="underline" to={`/organizations/${organization.id}/leads`}>
        Open leads
      </Link>
      {settings.state.status === 'loading' ? (
        <p role="status">Loading AI settings…</p>
      ) : settings.state.status === 'error' ? (
        <CrmFailure error={settings.state.error} retry={settings.refresh} />
      ) : (
        <SettingsForm
          key={settings.state.data.version}
          settings={settings.state.data}
          refresh={settings.refresh}
        />
      )}
      <RunHistory />
    </div>
  );
}
function SettingsForm({ settings, refresh }: { settings: AiSettings; refresh: () => void }) {
  const { organization } = useOrganization();
  const [value, setValue] = useState(settings),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const allowed = can(organization.role, 'crm_manage');
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsed = aiSettingsInput.safeParse({
      enabled: value.enabled,
      provider: value.provider,
      dailyLimit: value.dailyLimit,
      concurrentLimit: value.concurrentLimit,
      business: {
        ...value.business,
        services: value.business.services.filter((v) => v.trim()),
        serviceAreas: value.business.serviceAreas.filter((v) => v.trim()),
        questions: value.business.questions.filter((v) => v.trim()),
      },
    });
    if (!parsed.success) {
      setError(
        'Check the field lengths and request limits. Lists must have one item per line, at most 10 services/areas and 8 questions.',
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      await apiClient.saveAiSettings(organization.id, settings.version, parsed.data);
      refresh();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={(e) => void save(e)}
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <h3 className="text-lg font-semibold">Workspace context and limits</h3>
      {!allowed && <p>Only an owner or administrator can change these settings.</p>}
      <fieldset disabled={!allowed || busy} className="space-y-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => setValue({ ...value, enabled: e.currentTarget.checked })}
          />
          Enable AI assistance for this workspace
        </label>
        <label className="block text-sm">
          Execution mode
          <select
            className="field"
            value={value.provider}
            onChange={(e) =>
              setValue({ ...value, provider: e.currentTarget.value as AiSettings['provider'] })
            }
          >
            <option value="simulation">Simulation — no external inference</option>
            <option value="openai">Real AI — requires server configuration</option>
          </select>
        </label>
        <p className="text-sm text-muted-foreground">
          Simulation outputs are predictable examples. Real AI sends bounded lead text and business
          context to the configured provider. Review data handling before enabling it; this setting
          alone does not configure credentials.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['dailyLimit', 'concurrentLimit'] as const).map((key) => (
            <label className="block text-sm" key={key}>
              {key === 'dailyLimit' ? 'Requests per UTC day' : 'Concurrent executions'}
              <input
                className="field"
                type="number"
                required
                min={1}
                max={key === 'dailyLimit' ? 500 : 3}
                value={value[key]}
                onChange={(e) => setValue({ ...value, [key]: Number(e.currentTarget.value) })}
              />
            </label>
          ))}
        </div>
        {(
          [
            'name',
            'description',
            'services',
            'serviceAreas',
            'questions',
            'guidelines',
            'restrictions',
            'escalation',
          ] as const
        ).map((key) => {
          const labels = {
            name: 'Business name',
            description: 'Business description',
            services: 'Services or products (one per line)',
            serviceAreas: 'Service areas (one per line)',
            questions: 'Qualification questions (one per line)',
            guidelines: 'Approved response guidelines',
            restrictions: 'Known restrictions',
            escalation: 'When to involve a person',
          };
          const current = value.business[key];
          return (
            <label key={key} className="block text-sm">
              {labels[key]}
              <textarea
                className="field"
                maxLength={
                  Array.isArray(current)
                    ? 1800
                    : key === 'name'
                      ? 80
                      : key === 'escalation'
                        ? 300
                        : 600
                }
                value={Array.isArray(current) ? current.join('\n') : current}
                onChange={(e) =>
                  setValue({
                    ...value,
                    business: {
                      ...value.business,
                      [key]: Array.isArray(current)
                        ? e.currentTarget.value.split('\n')
                        : e.currentTarget.value,
                    },
                  })
                }
              />
            </label>
          );
        })}
        <label className="block text-sm">
          Preferred tone
          <select
            className="field"
            value={value.business.tone}
            onChange={(e) =>
              setValue({
                ...value,
                business: {
                  ...value.business,
                  tone: e.currentTarget.value as AiSettings['business']['tone'],
                },
              })
            }
          >
            {['warm', 'concise', 'formal'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {allowed && (
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save AI settings'}
        </Button>
      )}
    </form>
  );
}
export function LeadAi({ lead }: { lead: Lead }) {
  const { organization } = useOrganization();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [channel, setChannel] = useState<'email' | 'sms'>('email'),
    [kind, setKind] = useState<AiRun['kind']>('follow_up');
  const [refreshKey, setRefreshKey] = useState(0);
  const pending = useRef<{ id: string; key: string } | null>(null);
  async function request(task: 'analysis' | 'draft') {
    const key = JSON.stringify([lead.id, task, channel, kind]);
    if (pending.current?.key !== key) pending.current = { id: crypto.randomUUID(), key };
    setBusy(true);
    setError('');
    try {
      await apiClient.requestAi(organization.id, pending.current.id, {
        leadId: lead.id,
        task,
        channel,
        kind,
      });
      pending.current = null;
      setRefreshKey((v) => v + 1);
    } catch (e) {
      setError(`${failure(e)} Retry the same request to check its status safely.`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap justify-between gap-3">
        <h3 className="text-lg font-semibold">AI assistance</h3>
        <Link className="text-sm underline" to={`/organizations/${organization.id}/agents`}>
          Workspace AI settings
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        Recommendations need your review. They do not update lead status or authorize a message.
        Requesting another result is intentional regeneration and may incur provider usage in real
        mode.
      </p>
      <fieldset
        disabled={busy || Boolean(lead.archived_at)}
        className="flex flex-wrap items-end gap-3"
      >
        <Button type="button" onClick={() => void request('analysis')}>
          Analyze lead
        </Button>
        <label className="text-sm">
          Draft channel
          <select
            className="field"
            value={channel}
            onChange={(e) => setChannel(e.currentTarget.value as 'email' | 'sms')}
          >
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
        </label>
        <label className="text-sm">
          Response type
          <select
            className="field"
            value={kind}
            onChange={(e) => setKind(e.currentTarget.value as AiRun['kind'])}
          >
            {(
              [
                'acknowledgment',
                'follow_up',
                'service_response',
                'information_request',
                'handoff',
              ] as const
            ).map((k) => (
              <option key={k} value={k}>
                {label(k)}
              </option>
            ))}
          </select>
        </label>
        <Button type="button" variant="outline" onClick={() => void request('draft')}>
          Generate follow-up
        </Button>
      </fieldset>
      {busy && <p role="status">Requesting AI assistance…</p>}
      {error && <p role="alert">{error}</p>}
      <RunHistory key={refreshKey} lead={lead} />
    </section>
  );
}
function RunHistory({ lead }: { lead?: Lead }) {
  const { organization } = useOrganization();
  const [cursor, setCursor] = useState<string | undefined>(),
    [selected, setSelected] = useState('');
  const load = useCallback(
    (s: AbortSignal) => apiClient.aiHistory(organization.id, lead?.id, cursor, s),
    [organization.id, lead?.id, cursor],
  );
  const history = useQuery(`ai-history/${lead?.id ?? 'workspace'}/${cursor ?? ''}`, load);
  const polls = useRef(0);
  const refreshHistory = history.refresh;
  const pending =
    history.state.status === 'ready' &&
    history.state.data.items.some((r) => ['queued', 'claimed', 'retryable'].includes(r.state));
  useEffect(() => {
    if (!pending || polls.current >= 20 || document.visibilityState !== 'visible') return;
    const timer = setTimeout(() => {
      polls.current++;
      refreshHistory();
    }, 3000);
    return () => clearTimeout(timer);
  }, [pending, refreshHistory, history.state.status]);
  if (history.state.status === 'error')
    return <CrmFailure error={history.state.error} retry={history.refresh} />;
  if (history.state.status === 'loading') return <p role="status">Loading AI requests…</p>;
  const items = history.state.data.items,
    run = items.find((r) => r.id === selected) ?? items[0];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">AI requests</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            polls.current = 0;
            history.refresh();
          }}
        >
          Refresh AI status
        </Button>
      </div>
      {pending && (
        <p role="status" className="text-sm">
          Analysis is queued or running. Status refreshes briefly while this page is visible. Use
          Refresh AI status if it takes longer.
        </p>
      )}
      {!items.length && <p className="text-sm text-muted-foreground">No AI requests yet.</p>}
      <ul className="space-y-2">
        {items.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              aria-pressed={run?.id === r.id}
              className="min-h-11 w-full rounded-lg border border-border p-3 text-left text-sm"
              onClick={() => setSelected(r.id)}
            >
              {r.provider === 'simulation' ? 'Simulation' : 'Real AI'} ·{' '}
              {r.task === 'draft' ? `${r.channel} draft` : 'Lead analysis'} · {label(r.state)} ·{' '}
              {new Date(r.created_at).toLocaleString()}
            </button>
          </li>
        ))}
      </ul>
      {run && <RunResult key={run.id} run={run} {...(lead ? { lead } : {})} />}
      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={!cursor}
          onClick={() => {
            setCursor(undefined);
            setSelected('');
          }}
        >
          Latest requests
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!history.state.data.next}
          onClick={() => {
            if (history.state.status === 'ready') {
              setCursor(history.state.data.next ?? undefined);
              setSelected('');
            }
          }}
        >
          Older requests
        </Button>
      </div>
    </div>
  );
}
function RunResult({ run, lead }: { run: AiRun; lead?: Lead }) {
  const { organization } = useOrganization(),
    result = run.result;
  const recovery: Record<string, string> = {
    AUTHORITY_REVOKED:
      'The requesting authority or workspace configuration changed. Ask an administrator to review access before creating another request.',
    STALE_INPUT: 'The lead or business context changed during analysis. Request a new result.',
    PROVIDER_UNAVAILABLE:
      'Real AI is not configured or the provider rejected the request. Ask an administrator to check server configuration.',
    RATE_LIMITED:
      'The provider limited this request. Automatic retries are bounded to three attempts. Create a new request after the limit clears.',
    INVALID_OUTPUT:
      'The provider returned unsupported or ungrounded output. No result or draft was saved.',
    INFERENCE_UNCERTAIN:
      'The worker lost confirmation of inference. Review provider usage before intentionally requesting again.',
    TIMEOUT_UNCERTAIN:
      'Inference exceeded its deadline. Its provider usage may be unknown. Review usage before requesting again.',
  };
  return (
    <article
      className="space-y-3 rounded-lg border border-border p-4"
      aria-label="Selected AI result"
    >
      <p className="text-sm font-medium">
        {run.provider === 'simulation'
          ? 'Simulated result — no live AI inference'
          : 'AI result — human confirmation required'}
      </p>
      {run.code && (
        <p role="status">
          {recovery[run.code] ??
            `Request status: ${label(run.code)}. Review it before requesting again.`}
        </p>
      )}
      {!lead && (
        <Link className="underline" to={`/organizations/${organization.id}/leads/${run.lead_id}`}>
          Open lead and review
        </Link>
      )}
      {result && (
        <>
          <h4 className="font-semibold">
            Qualification recommendation: {label(result.analysis.status)}
          </h4>
          <p className="text-sm">
            Recommended priority: {result.analysis.priority}. This is not a verified customer fact.
          </p>
          <p>{result.reasoning}</p>
          <p>Suggested next action: {label(result.analysis.nextAction)}</p>
          <dl className="space-y-2">
            {(['intent', 'service', 'urgency', 'location', 'timeframe'] as const).map((k) => (
              <div key={k}>
                <dt className="font-medium capitalize">{k}</dt>
                <dd>
                  {result.analysis[k] ? (
                    <>
                      <q>{result.analysis[k]?.quote}</q>
                      <span className="text-xs text-muted-foreground">
                        {' '}
                        — {result.analysis[k]?.source}
                      </span>
                    </>
                  ) : (
                    'Unknown — confirm with the customer'
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {!!result.analysis.requirements.length && (
            <ul>
              {result.analysis.requirements.map((e, i) => (
                <li key={i}>
                  <q>{e.quote}</q> — {e.source}
                </li>
              ))}
            </ul>
          )}
          <p>
            Missing information:{' '}
            {result.analysis.missing.map(label).join(', ') ||
              'None identified; human confirmation is still required.'}
          </p>
          <p className="text-sm">Uncertainty: {label(result.analysis.uncertainty)}</p>
          {run.message_id ? (
            <Link
              className="underline"
              to={`${'/organizations/' + organization.id}/communications?leadId=${run.lead_id}`}
            >
              Open saved communication draft
            </Link>
          ) : (
            lead && result.proposal && <DraftReview key={run.id} lead={lead} run={run} />
          )}
        </>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer py-2">Execution details</summary>
        <p className="break-all">
          Run {run.id} · {run.trigger} · {run.provider} / {run.model ?? 'not executed'} · prompt{' '}
          {run.prompt_version} · analysis v{run.analysis_version} · attempts {run.attempts}
        </p>
        <p>
          Duration: {run.duration_ms === null ? 'unavailable' : `${run.duration_ms} ms`}.
          Input/output tokens: {run.input_tokens ?? 'not reported'} /{' '}
          {run.output_tokens ?? 'not reported'}.
        </p>
        <p>
          Estimated cost:{' '}
          {run.estimated_cost_microusd === null
            ? 'not available'
            : `USD ${(run.estimated_cost_microusd / 1000000).toFixed(6)} (${run.pricing_version})`}
          . This is not a provider invoice.
        </p>
      </details>
    </article>
  );
}
function DraftReview({ run, lead }: { run: AiRun; lead: Lead }) {
  const { organization } = useOrganization(),
    navigate = useNavigate();
  const form = useDraft(`ai-proposal:${run.id}`, {
    subject: run.result?.proposal?.subject ?? '',
    body: run.result?.proposal?.body ?? '',
    recipient: '',
  });
  const { subject, body, recipient } = form.draft.value;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const recipients =
    run.channel === 'email'
      ? lead.contact.emails.map((e) => e.normalized)
      : lead.contact.phones.flatMap((p) => (p.normalized ? [p.normalized] : []));
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const message = await apiClient.saveAiDraft(organization.id, run.id, {
        subject,
        body,
        recipient,
      });
      form.clear();
      navigate(`/organizations/${organization.id}/communications/${message.conversation_id}`);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="space-y-3 border-t border-border pt-4" onSubmit={(e) => void save(e)}>
      <h4 className="font-semibold">Review {run.channel} proposal</h4>
      <p className="text-sm">
        Select a saved contact destination. Review every word. Saving creates an unapproved
        transactional draft; an administrator must approve its exact saved version separately.
      </p>
      <fieldset disabled={busy || !form.enabled} className="space-y-3">
        <label className="block text-sm">
          Recipient
          <select
            className="field"
            required
            value={recipient}
            onChange={(e) => form.change({ ...form.draft.value, recipient: e.currentTarget.value })}
          >
            <option value="">Select saved destination</option>
            {recipients.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        {!recipients.length && (
          <p>
            Add a valid {run.channel === 'email' ? 'email address' : 'international phone number'}{' '}
            to this lead’s contact first.
          </p>
        )}
        {run.channel === 'email' && (
          <label className="block text-sm">
            Subject
            <input
              className="field"
              maxLength={200}
              required
              value={subject}
              onChange={(e) => form.change({ ...form.draft.value, subject: e.currentTarget.value })}
            />
          </label>
        )}
        <label className="block text-sm">
          Message
          <textarea
            className="field min-h-40"
            maxLength={1600}
            required
            value={body}
            onChange={(e) => form.change({ ...form.draft.value, body: e.currentTarget.value })}
          />
        </label>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={busy || !recipient || !form.enabled}>
        {busy ? 'Saving…' : 'Save communication draft'}
      </Button>
    </form>
  );
}
