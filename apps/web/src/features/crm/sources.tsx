import { useCallback, type FormEvent } from 'react';
import { Button } from '@leadops/ui';
import { can } from '@leadops/shared';
import { apiClient } from '../../lib/api-client';
import { useOrganization } from '../organizations/context';
import { useQuery } from './use-query';
import { useDraft } from './use-draft';
import { useDrafts } from './draft-context';
import { CrmFailure } from './ui';
import { crmMessage } from './errors';
type Source = Awaited<ReturnType<typeof apiClient.sources>>[number];
export function SourcesPage() {
  const { organization } = useOrganization(),
    { store, confirmDiscard } = useDrafts(),
    load = useCallback(
      (s: AbortSignal) => apiClient.sources(organization.id, s),
      [organization.id],
    ),
    { state, refresh } = useQuery(`${organization.id}/source-catalog`, load);
  return (
    <section className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-3xl font-semibold">Lead sources</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Name the ways interest reaches your team. Archived sources remain attached to their
            original leads.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() =>
            confirmDiscard(() => {
              store.discardActive();
              refresh();
            })
          }
        >
          Refresh sources
        </Button>
      </div>
      {can(organization.role, 'crm_manage') && <SourceForm refresh={refresh} />}{' '}
      {state.status === 'loading' ? (
        <p role="status">Loading sources…</p>
      ) : state.status === 'error' ? (
        <CrmFailure error={state.error} retry={refresh} />
      ) : state.data.length ? (
        <div className="space-y-3">
          {state.data.map((source) =>
            !can(organization.role, 'crm_manage') ? (
              <p key={source.id} className="rounded-lg border border-border p-4">
                {source.name}
                {source.archived_at ? ' · archived' : ''}
              </p>
            ) : (
              <SourceForm
                key={`${source.id}/${source.version}`}
                source={source}
                refresh={refresh}
              />
            ),
          )}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border p-8 text-sm text-muted-foreground">
          No sources yet. Leads can still be created without a source.
        </p>
      )}
    </section>
  );
}
function SourceForm({ source, refresh }: { source?: Source; refresh: () => void }) {
  const { organization } = useOrganization(),
    form = useDraft(`source:${source?.id ?? 'new'}`, {
      name: source?.name ?? '',
      archived: Boolean(source?.archived_at),
      version: source?.version ?? 0,
    }),
    { draft, update } = form;
  async function save(e: FormEvent) {
    e.preventDefault();
    update((v) => ({ ...v, phase: 'saving', error: '' }));
    try {
      const input = { name: draft.value.name.trim(), archived: draft.value.archived };
      if (source)
        await apiClient.updateSource(organization.id, source.id, draft.value.version, input);
      else await apiClient.createSource(organization.id, input);
      form.clear();
      refresh();
    } catch (error) {
      update((v) => ({ ...v, phase: 'editing', error: crmMessage(error) }));
    }
  }
  return (
    <form
      className="space-y-3 rounded-xl border border-border bg-card p-4"
      onSubmit={(e) => void save(e)}
    >
      <fieldset
        disabled={!form.enabled || draft.phase === 'saving'}
        className="flex flex-wrap items-end gap-4"
      >
        <label className="min-w-48 flex-1 text-sm">
          {source ? 'Source name' : 'New source name'}
          <input
            className="field"
            value={draft.value.name}
            required
            maxLength={80}
            onChange={(e) => form.change({ ...draft.value, name: e.currentTarget.value })}
          />
        </label>
        {source && (
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.value.archived}
              onChange={(e) => form.change({ ...draft.value, archived: e.currentTarget.checked })}
            />
            Archived
          </label>
        )}
        <Button type="submit">
          {draft.phase === 'saving' ? 'Saving…' : source ? 'Save source' : 'Add source'}
        </Button>
      </fieldset>
      {draft.error && (
        <p role="alert" className="text-sm text-destructive">
          {draft.error}
        </p>
      )}
    </form>
  );
}
