import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useNavigate } from 'react-router';
import { Button } from '@leadops/ui';
import { can, leadFieldsSchema, type Lead, type Contact } from '@leadops/shared';
import { apiClient } from '../../lib/api-client';
import { useOrganization } from '../organizations/context';
import { useIdentity } from '../identity/context';
import { useQuery } from './use-query';
import { useDraft } from './use-draft';
import { useDrafts } from './draft-context';
import { ContactEditor } from './forms';
import { CrmFailure } from './ui';
import { crmMessage } from './errors';
export function LeadDetailPage() {
  return <Detail kind="leads" />;
}
export function ContactDetailPage() {
  return <Detail kind="contacts" />;
}
export function LeadEditPage() {
  return <Detail kind="leads" edit />;
}
export function ContactEditPage() {
  return <Detail kind="contacts" edit />;
}
function Detail({ kind, edit = false }: { kind: 'leads' | 'contacts'; edit?: boolean }) {
  const { organization } = useOrganization(),
    { state: identity } = useIdentity(),
    { id = '' } = useParams();
  const load = useCallback(
    (s: AbortSignal) =>
      kind === 'leads'
        ? apiClient.lead(organization.id, id, s)
        : apiClient.contact(organization.id, id, s),
    [organization.id, id, kind],
  );
  const { state, refresh } = useQuery<Lead | Contact>(
    JSON.stringify([
      identity.status === 'ready' ? identity.session.user?.id : '',
      organization.id,
      kind,
      id,
    ]),
    load,
  );
  if (state.status === 'loading') return <p role="status">Loading record…</p>;
  if (state.status === 'error') return <CrmFailure error={state.error} retry={refresh} />;
  const base = `/organizations/${organization.id}`;
  if (edit) {
    if (state.data.archived_at || ('status' in state.data && state.data.status === 'closed'))
      return (
        <p>
          Restore or reopen this record before editing.{' '}
          <Link className="underline" to={`${base}/${kind}/${id}`}>
            Back to record
          </Link>
        </p>
      );
    return 'contact' in state.data ? (
      <LeadEditor key={`${id}/${state.data.version}`} lead={state.data} />
    ) : (
      <ContactEditor key={`${id}/${state.data.version}`} contact={state.data} />
    );
  }
  return 'contact' in state.data ? (
    <LeadView key={state.data.id} lead={state.data} refresh={refresh} />
  ) : (
    <ContactView key={state.data.id} contact={state.data} refresh={refresh} />
  );
}
function LeadEditor({ lead }: { lead: Lead }) {
  const { organization } = useOrganization(),
    { store, confirmDiscard } = useDrafts(),
    navigate = useNavigate(),
    form = useDraft(`lead-edit:${lead.id}`, {
      version: lead.version,
      title: lead.title,
      description: lead.description,
      priority: lead.priority,
    });
  const { draft, update, clear, enabled } = form,
    navigateBack = `/organizations/${organization.id}/leads/${lead.id}`;
  useEffect(() => {
    if (draft.phase === 'done' && enabled) {
      clear();
      navigate(navigateBack, { replace: true });
    }
  }, [draft.phase, enabled, clear, navigate, navigateBack]);
  async function save(e: FormEvent) {
    e.preventDefault();
    const { version, ...value } = draft.value,
      fields = leadFieldsSchema.safeParse(value);
    if (!fields.success) {
      update((v) => ({ ...v, error: 'Check the lead fields.' }));
      return;
    }
    update((v) => ({ ...v, phase: 'saving', error: '' }));
    try {
      await apiClient.updateLead(organization.id, lead.id, version, fields.data);
      update((v) => ({ ...v, phase: 'done', dirty: false, resultId: lead.id }));
    } catch (error) {
      update((v) => ({ ...v, phase: 'editing', error: crmMessage(error) }));
    }
  }
  return (
    <div className="max-w-3xl space-y-5">
      <Link className="text-sm underline" to={navigateBack}>
        Back to lead
      </Link>
      <h2 className="text-3xl font-semibold">Edit lead</h2>
      <form onSubmit={(e) => void save(e)} className="space-y-4">
        <fieldset disabled={!form.enabled || draft.phase === 'saving'} className="space-y-4">
          <label className="block text-sm">
            Lead title
            <input
              className="field"
              value={draft.value.title}
              required
              maxLength={160}
              onChange={(e) => form.change({ ...draft.value, title: e.currentTarget.value })}
            />
          </label>
          <label className="block text-sm">
            Description
            <textarea
              className="field min-h-32"
              value={draft.value.description}
              maxLength={4000}
              onChange={(e) => form.change({ ...draft.value, description: e.currentTarget.value })}
            />
          </label>
          <label className="block text-sm">
            Priority
            <select
              className="field"
              value={draft.value.priority}
              onChange={(e) =>
                form.change({ ...draft.value, priority: e.currentTarget.value as Lead['priority'] })
              }
            >
              {['low', 'normal', 'high'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </fieldset>
        {draft.error && <p role="alert">{draft.error}</p>}
        <Button type="submit" disabled={!form.enabled || draft.phase === 'saving'}>
          {draft.phase === 'saving' ? 'Saving…' : 'Save lead'}
        </Button>
        <Button
          className="ml-3"
          variant="outline"
          type="button"
          onClick={() =>
            confirmDiscard(() => {
              store.discardActive();
              navigate(navigateBack, { replace: true });
            })
          }
        >
          Refresh record
        </Button>
      </form>
    </div>
  );
}
function LeadView({ lead, refresh }: { lead: Lead; refresh: () => void }) {
  const { organization } = useOrganization(),
    base = `/organizations/${organization.id}`;
  return (
    <div className="space-y-7">
      <Link className="text-sm underline" to={`${base}/leads`}>
        Back to leads
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs uppercase text-muted-foreground">
            {lead.archived_at ? 'Archived lead' : lead.status.replaceAll('_', ' ')}
          </p>
          <h2 className="text-3xl font-semibold">{lead.title}</h2>
          <p className="mt-2 text-sm capitalize text-muted-foreground">
            {lead.priority} priority{lead.outcome ? ` · ${lead.outcome}` : ''}
          </p>
        </div>
        {!lead.archived_at && lead.status !== 'closed' && (
          <Link
            className="rounded-lg border border-border px-4 py-2 text-sm"
            to={`${base}/leads/${lead.id}/edit`}
          >
            Edit lead
          </Link>
        )}
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <section className="space-y-4 rounded-xl border border-border bg-card p-5">
          <h3 className="font-semibold">Opportunity</h3>
          <p className="whitespace-pre-wrap text-sm leading-6">
            {lead.description || 'No description yet.'}
          </p>
          <p className="text-sm">
            Contact:{' '}
            <Link className="underline" to={`${base}/contacts/${lead.contact_id}`}>
              {lead.contact.display_name}
            </Link>
          </p>
          {lead.contact.emails.map((v) => (
            <p key={v.normalized} className="break-all text-sm text-muted-foreground">
              {v.value}
            </p>
          ))}
          {lead.contact.phones.map((v, i) => (
            <p key={i} className="text-sm text-muted-foreground">
              {v.value}
            </p>
          ))}
        </section>
        <section className="space-y-3 rounded-xl border border-border bg-card p-5">
          <h3 className="font-semibold">Acquisition</h3>
          <p className="text-sm capitalize">{lead.attribution?.channel ?? 'No attribution'}</p>
          {lead.attribution?.campaign && (
            <p className="text-sm">Campaign: {lead.attribution.campaign}</p>
          )}
          {lead.attribution?.external_reference && (
            <p className="text-sm">Reference: {lead.attribution.external_reference}</p>
          )}
          {lead.attribution?.landing_url && (
            <p className="break-all text-sm">{lead.attribution.landing_url}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Recorded {new Date(lead.attribution?.accepted_at ?? lead.created_at).toLocaleString()}
          </p>
          {lead.attribution?.claimed_acquired_at && (
            <p className="text-xs text-muted-foreground">
              Claimed acquisition: {new Date(lead.attribution.claimed_acquired_at).toLocaleString()}
            </p>
          )}
        </section>
      </div>
      <LeadActions key={`${lead.id}/${lead.version}`} lead={lead} refresh={refresh} />
      <Timeline kind="leads" id={lead.id} />
    </div>
  );
}
function LeadActions({ lead, refresh }: { lead: Lead; refresh: () => void }) {
  const { organization } = useOrganization(),
    { state: identity } = useIdentity(),
    { confirmDiscard, store } = useDrafts(),
    manage = can(organization.role, 'crm_manage');
  const form = useDraft(`lead-transition:${lead.id}`, {
      version: lead.version,
      status: (lead.status === 'closed'
        ? 'in_progress'
        : lead.status === 'in_progress'
          ? 'qualified'
          : 'in_progress') as 'in_progress' | 'qualified' | 'closed',
      outcome: 'won' as 'won' | 'lost' | 'unqualified',
      reason: '',
    }),
    { draft, update } = form;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [assignee, setAssignee] = useState(lead.current_assignee_id ?? '');
  const load = useCallback(
      (s: AbortSignal) => apiClient.members(organization.id, s),
      [organization.id],
    ),
    members = useQuery(`${organization.id}/assignees`, load);
  const user = identity.status === 'ready' ? identity.session.user?.id : null;
  const run = (action: () => Promise<unknown>) =>
    confirmDiscard(() => {
      store.discardActive();
      setBusy(true);
      setError('');
      void action()
        .then(refresh)
        .catch((e) => setError(crmMessage(e)))
        .finally(() => setBusy(false));
    });
  async function transition(e: FormEvent) {
    e.preventDefault();
    update((v) => ({ ...v, phase: 'saving', error: '' }));
    try {
      await apiClient.transitionLead(organization.id, lead.id, {
        version: draft.value.version,
        status: draft.value.status,
        ...(draft.value.status === 'closed' ? { outcome: draft.value.outcome } : {}),
        ...(lead.status === 'closed' ? { reason: draft.value.reason } : {}),
      });
      form.clear();
      refresh();
    } catch (e) {
      update((v) => ({ ...v, phase: 'editing', error: crmMessage(e) }));
    }
  }
  return (
    <section className="space-y-5 rounded-xl border border-border bg-card p-5">
      <h3 className="font-semibold">Next step</h3>
      {!lead.archived_at && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <p className="w-full text-sm">
              {lead.current_assignee_id
                ? `Assigned to ${members.state.status === 'ready' ? members.state.data.find((v) => v.userId === lead.current_assignee_id)?.displayName || 'a team member' : 'a team member'}`
                : lead.last_assigned_user_id
                  ? 'Unassigned · previous assignment retained in history'
                  : 'Unassigned'}
            </p>
            {manage ? (
              <>
                <label className="text-sm">
                  Assign to
                  <select
                    className="field"
                    value={assignee}
                    onChange={(e) => setAssignee(e.currentTarget.value)}
                  >
                    <option value="">Unassigned</option>
                    {members.state.status === 'ready' &&
                      members.state.data
                        .filter((v) => !v.revoked)
                        .map((v) => (
                          <option value={v.userId} key={v.userId}>
                            {v.displayName || 'Team member'} · {v.role}
                          </option>
                        ))}
                  </select>
                </label>
                <Button
                  variant="outline"
                  disabled={busy || lead.status === 'closed'}
                  onClick={() =>
                    run(() =>
                      apiClient.assignLead(
                        organization.id,
                        lead.id,
                        lead.version,
                        assignee || null,
                      ),
                    )
                  }
                >
                  Update assignment
                </Button>
              </>
            ) : (
              lead.status !== 'closed' &&
              user &&
              (!lead.current_assignee_id || lead.current_assignee_id === user) && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      apiClient.assignLead(
                        organization.id,
                        lead.id,
                        lead.version,
                        lead.current_assignee_id === user ? null : user,
                      ),
                    )
                  }
                >
                  {lead.current_assignee_id === user ? 'Release lead' : 'Claim lead'}
                </Button>
              )
            )}
          </div>
          {(lead.status !== 'closed' || manage) && (
            <form onSubmit={(e) => void transition(e)} className="space-y-3">
              <fieldset
                disabled={busy || draft.phase === 'saving'}
                className="grid gap-3 sm:grid-cols-2"
              >
                <label className="text-sm">
                  Move lead to
                  <select
                    className="field"
                    value={draft.value.status}
                    onChange={(e) =>
                      form.change({
                        ...draft.value,
                        status: e.currentTarget.value as typeof draft.value.status,
                      })
                    }
                  >
                    {(lead.status === 'closed'
                      ? ['in_progress']
                      : lead.status === 'new'
                        ? ['in_progress', 'qualified', 'closed']
                        : lead.status === 'in_progress'
                          ? ['qualified', 'closed']
                          : ['in_progress', 'closed']
                    ).map((v) => (
                      <option value={v} key={v}>
                        {v.replaceAll('_', ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                {draft.value.status === 'closed' && (
                  <label className="text-sm">
                    Closing outcome
                    <select
                      className="field"
                      value={draft.value.outcome}
                      onChange={(e) =>
                        form.change({
                          ...draft.value,
                          outcome: e.currentTarget.value as typeof draft.value.outcome,
                        })
                      }
                    >
                      {['won', 'lost', 'unqualified'].map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                )}
                {lead.status === 'closed' && (
                  <label className="text-sm">
                    Reason for reopening
                    <input
                      className="field"
                      required
                      maxLength={300}
                      value={draft.value.reason}
                      onChange={(e) =>
                        form.change({ ...draft.value, reason: e.currentTarget.value })
                      }
                    />
                  </label>
                )}
              </fieldset>
              {draft.error && <p role="alert">{draft.error}</p>}
              <Button type="submit" disabled={!form.enabled || busy || draft.phase === 'saving'}>
                {draft.phase === 'saving'
                  ? 'Saving…'
                  : lead.status === 'closed'
                    ? 'Reopen lead'
                    : 'Save status'}
              </Button>
            </form>
          )}
        </>
      )}
      {manage && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(() =>
              apiClient.archiveLead(
                organization.id,
                lead.id,
                lead.version,
                Boolean(lead.archived_at),
              ),
            )
          }
        >
          {lead.archived_at ? 'Restore lead' : 'Archive lead'}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function ContactView({ contact, refresh }: { contact: Contact; refresh: () => void }) {
  const { organization } = useOrganization(),
    { confirmDiscard } = useDrafts(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    base = `/organizations/${organization.id}`;
  const load = useCallback(
      (s: AbortSignal) =>
        apiClient.leads(organization.id, { contactId: contact.id, archived: 'all' }, s),
      [organization.id, contact.id],
    ),
    related = useQuery(`${organization.id}/${contact.id}/related-leads`, load);
  return (
    <div className="space-y-7">
      <Link className="text-sm underline" to={`${base}/contacts`}>
        Back to contacts
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs uppercase text-muted-foreground">
            {contact.archived_at ? 'Archived contact' : contact.kind}
          </p>
          <h2 className="text-3xl font-semibold">{contact.display_name}</h2>
          {contact.company_name && (
            <p className="mt-2 text-muted-foreground">{contact.company_name}</p>
          )}
        </div>
        {!contact.archived_at && (
          <Link
            className="rounded-lg border border-border px-4 py-2 text-sm"
            to={`${base}/contacts/${contact.id}/edit`}
          >
            Edit contact
          </Link>
        )}
      </div>
      <section className="grid gap-6 rounded-xl border border-border bg-card p-5 sm:grid-cols-2">
        <div>
          <h3 className="mb-3 font-semibold">Email</h3>
          {contact.emails.length ? (
            contact.emails.map((v, i) => (
              <p className="mb-2 break-all text-sm" key={v.normalized}>
                {v.value}
                {i === 0 ? ' · primary' : ''}
              </p>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No email yet.</p>
          )}
        </div>
        <div>
          <h3 className="mb-3 font-semibold">Phone</h3>
          {contact.phones.length ? (
            contact.phones.map((v, i) => (
              <p className="mb-2 text-sm" key={i}>
                {v.value}
                {i === 0 ? ' · primary' : ''}
                {!v.normalized ? ' · local format, unmatched' : ''}
              </p>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No phone yet.</p>
          )}
        </div>
      </section>
      {contact.first_touch && (
        <section className="rounded-xl border border-border p-5">
          <h3 className="font-semibold">First recorded touch</h3>
          <p className="mt-2 text-sm capitalize">
            {contact.first_touch.channel} ·{' '}
            {new Date(contact.first_touch.acceptedAt).toLocaleString()}
          </p>
          {contact.first_touch.campaign && (
            <p className="mt-2 text-sm">{contact.first_touch.campaign}</p>
          )}
          <Link
            className="mt-2 block text-sm underline"
            to={`${base}/leads/${contact.first_touch.leadId}`}
          >
            Open first lead
          </Link>
        </section>
      )}
      {can(organization.role, 'crm_manage') && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            confirmDiscard(() => {
              setBusy(true);
              setError('');
              void apiClient
                .archiveContact(
                  organization.id,
                  contact.id,
                  contact.version,
                  Boolean(contact.archived_at),
                )
                .then(refresh)
                .catch((e) => setError(crmMessage(e)))
                .finally(() => setBusy(false));
            })
          }
        >
          {contact.archived_at ? 'Restore contact' : 'Archive contact'}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      <section className="space-y-3">
        <h3 className="text-lg font-semibold">Related leads</h3>
        {related.state.status === 'loading' ? (
          <p role="status">Loading related leads…</p>
        ) : related.state.status === 'error' ? (
          <CrmFailure error={related.state.error} retry={related.refresh} />
        ) : (
          <>
            <ul className="space-y-2">
              {related.state.data.items.map((v) => (
                <li key={v.id} className="rounded-lg border border-border p-3 text-sm">
                  <Link className="underline" to={`${base}/leads/${v.id}`}>
                    {v.title}
                  </Link>
                  <span className="ml-3 capitalize text-muted-foreground">
                    {v.status.replaceAll('_', ' ')}
                    {v.archived_at ? ' · archived' : ''}
                  </span>
                </li>
              ))}
            </ul>
            {!related.state.data.items.length && (
              <p className="text-sm text-muted-foreground">No related leads yet.</p>
            )}
            {related.state.data.cursor && (
              <p className="text-xs text-muted-foreground">Showing the latest 25 related leads.</p>
            )}
          </>
        )}
      </section>
      <Timeline kind="contacts" id={contact.id} />
    </div>
  );
}
function Timeline({ kind, id }: { kind: 'leads' | 'contacts'; id: string }) {
  const { organization } = useOrganization(),
    [cursor, setCursor] = useState<string | undefined>(),
    [previous, setPrevious] = useState<string[]>([]);
  const load = useCallback(
      (s: AbortSignal) =>
        apiClient.activity(organization.id, kind, id, { ...(cursor ? { cursor } : {}) }, s),
      [organization.id, kind, id, cursor],
    ),
    { state, refresh } = useQuery(
      `${organization.id}/${kind}/${id}/activity/${cursor ?? ''}`,
      load,
    );
  return (
    <section className="space-y-4">
      <h3 className="text-lg font-semibold">Activity</h3>
      {state.status === 'loading' ? (
        <p role="status">Loading activity…</p>
      ) : state.status === 'error' ? (
        <CrmFailure error={state.error} retry={refresh} />
      ) : (
        <>
          <ol className="space-y-3">
            {state.data.items.map((v) => (
              <li className="rounded-lg border border-border bg-card p-4 text-sm" key={v.id}>
                <p className="font-medium">
                  {v.event.replaceAll('.', ' · ').replaceAll('_', ' ')}
                  {kind === 'leads' && v.subject === 'contact' ? ' · shared contact' : ''}
                </p>
                <time className="mt-1 block text-xs text-muted-foreground">
                  {new Date(v.created_at).toLocaleString()}
                </time>
                {v.event === 'lead.transitioned' && (
                  <p className="mt-2 capitalize">
                    {v.details.from.replaceAll('_', ' ')} → {v.details.to.replaceAll('_', ' ')}
                    {v.details.outcome ? ` · ${v.details.outcome}` : ''}
                  </p>
                )}
                {v.reason && <p className="mt-2 whitespace-pre-wrap">{v.reason}</p>}
              </li>
            ))}
          </ol>
          {!state.data.items.length && (
            <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
          )}
          <div className="flex gap-3">
            <Button
              variant="outline"
              disabled={!previous.length}
              onClick={() => {
                setCursor(previous.at(-1) || undefined);
                setPrevious((v) => v.slice(0, -1));
              }}
            >
              Newer activity
            </Button>
            <Button
              variant="outline"
              disabled={!state.data.cursor}
              onClick={() => {
                setPrevious((v) => [...v, cursor ?? '']);
                setCursor(state.data.cursor ?? undefined);
              }}
            >
              Older activity
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
