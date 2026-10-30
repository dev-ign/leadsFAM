import { z } from 'zod';

const name = z.string().trim().min(1).max(160);
export const crmVersionSchema = z.strictObject({ version: z.int().positive() });
export const contactInputSchema = z
  .strictObject({
    kind: z.enum(['person', 'company']),
    displayName: name,
    firstName: z.string().trim().max(80).default(''),
    lastName: z.string().trim().max(80).default(''),
    companyName: z.string().trim().max(160).default(''),
    emails: z.array(z.email().max(254)).max(3).default([]),
    phones: z
      .array(
        z.strictObject({
          value: z.string().trim().min(1).max(40),
          region: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .optional(),
        }),
      )
      .max(3)
      .default([]),
    duplicateResolution: z.literal('create_distinct').optional(),
  })
  .refine((data) => data.kind !== 'company' || data.companyName.length > 0, {
    path: ['companyName'],
    message: 'Company contacts require a company name.',
  });
export type ContactInput = z.infer<typeof contactInputSchema>;
export const contactUpdateSchema = z.strictObject({
  version: z.int().positive(),
  contact: contactInputSchema,
});
export const leadFieldsSchema = z.strictObject({
  title: name,
  description: z.string().max(4000).default(''),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
});
export const leadUpdateSchema = z.strictObject({
  version: z.int().positive(),
  lead: leadFieldsSchema,
});
export const leadTransitionSchema = z.strictObject({
  version: z.int().positive(),
  status: z.enum(['in_progress', 'qualified', 'closed']),
  outcome: z.enum(['won', 'lost', 'unqualified']).optional(),
  reason: z.string().trim().min(1).max(300).optional(),
});
export const leadAssignmentSchema = z.strictObject({
  version: z.int().positive(),
  userId: z.uuid().nullable(),
});
export const sourceInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  archived: z.boolean().default(false),
});
export const sourceUpdateSchema = z.strictObject({
  version: z.int().positive(),
  source: sourceInputSchema,
});
const stamp = z.iso.datetime({ offset: true });
const aggregate = {
  id: z.uuid(),
  organization_id: z.uuid(),
  version: z.int().positive(),
  created_by: z.uuid(),
  created_at: stamp,
  updated_at: stamp,
  archived_at: stamp.nullable(),
};
export const contactSchema = z.strictObject({
  ...aggregate,
  kind: z.enum(['person', 'company']),
  display_name: name,
  first_name: z.string().max(80),
  last_name: z.string().max(80),
  company_name: z.string().max(160),
  emails: z
    .array(z.strictObject({ value: z.string().max(254), normalized: z.string().max(254) }))
    .max(3),
  phones: z
    .array(
      z.strictObject({
        value: z.string().max(40),
        normalized: z.string().max(16).nullable(),
        region: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .nullable(),
      }),
    )
    .max(3),
  first_touch: z
    .strictObject({
      leadId: z.uuid(),
      channel: z.enum(['manual', 'csv']),
      sourceId: z.uuid().nullable(),
      campaign: z.string().max(160).nullable(),
      acceptedAt: stamp,
    })
    .nullable(),
});
export type Contact = z.infer<typeof contactSchema>;
export const sourceSchema = z.strictObject({ ...aggregate, name: z.string().max(80) });
export const attributionSchema = z.strictObject({
  organization_id: z.uuid(),
  lead_id: z.uuid(),
  source_id: z.uuid().nullable(),
  channel: z.enum(['manual', 'csv']),
  provider: z.string().max(80).nullable(),
  external_reference: z.string().max(160).nullable(),
  campaign: z.string().max(160).nullable(),
  utm_source: z.string().max(160).nullable(),
  utm_medium: z.string().max(160).nullable(),
  landing_url: z.string().max(2048).nullable(),
  claimed_acquired_at: stamp.nullable(),
  accepted_at: stamp,
});
export const leadSchema = z.strictObject({
  ...aggregate,
  contact_id: z.uuid(),
  title: name,
  description: z.string().max(4000),
  priority: z.enum(['low', 'normal', 'high']),
  status: z.enum(['new', 'in_progress', 'qualified', 'closed']),
  outcome: z.enum(['won', 'lost', 'unqualified']).nullable(),
  closed_at: stamp.nullable(),
  last_assigned_user_id: z.uuid().nullable(),
  assigned_membership_generation: z.int().positive().nullable(),
  current_assignee_id: z.uuid().nullable(),
  last_activity_at: stamp,
  contact: contactSchema,
  attribution: attributionSchema.nullable(),
});
export type Lead = z.infer<typeof leadSchema>;
export const crmIdempotencyKeySchema = z.uuid();

