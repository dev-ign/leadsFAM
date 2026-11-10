import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Button } from '@leadops/ui';
import {
  can,
  messageDraftSchema,
  communicationSettingsInput,
  permissionInputSchema,
  type CommunicationMessage,
  type Contact,
  type InboundReview,
} from '@leadops/shared';
import { ConversationNextAction } from '../ai/conversation';
import { apiClient } from '../../lib/api-client';
import { useOrganization } from '../organizations/context';
import { useQuery } from '../crm/use-query';
import { useDraft } from '../crm/use-draft';
import { useDrafts } from '../crm/draft-context';
import { communicationError, communicationReason } from './errors';

function Failure({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert">
      <p>{communicationError(error)}</p>
      <Button variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}
function useOperation() {
  const { organization } = useOrganization();
  const { store } = useDrafts();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return {
    busy,
    error,
    run: async (operation: () => Promise<unknown>, done: () => void) => {
      const token = store.token(organization.id);
      setBusy(true);
      setError('');
      try {
        await operation();
        if (store.visible(token)) done();
      } catch (e) {
        if (store.visible(token)) setError(communicationError(e));
      } finally {
        if (store.visible(token)) setBusy(false);
      }
    },
  };
}
export function ConversationsPage() {
  const { organization } = useOrganization();
  return <ConversationList key={organization.id} />;
}
function ConversationList() {
  const { organization } = useOrganization(),
    [params] = useSearchParams(),
    contactId = params.get('contactId') ?? undefined,
    leadId = params.get('leadId') ?? undefined;
  const [cursor, setCursor] = useState<string | undefined>();
  const load = useCallback(
    (s: AbortSignal) =>
      apiClient.conversations(
        organization.id,
        {
          ...(contactId ? { contactId } : {}),
          ...(leadId ? { leadId } : {}),
          ...(cursor ? { cursor } : {}),
        },
        s,
      ),
    [organization.id, contactId, leadId, cursor],
  );
  const { state, refresh } = useQuery(`communications:${contactId}:${leadId}:${cursor}`, load),
    base = `/organizations/${organization.id}`;
  return (
    <section className="max-w-5xl space-y-5">
      <h2 className="text-3xl font-semibold">Conversations</h2>
      <p>Mock email and SMS only. No messages leave LeadsFam.</p>
      <div className="flex flex-wrap gap-4">
        <Link
          className="underline"
          to={`${base}/communications/compose${contactId ? `?contactId=${contactId}${leadId ? `&leadId=${leadId}` : ''}` : ''}`}
        >
          Compose message
        </Link>
        <Link className="underline" to={`${base}/communications/settings`}>
          Communication settings
        </Link>
        <Button variant="outline" onClick={refresh}>
          Refresh status
        </Button>
      </div>
      <IncomingReview onLinked={refresh} />
      {state.status === 'loading' ? (
        <p role="status">Loading conversations…</p>
      ) : state.status === 'error' ? (
        <Failure error={state.error} retry={refresh} />
      ) : (
        <>
          <ul className="space-y-3">
            {state.data.items.map((c) => (
              <li className="rounded-xl border border-border p-4" key={c.id}>
                <Link className="font-semibold underline" to={`${base}/communications/${c.id}`}>
                  {c.contact_name} · {c.channel === 'sms' ? 'SMS' : 'Email'}
                </Link>
                <p>{c.lead_title ?? 'Contact conversation'}</p>
                <p className="text-sm">
                  Latest activity status: {c.state.replaceAll('_', ' ')} ·{' '}
                  {new Date(c.updated_at).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
          {!state.data.items.length && (
            <p>No conversations yet. Open a contact to prepare a message.</p>
          )}
          <div className="flex gap-3">
            {cursor && (
              <Button variant="outline" onClick={() => setCursor(undefined)}>
                Newest conversations
              </Button>
            )}
            {state.data.next && (
              <Button variant="outline" onClick={() => setCursor(state.data.next ?? undefined)}>
                Older conversations
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
export function ConversationDetailPage() {
  const { organization } = useOrganization(),
    { id = '' } = useParams();
  return <History key={`${organization.id}:${id}`} id={id} />;
}
function History({ id }: { id: string }) {
  const { organization } = useOrganization(),
    [cursor, setCursor] = useState<string | undefined>();
  const load = useCallback(
    (s: AbortSignal) => apiClient.communicationHistory(organization.id, id, cursor, s),
    [organization.id, id, cursor],
  );
  const { state, refresh } = useQuery(`communication-history:${id}:${cursor}`, load),
    action = useOperation(),
    base = `/organizations/${organization.id}`;
  return (
    <section className="max-w-4xl space-y-5">
      <h2 className="text-3xl font-semibold">Message history</h2>
      <p>All provider results shown here are simulated.</p>
      <div className="flex gap-4">
        <Link className="underline" to={`${base}/communications`}>
          All conversations
        </Link>
        <Button variant="outline" onClick={refresh}>
          Refresh status
        </Button>
      </div>
      {action.error && <p role="alert">{action.error}</p>}
      <ConversationNextAction conversationId={id} />
      {state.status === 'loading' ? (
        <p role="status">Loading messages…</p>
      ) : state.status === 'error' ? (
        <Failure error={state.error} retry={refresh} />
      ) : (
        <>
          <ol className="space-y-4">
            {state.data.messages.map((m) => (
              <li key={m.id} className="space-y-3 rounded-xl border border-border p-5">
                <p className="font-semibold">
                  {m.direction === 'outbound' ? 'Outgoing' : 'Incoming'}{' '}
                  {m.channel === 'sms' ? 'SMS' : 'email'} ·{' '}
                  {m.direction === 'inbound' ? 'Received' : m.state.replaceAll('_', ' ')}
                </p>
                <p className="break-all text-sm">
                  From {m.sender} · To {m.recipient}
                </p>
                {m.subject && <h3 className="font-medium">{m.subject}</h3>}
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className="text-sm">
                  {new Date(m.created_at).toLocaleString()} · {m.purpose}
                </p>
                {m.direction === 'inbound' && (
                  <p className="text-sm text-muted-foreground">
                    Simulated customer reply · {m.integration_name ?? 'Historical mock message'} ·
                    Received {new Date(m.created_at).toLocaleString()}
                  </p>
                )}
                {m.code && <p role="status">{communicationReason(m.code)}</p>}
                <div className="flex flex-wrap gap-4">
                  <Link className="underline" to={`${base}/contacts/${m.contact_id}`}>
                    Contact record
                  </Link>
                  {m.lead_id && (
                    <Link className="underline" to={`${base}/leads/${m.lead_id}`}>
                      Lead record
                    </Link>
                  )}
                  <Link
                    className="underline"
                    to={`${base}/communications/compose?contactId=${m.contact_id}${m.lead_id ? `&leadId=${m.lead_id}` : ''}${m.state === 'draft' ? `&messageId=${m.id}` : ''}`}
                  >
                    {m.state === 'draft' ? 'Open draft' : 'Prepare another message'}
                  </Link>
                </div>
                {m.state === 'attention' && can(organization.role, 'crm_manage') && (
                  <Button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () => apiClient.reconcileMessage(organization.id, m.id, m.version),
                        refresh,
                      )
                    }
                  >
                    Check delivery status safely
                  </Button>
                )}
                <MessageEventHistory id={m.id} />
              </li>
            ))}
          </ol>
          {!state.data.messages.length && <p>No messages on this page.</p>}
          <div className="flex gap-3">
            {cursor && (
              <Button variant="outline" onClick={() => setCursor(undefined)}>
                First messages
              </Button>
            )}
            {state.data.next && (
              <Button variant="outline" onClick={() => setCursor(state.data.next ?? undefined)}>
                Next messages
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
const reviewReasons: Record<InboundReview['reason'], string> = {
  unknown_customer: 'Unknown customer',
  multiple_contacts: 'More than one saved contact matches',
  multiple_conversations: 'Multiple possible conversations',
  no_matching_lead: 'No matching lead',
  reply_unverified: 'Reply reference could not be verified',
};
function IncomingReview({ onLinked }: { onLinked: () => void }) {
  const { organization } = useOrganization();
  const linkedStatus = useRef<HTMLParagraphElement>(null);
  const [cursor, setCursor] = useState<string | undefined>(),
    [selected, setSelected] = useState<InboundReview | null>(null),
    [linked, setLinked] = useState<CommunicationMessage | null>(null);
  useEffect(() => {
    if (linked) linkedStatus.current?.focus();
  }, [linked]);
  const load = useCallback(
    (signal: AbortSignal) => apiClient.inboundReview(organization.id, cursor, signal),
    [organization.id, cursor],
  );
  const { state, refresh } = useQuery(`inbound-review:${cursor}`, load);
  return (
    <section
      aria-labelledby="incoming-review-title"
      className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="incoming-review-title" className="text-xl font-semibold">
          Incoming replies · Needs review
        </h3>
        <Button variant="outline" onClick={refresh}>
          Refresh incoming replies
        </Button>
      </div>
      <p className="text-sm">
        Simulated email and SMS. Choose an existing customer and lead when a reply cannot be matched
        safely. Linking never sends a response.
      </p>
      {linked && (
        <p role="status" ref={linkedStatus} tabIndex={-1}>
          Reply linked.{' '}
          <Link
            className="underline"
            to={`/organizations/${organization.id}/communications/${linked.conversation_id}`}
          >
            Open the conversation
          </Link>
        </p>
      )}
      {selected ? (
        <IncomingLink
          key={selected.id}
          receipt={selected}
          onCancel={() => setSelected(null)}
          onLinked={(message) => {
            setLinked(message);
            setSelected(null);
            refresh();
            onLinked();
          }}
        />
      ) : state.status === 'loading' ? (
        <p role="status">Loading incoming replies…</p>
      ) : state.status === 'error' ? (
        <Failure error={state.error} retry={refresh} />
      ) : (
        <>
          <ul className="space-y-3">
            {state.data.items.map((r) => (
              <li key={r.id} className="min-w-0 rounded-lg border border-border p-3">
                <p className="break-all font-medium">
                  {r.sender} · {r.channel === 'sms' ? 'SMS' : 'Email'}
                </p>
                <p>{reviewReasons[r.reason]}</p>
                <p className="break-words">{r.subject || r.body.slice(0, 160)}</p>
                <p className="text-sm">
                  Received {new Date(r.received_at).toLocaleString()} · Simulated ·{' '}
                  {r.integration_name}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setLinked(null);
                    setSelected(r);
                  }}
                >
                  Review reply
                </Button>
              </li>
            ))}
          </ul>
          {!state.data.items.length && <p>No incoming replies need review.</p>}
          <div className="flex flex-wrap gap-3">
            {cursor && (
              <Button variant="outline" onClick={() => setCursor(undefined)}>
                Newest incoming replies
              </Button>
            )}
            {state.data.next && (
              <Button variant="outline" onClick={() => setCursor(state.data.next ?? undefined)}>
                Older incoming replies
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
function IncomingLink({
  receipt,
  onCancel,
  onLinked,
}: {
  receipt: InboundReview;
  onCancel: () => void;
  onLinked: (message: CommunicationMessage) => void;
}) {
  const [contact, setContact] = useState<Pick<Contact, 'id' | 'display_name'> | null>(null);
  const action = useOperation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div className="min-w-0 space-y-4">
      <h3 ref={heading} tabIndex={-1} className="font-semibold">
        Review incoming reply
      </h3>
      <p className="break-all">
        From {receipt.sender} · {reviewReasons[receipt.reason]}
      </p>
      {receipt.subject && <p className="break-words font-medium">{receipt.subject}</p>}
      <p className="whitespace-pre-wrap break-words">{receipt.body}</p>
      <p className="text-sm">
        Received {new Date(receipt.received_at).toLocaleString()} · Simulated ·{' '}
        {receipt.integration_name}
      </p>
      {contact ? (
        <>
          <p>
            Selected customer: <strong>{contact.display_name}</strong>
          </p>
          <Button variant="outline" disabled={action.busy} onClick={() => setContact(null)}>
            Choose another customer
          </Button>
          <IncomingLead
            key={contact.id}
            receipt={receipt}
            contact={contact}
            onLinked={onLinked}
            action={action}
          />
        </>
      ) : (
        <ChooseContact onChoose={setContact} />
      )}
      <Button variant="outline" disabled={action.busy} onClick={onCancel}>
        Back to incoming replies
      </Button>
    </div>
  );
}
function IncomingLead({
  receipt,
  contact,
  onLinked,
  action,
}: {
  receipt: InboundReview;
  contact: Pick<Contact, 'id' | 'display_name'>;
  onLinked: (message: CommunicationMessage) => void;
  action: ReturnType<typeof useOperation>;
}) {
  const { organization } = useOrganization();
  const [leadId, setLeadId] = useState(''),
    [cursor, setCursor] = useState<string | undefined>();
  const load = useCallback(
    (signal: AbortSignal) =>
      apiClient.leads(
        organization.id,
        { contactId: contact.id, pageSize: 25, ...(cursor ? { cursor } : {}) },
        signal,
      ),
    [organization.id, contact.id, cursor],
  );
  const { state, refresh } = useQuery(`inbound-leads:${contact.id}:${cursor}`, load);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!leadId || action.busy) return;
        let result: CommunicationMessage;
        void action.run(
          async () => {
            result = await apiClient.linkInbound(organization.id, receipt.id, {
              contactId: contact.id,
              leadId,
            });
          },
          () => onLinked(result),
        );
      }}
    >
      {state.status === 'loading' ? (
        <p role="status">Loading this customer's leads…</p>
      ) : state.status === 'error' ? (
        <Failure error={state.error} retry={refresh} />
      ) : (
        <>
          <label className="block">
            Existing lead
            <select
              className="field"
              required
              value={leadId}
              onChange={(e) => setLeadId(e.currentTarget.value)}
            >
              <option value="">Choose the correct inquiry</option>
              {state.data.items.map((lead) => (
                <option value={lead.id} key={lead.id}>
                  {lead.title} · {lead.status.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          {!state.data.items.length && (
            <p>
              No active leads for this customer. Create or restore the correct lead in the CRM
              first.
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {cursor && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setLeadId('');
                  setCursor(undefined);
                }}
              >
                First leads
              </Button>
            )}
            {state.data.cursor && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setLeadId('');
                  setCursor(state.data.cursor ?? undefined);
                }}
              >
                More leads
              </Button>
            )}
          </div>
          {leadId && (
            <p>
              This reply will appear under <strong>{contact.display_name}</strong> and{' '}
              <strong>{state.data.items.find((l) => l.id === leadId)?.title}</strong>. No contact
              details, lead status or sending permission will change.
            </p>
          )}
          <Button type="submit" disabled={!leadId || action.busy}>
            {action.busy ? 'Linking reply…' : 'Confirm link to this lead'}
          </Button>
        </>
      )}
      {action.error && (
        <p role="alert">
          {action.error} Refresh incoming replies if another team member already linked this
          message.
        </p>
      )}
    </form>
  );
}
function MessageEventHistory({ id }: { id: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>Processing history</summary>
      {expanded && <EventPage id={id} />}
    </details>
  );
}
function EventPage({ id }: { id: string }) {
  const { organization } = useOrganization(),
    [cursor, setCursor] = useState<string | undefined>();
  const load = useCallback(
    (signal: AbortSignal) => apiClient.communicationEvents(organization.id, id, cursor, signal),
    [organization.id, id, cursor],
  );
  const { state, refresh } = useQuery(`message-events:${id}:${cursor}`, load);
  return state.status === 'loading' ? (
    <p role="status">Loading events…</p>
  ) : state.status === 'error' ? (
    <Failure error={state.error} retry={refresh} />
  ) : (
    <>
      <ol className="mt-2 space-y-1 text-sm">
        {state.data.items.map((e) => (
          <li key={e.id}>
            {e.event.replaceAll('_', ' ')} · {new Date(e.created_at).toLocaleString()}
          </li>
        ))}
      </ol>
      {cursor && (
        <Button variant="outline" onClick={() => setCursor(undefined)}>
          First events
        </Button>
      )}
      {state.data.next && (
        <Button variant="outline" onClick={() => setCursor(state.data.next ?? undefined)}>
          Next events
        </Button>
      )}
    </>
  );
}
export function ComposeMessagePage() {
  const { organization } = useOrganization(),
    [params] = useSearchParams(),
    contactId = params.get('contactId') ?? '',
    leadId = params.get('leadId'),
    messageId = params.get('messageId');
  return contactId ? (
    <ComposeLoader
      key={`${organization.id}:${contactId}:${messageId}`}
      contactId={contactId}
      leadId={leadId}
      messageId={messageId}
    />
  ) : (
    <ChooseContact key={organization.id} />
  );
}
function ChooseContact({
  onChoose,
}: { onChoose?: (contact: Pick<Contact, 'id' | 'display_name'>) => void } = {}) {
  const { organization } = useOrganization(),
    [search, setSearch] = useState(''),
    [submitted, setSubmitted] = useState('');
  const load = useCallback(
    (s: AbortSignal) => apiClient.contacts(organization.id, { q: submitted, pageSize: 25 }, s),
    [organization.id, submitted],
  );
  const { state, refresh } = useQuery(`message-contact:${submitted}`, load);
  return (
    <section className="max-w-3xl space-y-4">
      <h2 className="text-3xl font-semibold">Choose a contact</h2>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(search);
        }}
      >
        <label className="block">
          Contact name or email
          <input
            className="field"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </label>
        <Button type="submit">Search contacts</Button>
      </form>
      {state.status === 'loading' ? (
        <p role="status">Loading contacts…</p>
      ) : state.status === 'error' ? (
        <Failure error={state.error} retry={refresh} />
      ) : (
        <>
          <ul className="space-y-3">
            {state.data.items.map((c) => (
              <li key={c.id}>
                {onChoose ? (
                  <Button variant="outline" onClick={() => onChoose(c)}>
                    {c.display_name}
                  </Button>
                ) : (
                  <Link className="underline" to={`?contactId=${c.id}`}>
                    {c.display_name}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {!state.data.items.length && (
            <p>No matching contacts. Create a contact in the CRM first.</p>
          )}
          <p>Showing up to 25 contacts. Search to narrow the list.</p>
        </>
      )}
    </section>
  );
}
function ComposeLoader({
  contactId,
  leadId,
  messageId,
}: {
  contactId: string;
  leadId: string | null;
  messageId: string | null;
}) {
  const { organization } = useOrganization();
  const load = useCallback(
    async (s: AbortSignal) => {
      const [contact, message] = await Promise.all([
        apiClient.contact(organization.id, contactId, s),
        messageId
          ? apiClient.communicationMessage(organization.id, messageId, s)
          : Promise.resolve(null),
      ]);
      return { contact, message };
    },
    [organization.id, contactId, messageId],
  );
  const { state, refresh } = useQuery(`compose:${contactId}:${messageId}`, load);
  if (state.status === 'loading') return <p role="status">Loading recipient…</p>;
  if (state.status === 'error') return <Failure error={state.error} retry={refresh} />;
  if (
    state.data.message &&
    (state.data.message.contact_id !== contactId || state.data.message.state !== 'draft')
  )
    return (
      <p>
        This draft is no longer editable.{' '}
        <Link
          className="underline"
          to={`/organizations/${organization.id}/communications/${state.data.message.conversation_id}`}
        >
          Open its conversation to review the current status.
        </Link>
      </p>
    );
  return (
    <Composer
      key={`${contactId}:${messageId}`}
      contact={state.data.contact}
      leadId={state.data.message?.lead_id ?? leadId}
      initial={state.data.message}
    />
  );
}
function Composer({
  contact,
  leadId,
  initial,
}: {
  contact: Contact;
  leadId: string | null;
  initial: CommunicationMessage | null;
}) {
  const { store } = useDrafts();
  const { organization } = useOrganization(),
    form = useDraft(`message-compose:${contact.id}:${leadId}:${initial?.id ?? 'new'}`, {
      id: initial?.id ?? crypto.randomUUID(),
      contactId: contact.id,
      leadId,
      channel: initial?.channel ?? ('email' as const),
      purpose: initial?.purpose ?? ('transactional' as const),
      recipient: initial?.recipient ?? contact.emails[0]?.normalized ?? '',
      subject: initial?.subject ?? '',
      body: initial?.body ?? '',
      version: initial?.version,
    });
  const { draft, update } = form,
    [saved, setSaved] = useState<CommunicationMessage | null>(initial),
    [confirmed, setConfirmed] = useState(false),
    [sent, setSent] = useState<CommunicationMessage | null>(null),
    review = useRef<HTMLHeadingElement>(null);
  const [eligibility, setEligibility] = useState<string | null>('CONSENT_REQUIRED'),
    base = `/organizations/${organization.id}`;
  const value = draft.value,
    locked = draft.phase === 'saving';
  const change = (next: typeof value) => {
    form.change(next);
    setSaved(null);
    setConfirmed(false);
  };
  async function save(e: FormEvent) {
    e.preventDefault();
    const parsed = messageDraftSchema.safeParse(valueWithoutVersion());
    if (!parsed.success) {
      update((v) => ({
        ...v,
        error:
          'Enter a valid destination, a subject for email, and a message. SMS allows up to 1600 characters.',
      }));
      return;
    }
    update((v) => ({ ...v, phase: 'saving', error: '' }));
    try {
      const m = await apiClient.saveMessageDraft(organization.id, {
        ...parsed.data,
        ...(value.version ? { version: value.version } : {}),
      });
      if (!form.visible()) return;
      setSaved(m);
      update((v) => ({
        ...v,
        phase: 'editing',
        dirty: false,
        value: { ...v.value, version: m.version },
      }));
      queueMicrotask(() => review.current?.focus());
    } catch (e) {
      update((v) => ({
        ...v,
        phase: 'editing',
        error: `${communicationError(e)} Your draft is preserved. Retry the same draft to check a potentially completed save.`,
      }));
    }
  }
  function valueWithoutVersion() {
    const { version, ...input } = value;
    void version;
    return input;
  }
  async function send() {
    if (!saved || !confirmed) return;
    update((v) => ({ ...v, phase: 'saving', error: '' }));
    try {
      const m = await apiClient.sendMessage(organization.id, saved.id, saved.version);
      if (!form.visible()) return;
      setSent(m);
      form.clear();
      const aliasKey = `message-compose:${contact.id}:${leadId}:new`;
      if (store.read<typeof value>(organization.id, aliasKey)?.value.id === m.id)
        store.remove(store.token(organization.id), aliasKey);
    } catch (e) {
      update((v) => ({
        ...v,
        phase: 'editing',
        error: `${communicationError(e)} If the result is uncertain, retry this same approval or open the conversation before creating another message.`,
      }));
    }
  }
  if (sent)
    return (
      <section className="space-y-4">
        <h2 className="text-3xl font-semibold">
          {sent.state === 'queued'
            ? 'Message queued for mock delivery'
            : `Message status: ${sent.state}`}{' '}
        </h2>
        <p>Queued messages still need processing. All delivery results are simulated.</p>
        <Link className="underline" to={`${base}/communications/${sent.conversation_id}`}>
          View delivery status and history
        </Link>
        <Link className="ml-4 underline" to={`${base}/contacts/${contact.id}`}>
          Back to contact
        </Link>
      </section>
    );
  return (
    <section className="max-w-3xl space-y-6">
      <h2 className="text-3xl font-semibold">Compose message</h2>
      <p>To {contact.display_name} · Mock delivery only. No external message is sent.</p>
      <Link className="underline" to={`${base}/contacts/${contact.id}`}>
        Contact record
      </Link>
      <form onSubmit={(e) => void save(e)} className="space-y-4">
        <fieldset disabled={locked} className="space-y-4">
          <legend className="sr-only">Message content</legend>
          <label className="block">
            Channel
            <select
              className="field"
              value={value.channel}
              disabled={Boolean(value.version)}
              onChange={(e) => {
                const channel = e.currentTarget.value as 'email' | 'sms';
                change({
                  ...value,
                  channel,
                  recipient:
                    channel === 'email'
                      ? (contact.emails[0]?.normalized ?? '')
                      : (contact.phones.find((p) => p.normalized)?.normalized ?? ''),
                  subject: channel === 'email' ? value.subject : '',
                });
              }}
            >
              <option value="email">Email</option>
              <option value="sms">SMS</option>
            </select>
          </label>
          <p className="text-sm">
            Sender: {value.channel === 'email' ? 'FreshNest <mock@example.test>' : '+15005550006'}{' '}
            (simulation)
          </p>
          <label className="block">
            Recipient
            <input
              className="field"
              list="communication-destinations"
              type={value.channel === 'email' ? 'email' : 'tel'}
              required
              maxLength={254}
              value={value.recipient}
              onChange={(e) => change({ ...value, recipient: e.currentTarget.value })}
            />
            <datalist id="communication-destinations">
              {(value.channel === 'email'
                ? contact.emails.map((e) => e.normalized)
                : contact.phones.flatMap((p) => (p.normalized ? [p.normalized] : []))
              ).map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </label>
          <p className="text-sm">
            Choose a destination on this contact. SMS needs a number beginning with + and a country
            code.
          </p>
          <label className="block">
            Purpose
            <select
              className="field"
              value={value.purpose}
              onChange={(e) =>
                change({
                  ...value,
                  purpose: e.currentTarget.value as 'transactional' | 'marketing',
                })
              }
            >
              <option value="transactional">Service or transactional</option>
              <option value="marketing">Marketing</option>
            </select>
          </label>
          {value.channel === 'email' && (
            <label className="block">
              Subject
              <input
                className="field"
                required
                maxLength={200}
                value={value.subject}
                onChange={(e) => change({ ...value, subject: e.currentTarget.value })}
              />
            </label>
          )}
          <label className="block">
            Message
            <textarea
              className="field min-h-40"
              required
              maxLength={value.channel === 'sms' ? 1600 : 4000}
              value={value.body}
              onChange={(e) => change({ ...value, body: e.currentTarget.value })}
            />
          </label>
          <Button type="submit" disabled={!form.enabled}>
            Save draft
          </Button>
        </fieldset>
      </form>
      <PermissionPanel
        contactId={contact.id}
        channel={value.channel}
        recipient={value.recipient}
        purpose={value.purpose}
        onEligibility={setEligibility}
      />
      {saved && (
        <section className="space-y-3 rounded-xl border border-border p-5">
          <h3 ref={review} tabIndex={-1} className="text-xl font-semibold">
            Review saved message
          </h3>
          <p>
            Draft saved. Sending requires an owner or administrator. The channel is fixed for this
            draft.
          </p>
          <Link className="underline" to={`${base}/communications/${saved.conversation_id}`}>
            Open saved draft and history
          </Link>
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() =>
              change({
                ...value,
                id: crypto.randomUUID(),
                version: undefined,
                subject: '',
                body: '',
              })
            }
          >
            Start another draft
          </Button>
          {can(organization.role, 'crm_manage') && (
            <>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={locked}
                  onChange={(e) => setConfirmed(e.currentTarget.checked)}
                />
                <span>
                  I reviewed this exact saved message, its recipient and purpose, and authorize mock
                  sending.
                </span>
              </label>
              <Button
                disabled={locked || !confirmed || eligibility !== null}
                onClick={() => void send()}
              >
                Confirm and queue mock message
              </Button>
            </>
          )}
        </section>
      )}
      {draft.error && <p role="alert">{draft.error}</p>}
      {locked && <p role="status">Saving…</p>}
    </section>
  );
}
function PermissionPanel({
  contactId,
  channel,
  recipient,
  purpose,
  onEligibility,
}: {
  contactId: string;
  channel: 'email' | 'sms';
  recipient: string;
  purpose: 'transactional' | 'marketing';
  onEligibility: (code: string | null) => void;
}) {
  const { organization } = useOrganization(),
    action = useOperation(),
    [source, setSource] = useState(''),
    [validationError, setValidationError] = useState(''),
    [jurisdiction, setJurisdiction] = useState(''),
    [policyVersion, setPolicyVersion] = useState(''),
    [evidence, setEvidence] = useState('');
  const load = useCallback(
    (s: AbortSignal) =>
      apiClient.communicationEligibility(
        organization.id,
        contactId,
        { channel, recipient: recipient.trim(), purpose },
        s,
      ),
    [organization.id, contactId, channel, recipient, purpose],
  );
  const { state, refresh } = useQuery(
    `eligibility:${contactId}:${channel}:${recipient}:${purpose}`,
    load,
  );
  const code = state.status === 'ready' ? state.data.code : 'CONSENT_REQUIRED';
  useEffect(() => onEligibility(code), [code, onEligibility]);
  const record = (status: 'granted' | 'revoked', collectedAt: string) => {
    setValidationError('');
    const collected = new Date(collectedAt);
    if (!Number.isFinite(collected.getTime())) {
      setValidationError('Enter the consent collection date and time.');
      return;
    }
    const input = permissionInputSchema.safeParse({
      contactId,
      channel,
      purpose,
      recipient: recipient.trim(),
      status,
      source,
      collectedAt: collected.toISOString(),
      jurisdiction,
      policyVersion,
      evidence,
    });
    if (!input.success) {
      setValidationError('Complete all permission evidence fields with valid values.');
      return;
    }
    void action.run(
      () => apiClient.recordCommunicationPermission(organization.id, input.data),
      refresh,
    );
  };
  return (
    <section className="space-y-3 rounded-xl border border-border p-5">
      <h3 className="text-xl font-semibold">Communication permission</h3>
      {state.status === 'loading' ? (
        <p role="status">Checking recipient eligibility…</p>
      ) : state.status === 'error' ? (
        <Failure error={state.error} retry={refresh} />
      ) : (
        <>
          <p role="status">{communicationReason(state.data.code)}</p>
          {state.data.permissions
            .filter(
              (p) =>
                p.channel === channel && p.purpose === purpose && p.recipient === recipient.trim(),
            )
            .map((p) => (
              <p key={`${p.channel}:${p.purpose}:${p.recipient}`} className="text-sm">
                {p.status} · {p.jurisdiction} · {p.source} · collected{' '}
                {new Date(p.collected_at).toLocaleString()}
              </p>
            ))}
        </>
      )}
      {can(organization.role, 'crm_manage') && (
        <>
          <details>
            <summary>Record permission evidence</summary>
            <p className="my-3 text-sm">
              Only record evidence you actually have. Creating a contact does not grant permission.
              For this mock walkthrough, use explicitly labeled synthetic evidence.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const submitter = (e.nativeEvent as SubmitEvent).submitter;
                record(
                  submitter instanceof HTMLButtonElement && submitter.value === 'revoked'
                    ? 'revoked'
                    : 'granted',
                  String(new FormData(e.currentTarget).get('collectedAt') ?? ''),
                );
              }}
              className="space-y-3"
            >
              <fieldset disabled={action.busy} className="space-y-3">
                <legend className="sr-only">Permission evidence</legend>
                <label className="block">
                  Consent source
                  <input
                    className="field"
                    required
                    maxLength={160}
                    value={source}
                    onChange={(e) => setSource(e.currentTarget.value)}
                  />
                </label>
                <label className="block">
                  Collected at (your local time)
                  <input className="field" type="datetime-local" required name="collectedAt" />
                </label>
                <label className="block">
                  Recipient country code
                  <input
                    className="field"
                    required
                    pattern="[A-Z]{2}"
                    maxLength={2}
                    placeholder="US"
                    value={jurisdiction}
                    onChange={(e) => setJurisdiction(e.currentTarget.value.toUpperCase())}
                  />
                </label>
                <label className="block">
                  Disclosure or policy version
                  <input
                    className="field"
                    required
                    maxLength={80}
                    value={policyVersion}
                    onChange={(e) => setPolicyVersion(e.currentTarget.value)}
                  />
                </label>
                <label className="block">
                  Evidence reference
                  <input
                    className="field"
                    required
                    maxLength={200}
                    value={evidence}
                    onChange={(e) => setEvidence(e.currentTarget.value)}
                  />
                </label>
                <Button type="submit" name="permissionStatus" value="granted">
                  Record explicit permission
                </Button>
                <Button
                  className="ml-3"
                  variant="outline"
                  type="submit"
                  name="permissionStatus"
                  value="revoked"
                >
                  Record opt-out
                </Button>
              </fieldset>
            </form>
          </details>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              disabled={action.busy || !recipient}
              onClick={() =>
                void action.run(
                  () =>
                    apiClient.setCommunicationSuppression(organization.id, {
                      channel,
                      recipient,
                      suppressed: true,
                    }),
                  refresh,
                )
              }
            >
              Block this destination
            </Button>
            <Button
              variant="outline"
              disabled={action.busy || !recipient}
              onClick={() =>
                void action.run(
                  () =>
                    apiClient.setCommunicationSuppression(organization.id, {
                      channel,
                      recipient,
                      suppressed: false,
                    }),
                  refresh,
                )
              }
            >
              Remove administrative block
            </Button>
          </div>
        </>
      )}
      {validationError && <p role="alert">{validationError}</p>}
      {action.error && <p role="alert">{action.error}</p>}
    </section>
  );
}
export function CommunicationSettingsPage() {
  const { organization } = useOrganization();
  return <Settings key={organization.id} />;
}
function Settings() {
  const { organization } = useOrganization(),
    load = useCallback(
      (s: AbortSignal) => apiClient.communicationSettings(organization.id, s),
      [organization.id],
    ),
    { state, refresh } = useQuery('communication-settings', load);
  return (
    <section className="max-w-3xl space-y-5">
      <h2 className="text-3xl font-semibold">Communication settings</h2>
      <p>
        Email and SMS use deterministic mock providers. Live sending is unavailable. No credentials
        are required.
      </p>
      {state.status === 'loading' ? (
        <p role="status">Loading settings…</p>
      ) : state.status === 'error' ? (
        <Failure error={state.error} retry={refresh} />
      ) : (
        <SettingsForm key={JSON.stringify(state.data)} settings={state.data} refresh={refresh} />
      )}
    </section>
  );
}
function SettingsForm({
  settings,
  refresh,
}: {
  settings: Awaited<ReturnType<typeof apiClient.communicationSettings>>;
  refresh: () => void;
}) {
  const { organization } = useOrganization(),
    [value, setValue] = useState(communicationSettingsInput.strip().parse(settings)),
    action = useOperation();
  return (
    <>
      <p role="status">
        Mock sending: {settings.paused ? 'paused' : 'enabled'} · {settings.queuedCount} pending ·{' '}
        {settings.attentionCount} need attention
      </p>
      <p>
        Email sender: {settings.senderEmail}. SMS sender: {settings.senderSms}.
      </p>
      <p>
        Limits use UTC days and fixed one-minute windows. The mock provider permits at most 60
        requests per minute across workspaces. Scheduling and quiet hours are unavailable.
      </p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(
            () => apiClient.saveCommunicationSettings(organization.id, value),
            refresh,
          );
        }}
      >
        <fieldset
          disabled={!can(organization.role, 'crm_manage') || action.busy}
          className="space-y-4"
        >
          <legend className="sr-only">Sending controls</legend>
          <label className="flex gap-3">
            <input
              type="checkbox"
              checked={value.paused}
              onChange={(e) => setValue({ ...value, paused: e.currentTarget.checked })}
            />
            Pause new submissions
          </label>
          {(
            [
              ['dailyLimit', 'Messages per workspace per UTC day', 10000],
              ['recipientDailyLimit', 'Messages per destination per UTC day', 100],
              ['channelDailyLimit', 'Messages per channel per UTC day', 10000],
              ['concurrentLimit', 'Concurrent submissions', 10],
              ['requestsPerMinute', 'Provider requests per workspace per minute', 60],
              ['maxAttempts', 'Processing attempts before review', 5],
            ] as const
          ).map(([key, label, max]) => (
            <label key={key} className="block">
              {label}
              <input
                className="field"
                type="number"
                min={1}
                max={max}
                required
                value={value[key]}
                onChange={(e) => setValue({ ...value, [key]: Number(e.currentTarget.value) })}
              />
            </label>
          ))}
          <Button type="submit">Save sending controls</Button>
        </fieldset>
      </form>
      {!can(organization.role, 'crm_manage') && (
        <p>An owner or administrator can change sending controls.</p>
      )}
      {action.error && <p role="alert">{action.error}</p>}
    </>
  );
}
