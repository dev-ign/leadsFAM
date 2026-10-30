import { parse } from 'csv-parse/sync';
import { csvFields, leadIntakeSchema } from '@leadops/shared';
import { IdentityFailure } from '../identity/failure.js';
import { normalizeIntake } from './intake.js';

function readRecords(csv: string) {
  if (Buffer.byteLength(csv, 'utf8') > 262144) throw new IdentityFailure(413, 'CSV_TOO_LARGE');
  if (
    csv.includes('\uFFFD') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(csv) ||
    csv.includes('\0')
  )
    throw new IdentityFailure(400, 'CSV_INVALID_ENCODING');
  let records: string[][];
  try {
    records = parse(csv, {
      bom: true,
      columns: false,
      delimiter: ',',
      cast: false,
      relax_quotes: false,
      relax_column_count: false,
      skip_empty_lines: true,
      max_record_size: 16384,
      on_record(record, context) {
        if (context.records > 101) throw new IdentityFailure(413, 'CSV_TOO_MANY_ROWS');
        return record;
      },
    });
  } catch (error) {
    if (error instanceof IdentityFailure) throw error;
    throw new IdentityFailure(400, 'CSV_INVALID_FORMAT');
  }
  const columns = records.shift()?.map((v) => v.trim()) ?? [];
  if (
    !columns.length ||
    columns.length > 16 ||
    !records.length ||
    columns.some(
      (v) =>
        !v || v.length > 80 || ['__proto__', 'constructor', 'prototype'].includes(v.toLowerCase()),
    ) ||
    new Set(columns.map((v) => v.toLowerCase())).size !== columns.length
  )
    throw new IdentityFailure(400, 'CSV_INVALID_HEADERS');
  for (const record of records) {
    if (
      record.some((v) => Buffer.byteLength(v, 'utf8') > 4096) ||
      record.reduce((n, v) => n + Buffer.byteLength(v, 'utf8') + 1, 0) > 16384
    )
      throw new IdentityFailure(413, 'CSV_FIELD_TOO_LARGE');
  }
  return { columns, records };
}
export function csvColumns(csv: string) {
  return readRecords(csv).columns;
}
export function parseCsv(
  csv: string,
  mapping?: Partial<Record<string, (typeof csvFields)[number]>>,
) {
  const { columns, records } = readRecords(csv);
  if (mapping && Object.keys(mapping).some((key) => !columns.includes(key)))
    throw new IdentityFailure(400, 'CSV_INVALID_MAPPING');
  const fields = columns.map(
    (header) =>
      (mapping && Object.hasOwn(mapping, header) ? mapping[header] : undefined) ??
      (csvFields.includes(header as (typeof csvFields)[number])
        ? (header as (typeof csvFields)[number])
        : undefined),
  );
  if (
    fields.some((v) => v === undefined) ||
    new Set(fields).size !== fields.length ||
    !fields.includes('displayName') ||
    !fields.includes('title')
  )
    throw new IdentityFailure(400, 'CSV_INVALID_MAPPING');
  const rows = records.map((record, index) => {
    if (
      record.some((v) => Buffer.byteLength(v, 'utf8') > 4096) ||
      record.reduce((n, v) => n + Buffer.byteLength(v, 'utf8') + 1, 0) > 16384
    )
      throw new IdentityFailure(413, 'CSV_FIELD_TOO_LARGE');
    const values = new Map(fields.map((field, i) => [field, record[i] ?? '']));
    const get = (key: (typeof csvFields)[number]) => values.get(key) ?? '';
    const input = leadIntakeSchema.safeParse({
      contact: {
        mode: 'create',
        data: {
          kind: get('kind') || 'person',
          displayName: get('displayName'),
          firstName: get('firstName'),
          lastName: get('lastName'),
          companyName: get('companyName'),
          emails: [get('email'), get('email2'), get('email3')].filter(Boolean),
          phones: get('phone')
            ? [
                {
                  value: get('phone'),
                  ...(get('phoneRegion') ? { region: get('phoneRegion') } : {}),
                },
              ]
            : [],
        },
      },
      lead: {
        title: get('title'),
        description: get('description'),
        priority: get('priority') || 'normal',
      },
      attribution: Object.fromEntries(
        ['sourceId', 'campaign', 'externalReference']
          .filter((v) => get(v as (typeof csvFields)[number]))
          .map((v) => [v, get(v as (typeof csvFields)[number])]),
      ),
    });
    if (!input.success)
      return {
        rowNumber: index + 1,
        intake: null,
        normalized: null,
        errorCode: 'INVALID_FIELDS',
        fields: [...new Set(input.error.issues.map((issue) => issue.path.join('.')))].slice(0, 20),
      };
    try {
      return {
        rowNumber: index + 1,
        intake: input.data,
        normalized: normalizeIntake(input.data),
        errorCode: null,
        fields: [],
      };
    } catch (error) {
      return {
        rowNumber: index + 1,
        intake: null,
        normalized: null,
        errorCode: error instanceof IdentityFailure ? error.code : 'INVALID_FIELDS',
        fields: ['contact.phones'],
      };
    }
  });
  return { columns, rows };
}
