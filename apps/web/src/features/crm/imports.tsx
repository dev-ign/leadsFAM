import { useCallback, useEffect, type ChangeEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '@leadops/ui';
import {
  can,
  csvFields,
  type CsvPreview,
  type ImportResult,
  type LeadIntake,
} from '@leadops/shared';
import { apiClient, ApiClientError } from '../../lib/api-client';
import { useOrganization } from '../organizations/context';
import { useIdentity } from '../identity/context';
import { useDraft } from './use-draft';
import { useDrafts } from './draft-context';
import type { Draft } from './draft-store';
import { useQuery } from './use-query';
import { CrmFailure } from './ui';
import { crmMessage, uncertain } from './errors';
type Field = (typeof csvFields)[number];
type Submission = Parameters<typeof apiClient.executeImport>[1];
interface ImportDraft {
  jobId: string;
  csv: string;
  columns: string[];
  mapping: Partial<Record<string, Field>>;
  preview: CsvPreview | null;
  choices: Record<string, string>;
  execution: Submission | null;
  result: ImportResult | null;
}
const labels: Record<Field, string> = {
  kind: 'Contact type',
  displayName: 'Display name',
  firstName: 'First name',
  lastName: 'Last name',
  companyName: 'Company name',
  email: 'Primary email',
  email2: 'Second email',
  email3: 'Third email',
  phone: 'Phone',
  phoneRegion: 'Phone country code',
  title: 'Lead title',
  description: 'Description',
  priority: 'Priority',
  sourceId: 'Source ID',
  campaign: 'Campaign',
  externalReference: 'Reference',
};
export function ImportsPage() {
  const { organization } = useOrganization(),
    { job } = useParams();
  return !can(organization.role, 'crm_import') ? (
    <p>Imports are available to workspace owners and admins.</p>
  ) : (
    <ImportWizard key={job ?? 'new'} job={job ?? ''} />
  );
}
function ImportWizard({ job }: { job: string }) {
  const { organization } = useOrganization(),
    { state: identity } = useIdentity(),
    { store, confirmDiscard } = useDrafts(),
    navigate = useNavigate(),
    base = `/organizations/${organization.id}`;
  const form = useDraft<ImportDraft>(`import:${job || 'new'}`, {
      jobId: job,
      csv: '',
      columns: [],
      mapping: {},
      preview: null,
      choices: {},
      execution: null,
      result: null,
    }),
    { draft, update, enabled } = form;
  const scope = identity.status === 'ready' ? identity.session.user?.id : '';
  const statusLoad = useCallback(
    (s: AbortSignal) =>
      job
        ? apiClient.importStatus(organization.id, job, s).catch((error: unknown) => {
            if (error instanceof ApiClientError && error.status === 404) return null;
            throw error;
          })
        : Promise.resolve(null),
    [organization.id, job],
  );
  const status = useQuery(`${scope}/${organization.id}/${job}/import-status`, statusLoad),
    jobsLoad = useCallback(
      (s: AbortSignal) => apiClient.importJobs(organization.id, s),
      [organization.id],
    ),
    jobs = useQuery(`${scope}/${organization.id}/import-jobs`, jobsLoad);
  useEffect(() => {
    if (
      draft.phase === 'done' &&
      draft.value.jobId &&
      draft.value.jobId !== job &&
      form.visible()
    ) {
      const next: Draft<ImportDraft> = { ...draft, phase: 'editing', dirty: false };
      store.write(store.token(organization.id), `import:${draft.value.jobId}`, next, () => next);
      form.clear();
      navigate(`${base}/imports/${draft.value.jobId}`, { replace: true });
    }
  }, [draft, job, form, store, organization.id, base, navigate]);
  useEffect(() => {
    if (draft.phase === 'editing' && draft.value.preview && !draft.value.result && !draft.dirty)
      update((v) => ({ ...v, dirty: true }));
  }, [draft.phase, draft.value.preview, draft.value.result, draft.dirty, update]);
  const busy = draft.phase === 'saving',
    locked = busy || draft.phase === 'uncertain' || draft.phase === 'done' || !enabled;
  const manifest = status.state.status === 'ready' ? status.state.data : null;
  const successful = new Set([
    ...(manifest?.deliveries.filter((v) => v.status === 'succeeded').map((v) => v.deliveryId) ??
      []),
    ...(draft.value.result?.rows.filter((v) => v.status === 'succeeded').map((v) => v.deliveryId) ??
      []),
  ]);
  async function file(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.currentTarget.files?.[0];
    if (!selected) return;
    update((v) => ({ ...v, phase: 'saving', error: '' }));
    try {
      if (selected.size > 262144) throw new Error();
      const csv = new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer());
      update((v) => ({
        ...v,
        phase: 'editing',
        dirty: true,
        value: { ...v.value, csv, columns: [], mapping: {}, preview: null, result: null },
      }));
    } catch {
      update((v) => ({
        ...v,
        phase: 'editing',
        error: 'Choose a UTF-8 CSV file no larger than 256 KiB.',
      }));
    }
  }
  async function columns() {
    update((v) => ({ ...v, phase: 'saving', error: '' }));
    try {
      const result = await apiClient.csvColumns(organization.id, draft.value.csv),
        mapping: ImportDraft['mapping'] = {};
      for (const column of result.columns)
        if (csvFields.includes(column as Field)) mapping[column] = column as Field;
      update((v) => ({
        ...v,
        phase: 'editing',
        value: { ...v.value, columns: result.columns, mapping },
        dirty: true,
      }));
    } catch (e) {
      update((v) => ({ ...v, phase: 'editing', error: crmMessage(e) }));
    }
  }
  async function preview() {
    if (
      !draft.value.columns.every((v) => draft.value.mapping[v]) ||
      new Set(Object.values(draft.value.mapping)).size !== draft.value.columns.length
    ) {
      update((v) => ({ ...v, error: 'Map every column to a different supported field.' }));
      return;
    }
    update((v) => ({ ...v, phase: 'saving', error: '' }));
    try {
      const mapping = Object.fromEntries(
          Object.entries(draft.value.mapping).filter(
            (entry): entry is [string, Field] => entry[1] !== undefined,
          ),
        ),
        result = await apiClient.previewCsv(organization.id, {
          csv: draft.value.csv,
          mapping,
          ...(job ? { jobId: job } : {}),
        });
      update((v) => ({
        ...v,
        phase: job ? 'editing' : 'done',
        dirty: Boolean(job),
        value: {
          ...v.value,
          jobId: result.jobId,
          preview: result,
          choices: {},
          execution: null,
          result: null,
        },
      }));
    } catch (error) {
      update((v) => ({ ...v, phase: 'editing', error: crmMessage(error) }));
    }
  }
  async function execute() {
    let request = draft.phase === 'uncertain' ? draft.submitted?.execution : null;
    if (!request) {
      const rows = draft.value.preview?.rows.filter((v) => !successful.has(v.deliveryId)) ?? [];
      if (!rows.length) return;
      if (
        rows.some(
          (r) =>
            r.intake &&
            (r.candidates.length || r.duplicateRows.length) &&
            !draft.value.choices[r.deliveryId],
        )
      ) {
        update((v) => ({
          ...v,
          error:
            'Resolve every matching row before submitting. Nothing has been imported by this review.',
        }));
        return;
      }
      request = {
        jobId: draft.value.jobId,
        attemptId: crypto.randomUUID(),
        rows: rows.map((row) => {
          const choice = draft.value.choices[row.deliveryId];
          let intake: LeadIntake | null = row.intake;
          if (intake && choice && choice !== 'distinct')
            intake = { ...intake, contact: { mode: 'existing', id: choice } };
          else if (intake?.contact.mode === 'create' && choice === 'distinct')
            intake = {
              ...intake,
              contact: {
                mode: 'create',
                data: { ...intake.contact.data, duplicateResolution: 'create_distinct' },
              },
            };
          return { deliveryId: row.deliveryId, rowNumber: row.rowNumber, intake };
        }),
      };
    }
    const execution = request;
    update((v) => ({
      ...v,
      phase: 'saving',
      error: '',
      dirty: true,
      submitted: { ...v.value, execution },
    }));
    try {
      const result = await apiClient.executeImport(organization.id, execution);
      update((v) => ({
        ...v,
        phase: 'done',
        dirty: false,
        value: { ...v.value, execution, result },
      }));
      status.refresh();
      jobs.refresh();
    } catch (error) {
      update((v) => ({
        ...v,
        phase: uncertain(error) ? 'uncertain' : 'editing',
        error: crmMessage(error),
      }));
    }
  }
  const result =
    draft.value.result ??
    (manifest?.attempts[0]
      ? { jobId: job, attemptId: manifest.attempts[0].attemptId, rows: manifest.attempts[0].rows }
      : null);
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
            Bring your team’s records together
          </p>
          <h2 className="text-3xl font-semibold">Import leads</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            UTF-8 CSV · up to 100 rows, 16 columns and 256 KiB. Preview first, then choose how to
            handle matching contacts.
          </p>
        </div>
        <Link className="text-sm underline" to={`${base}/leads`}>
          Back to leads
        </Link>
      </div>
      <ol className="flex gap-5 text-sm text-muted-foreground">
        <li>1 · Upload & map</li>
        <li>2 · Review matches</li>
        <li>3 · Results</li>
      </ol>
      {job && status.state.status === 'error' && (
        <CrmFailure error={status.state.error} retry={status.refresh} />
      )}
      {result && (
        <section className="space-y-3 rounded-xl border border-border bg-card p-5">
          <h3 className="text-lg font-semibold">Saved import results</h3>
          <p className="text-sm">
            {result.rows.filter((v) => v.status === 'succeeded').length} successful ·{' '}
            {result.rows.filter((v) => v.status === 'failed').length} need attention in this
            attempt.
          </p>
          <ul className="max-h-80 space-y-2 overflow-y-auto">
            {result.rows.map((row) => {
              const prior = manifest?.deliveries.find((v) => v.deliveryId === row.deliveryId);
              return (
                <li key={row.deliveryId} className="rounded-lg border border-border p-3 text-sm">
                  Row {row.rowNumber} ·{' '}
                  {row.status === 'succeeded' ? (
                    <Link className="underline" to={`${base}/leads/${row.leadId}`}>
                      Open imported lead
                    </Link>
                  ) : row.code === 'DELIVERY_ALREADY_SUCCEEDED' && prior?.leadId ? (
                    <span>
                      Previously imported; changes weren’t applied.{' '}
                      <Link className="underline" to={`${base}/leads/${prior.leadId}`}>
                        Open lead
                      </Link>
                    </span>
                  ) : row.code === 'DUPLICATE_REVIEW_REQUIRED' ? (
                    'Review the matching contact.'
                  ) : row.code === 'NOT_FOUND' ? (
                    'The selected contact or source is unavailable.'
                  ) : (
                    'Check this row’s required fields and formatting.'
                  )}
                </li>
              );
            })}
          </ul>
          {draft.phase === 'done' && (
            <Button
              variant="outline"
              onClick={() =>
                update((v) => ({
                  ...v,
                  phase: 'editing',
                  value: { ...v.value, execution: null },
                  dirty: false,
                  error: '',
                }))
              }
            >
              Review remaining rows
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            Successful deliveries stay locked to their original records. Correct failed rows using a
            new preview; keep the original row order.
          </p>
        </section>
      )}
      <section className="space-y-4 rounded-xl border border-border bg-card p-5">
        <h3 className="text-lg font-semibold">Upload & map</h3>
        <fieldset disabled={locked} className="space-y-4">
          <label className="block text-sm">
            CSV file
            <input
              className="mt-2 block max-w-full text-sm"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void file(e)}
            />
          </label>
          <label className="block text-sm">
            Or paste CSV
            <textarea
              className="field min-h-32 font-mono text-xs"
              value={draft.value.csv}
              onChange={(e) =>
                form.change({
                  ...draft.value,
                  csv: e.currentTarget.value,
                  columns: [],
                  mapping: {},
                  preview: null,
                  result: null,
                })
              }
              placeholder="displayName,title,email"
              maxLength={262144}
            />
          </label>
          <Button
            type="button"
            variant="outline"
            disabled={!draft.value.csv}
            onClick={() => void columns()}
          >
            Read columns
          </Button>
          {draft.value.columns.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {draft.value.columns.map((column) => (
                <label className="text-sm" key={column}>
                  {column}
                  <select
                    className="field"
                    value={draft.value.mapping[column] ?? ''}
                    onChange={(e) => {
                      const mapping = { ...draft.value.mapping };
                      if (e.currentTarget.value) mapping[column] = e.currentTarget.value as Field;
                      else delete mapping[column];
                      form.change({ ...draft.value, mapping, preview: null });
                    }}
                  >
                    <option value="">Choose a field</option>
                    {csvFields.map((field) => (
                      <option key={field} value={field}>
                        {labels[field]}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          {draft.value.columns.length > 0 && (
            <Button type="button" onClick={() => void preview()}>
              Preview import
            </Button>
          )}
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Display name and lead title are required. Phone country codes use two letters, such as US.
          Each row can include three emails and one phone.
        </p>
      </section>
      {draft.value.preview && (
        <section className="space-y-4">
          <h3 className="text-lg font-semibold">Review rows</h3>
          <div className="space-y-3">
            {draft.value.preview.rows.map((row) => {
              const done = successful.has(row.deliveryId);
              return (
                <div
                  className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm"
                  key={row.deliveryId}
                >
                  <p className="font-medium">
                    Row {row.rowNumber} · {row.intake?.lead.title ?? 'Needs correction'}
                    {done ? ' · already imported' : ''}
                  </p>
                  {row.intake?.contact.mode === 'create' && (
                    <p className="text-muted-foreground">{row.intake.contact.data.displayName}</p>
                  )}
                  {row.errorCode && (
                    <p className="text-destructive">
                      Check the required fields, email and phone formatting in this CSV row.
                    </p>
                  )}
                  {!done &&
                    !row.errorCode &&
                    (row.candidates.length > 0 || row.duplicateRows.length > 0) && (
                      <label className="block">
                        Contact resolution
                        {row.duplicateRows.length > 0 && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            Also matches rows {row.duplicateRows.join(', ')}
                          </span>
                        )}
                        <select
                          className="field"
                          disabled={locked}
                          value={draft.value.choices[row.deliveryId] ?? ''}
                          onChange={(e) =>
                            form.change({
                              ...draft.value,
                              choices: {
                                ...draft.value.choices,
                                [row.deliveryId]: e.currentTarget.value,
                              },
                            })
                          }
                        >
                          <option value="">Choose explicitly</option>
                          <option value="distinct">Create a separate contact</option>
                          {row.candidates
                            .filter((v) => !v.archived_at)
                            .map((v) => (
                              <option key={v.id} value={v.id}>
                                Use {v.display_name}
                                {v.emails[0] ? ` · ${v.emails[0].value}` : ''}
                              </option>
                            ))}
                        </select>
                      </label>
                    )}
                </div>
              );
            })}
          </div>
          <Button
            disabled={locked || draft.value.preview.rows.every((v) => successful.has(v.deliveryId))}
            onClick={() => void execute()}
          >
            Import remaining rows
          </Button>
        </section>
      )}
      {draft.phase === 'uncertain' && (
        <div role="alert" className="space-y-3">
          <p>
            The request may have committed. Retry this same attempt to recover its saved result.
          </p>
          <Button onClick={() => void execute()}>Retry same attempt</Button>
        </div>
      )}
      {busy && <p role="status">Working on this import…</p>}
      {draft.error && (
        <p role="alert" className="text-sm text-destructive">
          {draft.error}
        </p>
      )}
      {draft.value.csv && (
        <Button
          variant="outline"
          onClick={() =>
            confirmDiscard(() => {
              store.discardActive();
              update((v) => ({
                ...v,
                dirty: false,
                value: {
                  ...v.value,
                  csv: '',
                  columns: [],
                  mapping: {},
                  preview: null,
                  choices: {},
                },
              }));
            })
          }
        >
          Clear CSV from memory
        </Button>
      )}
      {!job && (
        <section className="space-y-3">
          <h3 className="text-lg font-semibold">Recent imports</h3>
          {jobs.state.status === 'loading' ? (
            <p role="status">Loading imports…</p>
          ) : jobs.state.status === 'error' ? (
            <CrmFailure error={jobs.state.error} retry={jobs.refresh} />
          ) : jobs.state.data.jobs.length ? (
            <ul className="space-y-2">
              {jobs.state.data.jobs.map((v) => (
                <li key={v.id}>
                  <Link className="text-sm underline" to={`${base}/imports/${v.id}`}>
                    Import from {new Date(v.created_at).toLocaleString()}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No imports yet.</p>
          )}
        </section>
      )}
    </section>
  );
}