export const attributionInputSchema = z.strictObject({
  sourceId: z.uuid().optional(),
  provider: z.string().max(80).optional(),
  externalReference: z.string().max(160).optional(),
  campaign: z.string().max(160).optional(),
  utmSource: z.string().max(160).optional(),
  utmMedium: z.string().max(160).optional(),
  landingUrl: z
    .url()
    .max(2048)
    .refine((v) => ['http:', 'https:'].includes(new URL(v).protocol))
    .optional(),
  acquiredAt: z.iso
    .datetime({ offset: true })
    .refine((v) => v >= '1900-01-01' && v < '2100-01-01')
    .optional(),
});
export const leadIntakeSchema = z.strictObject({
  contact: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('existing'), id: z.uuid() }),
    z.strictObject({ mode: z.literal('create'), data: contactInputSchema }),
  ]),
  lead: leadFieldsSchema,
  attribution: attributionInputSchema.default({}),
});
export type LeadIntake = z.infer<typeof leadIntakeSchema>;
export const importSubmissionSchema = z.strictObject({
  jobId: z.uuid(),
  attemptId: z.uuid(),
  rows: z
    .array(
      z.strictObject({
        deliveryId: z.uuid(),
        rowNumber: z.int().min(1).max(100),
        intake: z.unknown(),
      }),
    )
    .min(1)
    .max(100),
});
export const importRowResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    deliveryId: z.uuid(),
    rowNumber: z.int().min(1).max(100),
    status: z.literal('succeeded'),
    contactId: z.uuid(),
    leadId: z.uuid(),
  }),
  z.strictObject({
    deliveryId: z.uuid(),
    rowNumber: z.int().min(1).max(100),
    status: z.literal('failed'),
    code: z.enum([
      'DELIVERY_ALREADY_SUCCEEDED',
      'DUPLICATE_REVIEW_REQUIRED',
      'NOT_FOUND',
      'IDEMPOTENCY_CONFLICT',
      'FORBIDDEN',
      'INVALID_FIELDS',
    ]),
  }),
]);
export const importResultSchema = z.strictObject({
  jobId: z.uuid(),
  attemptId: z.uuid(),
  rows: z.array(importRowResultSchema).max(100),
});
export type ImportResult = z.infer<typeof importResultSchema>;
export const importStatusSchema = z.strictObject({
  jobId: z.uuid(),
  deliveries: z
    .array(
      z.strictObject({
        deliveryId: z.uuid(),
        rowNumber: z.int().min(1).max(100),
        status: z.enum(['pending', 'succeeded']),
        leadId: z.uuid().nullable(),
        contactId: z.uuid().nullable(),
      }),
    )
    .max(100),
  attempts: z
    .array(
      z.strictObject({
        attemptId: z.uuid(),
        createdAt: stamp,
        rows: z.array(importRowResultSchema).max(100),
      }),
    )
    .max(10),
});
export const importJobsSchema = z.strictObject({
  jobs: z.array(z.strictObject({ id: z.uuid(), created_at: stamp })).max(25),
});
export const csvFields = [
  'kind',
  'displayName',
  'firstName',
  'lastName',
  'companyName',
  'email',
  'email2',
  'email3',
  'phone',
  'phoneRegion',
  'title',
  'description',
  'priority',
  'sourceId',
  'campaign',
  'externalReference',
] as const;
export const csvPreviewInputSchema = z.strictObject({
  csv: z.string().max(262144),
  jobId: z.uuid().optional(),
  mapping: z
    .record(z.string().max(80), z.enum(csvFields))
    .refine((value) => Object.keys(value).length <= 16)
    .optional(),
});
export const csvPreviewSchema = z.strictObject({
  jobId: z.uuid(),
  columns: z.array(z.string().max(80)).max(16),
  rows: z
    .array(
      z.strictObject({
        deliveryId: z.uuid(),
        rowNumber: z.int().min(1).max(100),
        intake: leadIntakeSchema.nullable(),
        errorCode: z.string().max(50).nullable(),
        fields: z.array(z.string().max(100)).max(20),
        candidates: z.array(contactSchema).max(10),
        duplicateRows: z.array(z.int().min(1).max(100)).max(100),
      }),
    )
    .max(100),
});
export type CsvPreview = z.infer<typeof csvPreviewSchema>;
export const csvColumnsSchema = z.strictObject({ columns: z.array(z.string().max(80)).max(16) });

