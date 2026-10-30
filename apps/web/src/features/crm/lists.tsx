import { useCallback, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button } from '@leadops/ui';
import { can, crmQuerySchema, type CrmQuery, type Lead, type Contact } from '@leadops/shared';
import { apiClient } from '../../lib/api-client';
import { useOrganization } from '../organizations/context';
import { useIdentity } from '../identity/context';
import { useQuery } from './use-query';
import { CrmFailure } from './ui';
export function LeadsPage() {
  return <CrmList kind="leads" />;
}
export function ContactsPage() {
  return <CrmList kind="contacts" />;
}
function CrmList({ kind }: { kind: 'leads' | 'contacts' }) {
  const { organization } = useOrganization(),
    { state: identity } = useIdentity();
  const [query, setQuery] = useState<CrmQuery>(() => crmQuerySchema.parse({})),
    [search, setSearch] = useState(''),
    [history, setHistory] = useState<string[]>([]);
  const scope = identity.status === 'ready' ? identity.session.user?.id : '';
  const load = useCallback(
    (signal: AbortSignal) =>
      kind === 'leads'
        ? apiClient.leads(organization.id, query, signal)
        : apiClient.contacts(organization.id, query, signal),
    [kind, organization.id, query],
  );
  const { state, refresh } = useQuery<{ items: (Lead | Contact)[]; cursor: string | null }>(
    JSON.stringify([scope, organization.id, kind, query]),
    load,
  );
  const sourcesLoad = useCallback(
    (signal: AbortSignal) =>
      kind === 'leads' ? apiClient.sources(organization.id, signal) : Promise.resolve([]),
    [kind, organization.id],
  );
  const sources = useQuery(`${scope}/${organization.id}/${kind}/sources`, sourcesLoad);
  const change = (patch: Partial<CrmQuery>) => {
    setHistory([]);
    setQuery((old) => ({ ...old, ...patch, cursor: undefined }));
  };
  const base = `/organizations/${organization.id}`;
  function searchSubmit(e: FormEvent) {
    e.preventDefault();
    change({ q: search });
  }
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
            Your workspace
          </p>
          <h2 className="text-3xl font-semibold">{kind === 'leads' ? 'Leads' : 'Contacts'}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {kind === 'leads'
              ? 'Keep the next step clear, from first interest to a closed outcome.'
              : 'One shared contact record, with current details across every lead.'}
          </p>
        </div>
        <div className="flex gap-3">
          {kind === 'leads' && can(organization.role, 'crm_import') && (
            <Link
              className="rounded-lg border border-border px-4 py-2 text-sm"
              to={`${base}/imports`}
            >
              Import CSV
            </Link>
          )}
          <Link
            className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
            to={`${base}/${kind}/new`}
          >
            {kind === 'leads' ? 'New lead' : 'New contact'}
          </Link>
        </div>
      </div>
      <form onSubmit={searchSubmit} className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          Matching
          <select
            className="field"
            value={query.searchMode}
            onChange={(e) =>
              change({ searchMode: e.currentTarget.value as CrmQuery['searchMode'] })
            }
          >
            <option value="prefix">Starts with</option>
            <option value="contains">Contains anywhere</option>
          </select>
        </label>
        <label className="min-w-48 flex-1 text-sm">
          Search {kind}
          <input
            className="field"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Name, title, email or +country phone"
          />
        </label>
        <Button type="submit">Search</Button>
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            setSearch('');
            setHistory([]);
            setQuery(crmQuerySchema.parse({}));
          }}
        >
          Clear filters
        </Button>
      </form>
      <div className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 xl:grid-cols-4">
        {kind === 'leads' && (
          <>
            <label className="text-sm">
              Status
              <select
                className="field"
                value={query.status}
                onChange={(e) => change({ status: e.currentTarget.value as CrmQuery['status'] })}
              >
                {['all', 'new', 'in_progress', 'qualified', 'closed'].map((v) => (
                  <option key={v} value={v}>
                    {v.replaceAll('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Priority
              <select
                className="field"
                value={query.priority}
                onChange={(e) =>
                  change({ priority: e.currentTarget.value as CrmQuery['priority'] })
                }
              >
                {['all', 'low', 'normal', 'high'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Assignment
              <select
                className="field"
                value={query.assignee}
                onChange={(e) => change({ assignee: e.currentTarget.value })}
              >
                <option value="all">Everyone</option>
                <option value="mine">Assigned to me</option>
                <option value="unassigned">Unassigned</option>
              </select>
            </label>
            <label className="text-sm">
              Source
              <select
                className="field"
                value={query.sourceId ?? ''}
                onChange={(e) => change({ sourceId: e.currentTarget.value || null })}
              >
                <option value="">All sources</option>
                {sources.state.status === 'ready' &&
                  sources.state.data.map((v) => (
                    <option value={v.id} key={v.id}>
                      {v.name}
                      {v.archived_at ? ' (archived)' : ''}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
        <label className="text-sm">
          Records
          <select
            className="field"
            value={query.archived}
            onChange={(e) => change({ archived: e.currentTarget.value as CrmQuery['archived'] })}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All records</option>
          </select>
        </label>
        <label className="text-sm">
          Created from (UTC)
          <input
            className="field"
            type="date"
            value={query.from ?? ''}
            onChange={(e) => change({ from: e.currentTarget.value || null })}
          />
        </label>
        <label className="text-sm">
          Created through (UTC)
          <input
            className="field"
            type="date"
            value={query.to ?? ''}
            onChange={(e) => change({ to: e.currentTarget.value || null })}
          />
        </label>
        {kind === 'leads' && (
          <label className="text-sm">
            Order
            <select
              className="field"
              value={query.sort}
              onChange={(e) => change({ sort: e.currentTarget.value as CrmQuery['sort'] })}
            >
              <option value="created">Newest first</option>
              <option value="activity">Recent lead activity</option>
            </select>
          </label>
        )}
      </div>
      {state.status === 'loading' ? (
        <p role="status">Loading {kind}…</p>
      ) : state.status === 'error' ? (
        <CrmFailure
          error={state.error}
          retry={() => {
            change({});
            refresh();
          }}
        />
      ) : state.data.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <h3 className="text-lg font-medium">No {kind} match this view.</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Create a record or adjust your filters to get started.
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                {kind} in {organization.name}
              </caption>
              <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="p-4">{kind === 'leads' ? 'Lead' : 'Contact'}</th>
                  <th className="p-4">{kind === 'leads' ? 'Contact' : 'Email / phone'}</th>
                  <th className="p-4">{kind === 'leads' ? 'Status' : 'Type'}</th>
                  <th className="p-4">Created</th>
                </tr>
              </thead>
              <tbody>
                {state.data.items.map((item) => {
                  const lead = 'contact' in item ? item : null,
                    contact = lead ? lead.contact : (item as Contact);
                  return (
                    <tr
                      key={item.id}
                      className="border-b border-border last:border-0 hover:bg-muted/30"
                    >
                      <td className="max-w-xs break-words p-4">
                        <Link
                          className="font-medium underline-offset-4 hover:underline"
                          to={`${base}/${kind}/${item.id}`}
                        >
                          {lead ? lead.title : contact.display_name}
                        </Link>
                        {item.archived_at && (
                          <span className="ml-2 text-xs text-muted-foreground">Archived</span>
                        )}
                      </td>
                      <td className="max-w-xs break-all p-4 text-muted-foreground">
                        {lead ? (
                          <Link className="underline" to={`${base}/contacts/${contact.id}`}>
                            {contact.display_name}
                          </Link>
                        ) : (
                          (contact.emails[0]?.value ??
                          contact.phones[0]?.value ??
                          'No email or phone')
                        )}
                      </td>
                      <td className="whitespace-nowrap p-4 capitalize">
                        {lead ? lead.status.replaceAll('_', ' ') : contact.kind}
                      </td>
                      <td className="whitespace-nowrap p-4 text-muted-foreground">
                        {new Date(item.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              disabled={!history.length}
              onClick={() => {
                const previous = history.at(-1) ?? '';
                setHistory((v) => v.slice(0, -1));
                setQuery((v) => ({ ...v, cursor: previous }));
              }}
            >
              Previous page
            </Button>
            <p className="text-xs text-muted-foreground">
              Page {history.length + 1} · {state.data.items.length} shown
            </p>
            <Button
              variant="outline"
              disabled={!state.data.cursor}
              onClick={() => {
                setHistory((v) => [...v, query.cursor ?? '']);
                setQuery((v) => ({ ...v, cursor: state.data.cursor ?? undefined }));
              }}
            >
              Next page
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
