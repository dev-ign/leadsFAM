import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '@leadops/ui';
import { leadIntakeSchema, type Contact, type LeadIntake } from '@leadops/shared';
import { apiClient } from '../../lib/api-client';
import { useOrganization } from '../organizations/context';
import { useDraft } from './use-draft';
import { blankContact, cleanContact, editableContact } from './data';
import { ContactFields } from './ui';
import { crmMessage, uncertain } from './errors';
import { useQuery } from './use-query';

function Matches({ contacts, onChoose }: { contacts: Contact[]; onChoose: (id: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">Matching contacts · review before continuing</p>
      {contacts.map((v) => (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
          key={v.id}
        >
          <div>
            <p className="font-medium">{v.display_name}</p>
            <p className="text-muted-foreground">
              {v.emails[0]?.value ?? v.phones[0]?.value ?? 'No email or phone'}
              {v.archived_at ? ' · archived' : ''}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={Boolean(v.archived_at)}
            onClick={() => onChoose(v.id)}
          >
            Use this contact
          </Button>
        </div>
      ))}
    </div>
  );
}
export function NewContactPage() {
  return <ContactEditor />;
}
export function ContactEditor({ contact }: { contact?: Contact }) {
  const { organization } = useOrganization(),
    navigate = useNavigate(),
    form = useDraft(`contact:${contact?.id ?? 'new'}`, {
      version: contact?.version ?? 0,
      contact: contact ? editableContact(contact) : blankContact,
    });
  const { draft, update, clear, enabled } = form,
    [matches, setMatches] = useState<Contact[]>([]),
    [reviewing, setReviewing] = useState(false);
  const base = `/organizations/${organization.id}`;
  useEffect(() => {
    if (draft.phase === 'done' && draft.resultId && enabled) {
      clear();
      navigate(`${base}/contacts/${draft.resultId}`, { replace: true });
    }
  }, [draft.phase, draft.resultId, enabled, clear, navigate, base]);
  async function review() {
    setReviewing(true);
    try {
      setMatches(await apiClient.candidates(organization.id, cleanContact(draft.value.contact)));
    } catch (error) {
      update((v) => ({ ...v, error: crmMessage(error) }));
    } finally {
      setReviewing(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (draft.phase === 'saving') return;
    let submitted = draft.submitted;
    if (draft.phase !== 'uncertain' || !submitted) {
      try {
        submitted = { ...draft.value, contact: cleanContact(draft.value.contact) };
      } catch {
        update((v) => ({ ...v, error: 'Check the required contact fields and their formatting.' }));
        return;
      }
    }
    const input = submitted;
    update((v) => ({ ...v, phase: 'saving', submitted: input, dirty: true, error: '' }));
    try {
      const result = contact
        ? await apiClient.updateContact(organization.id, contact.id, input.version, input.contact)
        : await apiClient.createContact(organization.id, input.contact, draft.requestKey);
      update((v) => ({ ...v, phase: 'done', resultId: result.id, dirty: false, error: '' }));
    } catch (error) {
      update((v) => ({
        ...v,
        phase: uncertain(error) ? 'uncertain' : 'editing',
        error: crmMessage(error),
      }));
    }
  }
  const disabled = !enabled || draft.phase !== 'editing';
  return (
    <div className="max-w-3xl space-y-6">
      <Link className="text-sm underline" to={`${base}/contacts`}>
        Back to contacts
      </Link>
      <h2 className="text-3xl font-semibold">{contact ? 'Edit contact' : 'New contact'}</h2>
      {contact && (
        <p className="text-sm text-muted-foreground">
          Changes update the current contact details shown on every related lead.
        </p>
      )}
      <form onSubmit={(e) => void save(e)} autoComplete="off" className="space-y-6">
        <ContactFields
          value={draft.value.contact}
          disabled={disabled}
          onChange={(value) => form.change({ ...draft.value, contact: value })}
        />
        {!contact && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || reviewing}
              onClick={() => void review()}
            >
              {reviewing ? 'Checking…' : 'Check for matches'}
            </Button>
            {matches.length > 0 && (
              <Matches contacts={matches} onChoose={(id) => navigate(`${base}/contacts/${id}`)} />
            )}
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={draft.value.contact.duplicateResolution === 'create_distinct'}
                onChange={(e) =>
                  form.change({
                    ...draft.value,
                    contact: {
                      ...draft.value.contact,
                      duplicateResolution: e.currentTarget.checked ? 'create_distinct' : undefined,
                    },
                  })
                }
              />
              Create a separate contact even when a match exists.
            </label>
          </>
        )}
        {draft.error && (
          <p role="alert" className="text-sm text-destructive">
            {draft.error}
          </p>
        )}
        {draft.phase === 'uncertain' && (
          <p className="text-sm">
            The save may have finished. Retry this unchanged request to check its result before
            editing.
          </p>
        )}
        <Button
          type="submit"
          disabled={!enabled || draft.phase === 'saving' || draft.phase === 'done'}
        >
          {draft.phase === 'saving'
            ? 'Saving…'
            : draft.phase === 'uncertain'
              ? 'Retry save'
              : 'Save contact'}
        </Button>
      </form>
    </div>
  );
}

export function NewLeadPage() {
  const { organization } = useOrganization(),
    navigate = useNavigate(),
    base = `/organizations/${organization.id}`;
  const form = useDraft<{ intake: LeadIntake; contactSearch: string }>('lead:new', {
    intake: {
      contact: { mode: 'create', data: blankContact },
      lead: { title: '', description: '', priority: 'normal' },
      attribution: {},
    },
    contactSearch: '',
  });
  const { draft, update, clear, enabled } = form,
    [matches, setMatches] = useState<Contact[]>([]),
    [checking, setChecking] = useState(false);
  const input = draft.value.intake,
    disabled = !enabled || draft.phase !== 'editing';
  const sourcesLoad = useCallback(
      (s: AbortSignal) => apiClient.sources(organization.id, s),
      [organization.id],
    ),
    sources = useQuery(`${organization.id}/intake-sources`, sourcesLoad);
  const contactId = input.contact.mode === 'existing' ? input.contact.id : '';
  const selectedLoad = useCallback(
      (s: AbortSignal) =>
        contactId ? apiClient.contact(organization.id, contactId, s) : Promise.resolve(null),
      [contactId, organization.id],
    ),
    selected = useQuery<Contact | null>(
      `${organization.id}/${contactId}/selected-contact`,
      selectedLoad,
    );
  const change = (intake: LeadIntake) => form.change({ ...draft.value, intake });
  useEffect(() => {
    if (draft.phase === 'done' && draft.resultId && enabled) {
      clear();
      navigate(`${base}/leads/${draft.resultId}`, { replace: true });
    }
  }, [draft.phase, draft.resultId, enabled, clear, navigate, base]);
  async function review() {
    setChecking(true);
    try {
      const result =
        input.contact.mode === 'create'
          ? await apiClient.candidates(organization.id, cleanContact(input.contact.data))
          : (
              await apiClient.contacts(organization.id, {
                q: draft.value.contactSearch,
                pageSize: 25,
              })
            ).items;
      setMatches(result);
    } catch (error) {
      update((v) => ({ ...v, error: crmMessage(error) }));
    } finally {
      setChecking(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (draft.phase === 'saving') return;
    let submitted = draft.submitted;
    if (draft.phase !== 'uncertain' || !submitted) {
      try {
        const contact =
          input.contact.mode === 'create'
            ? { mode: 'create' as const, data: cleanContact(input.contact.data) }
            : input.contact;
        submitted = { ...draft.value, intake: leadIntakeSchema.parse({ ...input, contact }) };
      } catch {
        update((v) => ({ ...v, error: 'Check the required lead and contact fields.' }));
        return;
      }
    }
    const request = submitted;
    update((v) => ({ ...v, phase: 'saving', submitted: request, dirty: true, error: '' }));
    try {
      const result = await apiClient.createLead(organization.id, request.intake, draft.requestKey);
      update((v) => ({ ...v, phase: 'done', resultId: result.id, dirty: false, error: '' }));
    } catch (error) {
      update((v) => ({
        ...v,
        phase: uncertain(error) ? 'uncertain' : 'editing',
        error: crmMessage(error),
      }));
    }
  }
  return (
    <div className="max-w-3xl space-y-6">
      <Link className="text-sm underline" to={`${base}/leads`}>
        Back to leads
      </Link>
      <div>
        <h2 className="text-3xl font-semibold">New lead</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Start with a contact, then define the opportunity.
        </p>
      </div>
      <form onSubmit={(e) => void save(e)} autoComplete="off" className="space-y-7">
        <fieldset disabled={disabled} className="space-y-4">
          <legend className="mb-3 text-lg font-medium">Lead details</legend>
          <label className="block text-sm">
            Lead title
            <input
              className="field"
              value={input.lead.title}
              required
              maxLength={160}
              onChange={(e) =>
                change({ ...input, lead: { ...input.lead, title: e.currentTarget.value } })
              }
            />
          </label>
          <label className="block text-sm">
            Description
            <textarea
              className="field min-h-28"
              maxLength={4000}
              value={input.lead.description}
              onChange={(e) =>
                change({ ...input, lead: { ...input.lead, description: e.currentTarget.value } })
              }
            />
          </label>
          <label className="block text-sm">
            Priority
            <select
              className="field"
              value={input.lead.priority}
              onChange={(e) =>
                change({
                  ...input,
                  lead: {
                    ...input.lead,
                    priority: e.currentTarget.value as 'low' | 'normal' | 'high',
                  },
                })
              }
            >
              {['low', 'normal', 'high'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </fieldset>
        <fieldset disabled={disabled} className="flex flex-wrap gap-5">
          <legend className="mb-3 font-medium">Choose a contact</legend>
          {(['create', 'existing'] as const).map((mode) => (
            <label className="flex items-center gap-2 text-sm" key={mode}>
              <input
                type="radio"
                name="contact-mode"
                checked={input.contact.mode === mode}
                onChange={() => {
                  setMatches([]);
                  change({
                    ...input,
                    contact: mode === 'create' ? { mode, data: blankContact } : { mode, id: '' },
                  });
                }}
              />
              {mode === 'create' ? 'Create a contact' : 'Use an existing contact'}
            </label>
          ))}
        </fieldset>
        {input.contact.mode === 'create' ? (
          <>
            <ContactFields
              value={input.contact.data}
              disabled={disabled}
              onChange={(data) => change({ ...input, contact: { mode: 'create', data } })}
            />
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                disabled={disabled}
                checked={input.contact.data.duplicateResolution === 'create_distinct'}
                onChange={(e) => {
                  if (input.contact.mode === 'create')
                    change({
                      ...input,
                      contact: {
                        mode: 'create',
                        data: {
                          ...input.contact.data,
                          duplicateResolution: e.currentTarget.checked
                            ? 'create_distinct'
                            : undefined,
                        },
                      },
                    });
                }}
              />
              Create a separate contact even when a match exists.
            </label>
          </>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm">
              Find a contact
              <input
                className="field"
                value={draft.value.contactSearch}
                maxLength={100}
                disabled={disabled}
                onChange={(e) =>
                  form.change({ ...draft.value, contactSearch: e.currentTarget.value })
                }
              />
            </label>
            {contactId && selected.state.status === 'ready' && selected.state.data && (
              <p className="rounded-lg bg-accent p-3 text-sm">
                Selected: {selected.state.data.display_name}
              </p>
            )}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={disabled || checking}
          onClick={() => void review()}
        >
          {checking
            ? 'Searching…'
            : input.contact.mode === 'create'
              ? 'Check for matches'
              : 'Search contacts'}
        </Button>
        {matches.length > 0 && (
          <Matches
            contacts={matches}
            onChoose={(id) => {
              if (!disabled) {
                change({ ...input, contact: { mode: 'existing', id } });
                setMatches([]);
              }
            }}
          />
        )}
        <fieldset disabled={disabled} className="space-y-4">
          <legend className="mb-3 text-lg font-medium">Acquisition details</legend>
          <label className="block text-sm">
            Source
            <select
              className="field"
              value={input.attribution.sourceId ?? ''}
              onChange={(e) =>
                change({
                  ...input,
                  attribution: {
                    ...input.attribution,
                    sourceId: e.currentTarget.value || undefined,
                  },
                })
              }
            >
              <option value="">No source selected</option>
              {sources.state.status === 'ready' &&
                sources.state.data
                  .filter((v) => !v.archived_at)
                  .map((v) => (
                    <option value={v.id} key={v.id}>
                      {v.name}
                    </option>
                  ))}
            </select>
          </label>
          <label className="block text-sm">
            Campaign
            <input
              className="field"
              maxLength={160}
              value={input.attribution.campaign ?? ''}
              onChange={(e) =>
                change({
                  ...input,
                  attribution: { ...input.attribution, campaign: e.currentTarget.value },
                })
              }
            />
          </label>
          <details>
            <summary className="cursor-pointer text-sm underline">More acquisition details</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {(
                [
                  'provider',
                  'externalReference',
                  'utmSource',
                  'utmMedium',
                  'landingUrl',
                  'acquiredAt',
                ] as const
              ).map((key) => (
                <label className="block text-sm" key={key}>
                  {
                    {
                      provider: 'Provider label',
                      externalReference: 'Reference',
                      utmSource: 'UTM source',
                      utmMedium: 'UTM medium',
                      landingUrl: 'Landing URL',
                      acquiredAt: 'Claimed acquisition time (ISO 8601)',
                    }[key]
                  }
                  <input
                    className="field"
                    maxLength={key === 'landingUrl' ? 2048 : key === 'provider' ? 80 : 160}
                    value={input.attribution[key] ?? ''}
                    onChange={(e) =>
                      change({
                        ...input,
                        attribution: {
                          ...input.attribution,
                          [key]: e.currentTarget.value || undefined,
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </details>
        </fieldset>
        {draft.error && (
          <p role="alert" className="text-sm text-destructive">
            {draft.error}
          </p>
        )}
        {draft.phase === 'uncertain' && (
          <p className="text-sm">
            This save may already be complete. Retry the same request to retrieve its result.
          </p>
        )}
        <Button
          type="submit"
          disabled={!enabled || draft.phase === 'saving' || draft.phase === 'done'}
        >
          {draft.phase === 'saving'
            ? 'Saving…'
            : draft.phase === 'uncertain'
              ? 'Retry save'
              : 'Create lead'}
        </Button>
      </form>
    </div>
  );
}