const rangeDate = z.iso
  .date()
  .refine((v) => v >= '1900-01-01' && v < '2100-01-01')
  .nullable()
  .default(null);
export const crmQuerySchema = z
  .strictObject({
    searchMode: z.enum(['prefix', 'contains']).default('prefix'),
    contactId: z.uuid().nullable().default(null),
    q: z.string().trim().max(100).default(''),
    status: z.enum(['all', 'new', 'in_progress', 'qualified', 'closed']).default('all'),
    priority: z.enum(['all', 'low', 'normal', 'high']).default('all'),
    sourceId: z.uuid().nullable().default(null),
    assignee: z.union([z.enum(['all', 'unassigned', 'mine']), z.uuid()]).default('all'),
    archived: z.enum(['active', 'archived', 'all']).default('active'),
    from: rangeDate,
    to: rangeDate,
    sort: z.enum(['created', 'activity']).default('created'),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(2048).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'Invalid date range.' });
export type CrmQuery = z.infer<typeof crmQuerySchema>;
export const activityQuerySchema = z.strictObject({
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(2048).optional(),
});
export const contactPageSchema = z.strictObject({
  items: z.array(contactSchema).max(100),
  cursor: z.string().max(2048).nullable(),
});
export const leadPageSchema = z.strictObject({
  items: z.array(leadSchema).max(100),
  cursor: z.string().max(2048).nullable(),
});
const activityBase = {
  reason: z.string().max(300).nullable(),
  id: z.uuid(),
  organization_id: z.uuid(),
  lead_id: z.uuid().nullable(),
  contact_id: z.uuid().nullable(),
  actor_id: z.uuid(),
  request_id: z.string().max(80).nullable(),
  created_at: stamp,
  subject: z.enum(['lead', 'contact']),
};
export const activitySchema = z.discriminatedUnion('event', [
  z.strictObject({
    ...activityBase,
    event: z.enum([
      'contact.created',
      'contact.archived',
      'contact.restored',
      'lead.archived',
      'lead.restored',
    ]),
    details: z.strictObject({}),
  }),
  z.strictObject({
    ...activityBase,
    event: z.literal('contact.updated'),
    details: z.strictObject({
      fields: z
        .array(
          z.enum([
            'kind',
            'displayName',
            'firstName',
            'lastName',
            'companyName',
            'emails',
            'phones',
          ]),
        )
        .max(7),
    }),
  }),
  z.strictObject({
    ...activityBase,
    event: z.literal('lead.updated'),
    details: z.strictObject({
      fields: z.array(z.enum(['title', 'description', 'priority'])).max(3),
    }),
  }),
  z.strictObject({
    ...activityBase,
    event: z.literal('lead.created'),
    details: z.strictObject({ channel: z.enum(['manual', 'csv']), sourceId: z.uuid().nullable() }),
  }),
  z.strictObject({
    ...activityBase,
    event: z.literal('lead.assigned'),
    details: z.strictObject({ userId: z.uuid().nullable() }),
  }),
  z.strictObject({
    ...activityBase,
    event: z.literal('lead.transitioned'),
    details: z.strictObject({
      from: z.enum(['new', 'in_progress', 'qualified', 'closed']),
      to: z.enum(['in_progress', 'qualified', 'closed']),
      outcome: z.enum(['won', 'lost', 'unqualified']).optional(),
      reasonProvided: z.boolean(),
    }),
  }),
]);
export const activityPageSchema = z.strictObject({
  items: z.array(activitySchema).max(100),
  cursor: z.string().max(2048).nullable(),
});
export type CrmActivity = z.infer<typeof activitySchema>;
