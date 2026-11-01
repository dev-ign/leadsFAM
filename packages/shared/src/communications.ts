import { z } from 'zod';

export const communicationChannel = z.enum(['email', 'sms']);
export const communicationPurpose = z.enum(['transactional', 'marketing']);
export const messageState = z.enum([
  'draft',
  'queued',
  'submitting',
  'submitted',
  'delivered',
  'failed',
  'bounced',
  'suppressed',
  'attention',
]);
const destination = z.string().trim().min(3).max(254);
export const messageDraftSchema = z
  .strictObject({
    id: z.uuid(),
    contactId: z.uuid(),
    leadId: z.uuid().nullable(),
    channel: communicationChannel,
    purpose: communicationPurpose,
    recipient: destination,
    subject: z.string().trim().max(200),
    body: z.string().trim().min(1).max(4000),
  })
  .superRefine((v, ctx) => {
    if (v.channel === 'email' && (!z.email().safeParse(v.recipient).success || !v.subject))
      ctx.addIssue({ code: 'custom', message: 'Enter a valid email and subject.' });
    if (
      v.channel === 'sms' &&
      (!/^\+[1-9][0-9]{6,14}$/.test(v.recipient) || v.body.length > 1600 || v.subject !== '')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Use an international phone number and at most 1600 characters.',
      });
  });
export const permissionInputSchema = z.strictObject({
  contactId: z.uuid(),
  channel: communicationChannel,
  purpose: communicationPurpose,
  recipient: destination,
  status: z.enum(['granted', 'revoked']),
  source: z.string().trim().min(1).max(160),
  collectedAt: z.iso.datetime({ offset: true }),
  jurisdiction: z.string().regex(/^[A-Z]{2}$/),
  policyVersion: z.string().trim().min(1).max(80),
  evidence: z.string().trim().min(1).max(200),
});
export const suppressionInputSchema = z.strictObject({
  channel: communicationChannel,
  recipient: destination,
  suppressed: z.boolean(),
});
export const communicationSettingsInput = z.strictObject({
  paused: z.boolean(),
  dailyLimit: z.int().min(1).max(10000),
  recipientDailyLimit: z.int().min(1).max(100),
  channelDailyLimit: z.int().min(1).max(10000),
  concurrentLimit: z.int().min(1).max(10),
  requestsPerMinute: z.int().min(1).max(60),
  maxAttempts: z.int().min(1).max(5),
});
export const communicationSettingsSchema = communicationSettingsInput.extend({
  mode: z.literal('mock'),
  liveEnabled: z.literal(false),
  senderEmail: z.literal('FreshNest <mock@example.test>'),
  senderSms: z.literal('+15005550006'),
  attentionCount: z.int().nonnegative(),
  queuedCount: z.int().nonnegative(),
});
export const communicationMessageSchema = z.strictObject({
  id: z.uuid(),
  conversation_id: z.uuid(),
  contact_id: z.uuid(),
  lead_id: z.uuid().nullable(),
  direction: z.enum(['inbound', 'outbound']),
  channel: communicationChannel,
  purpose: communicationPurpose,
  sender: z.string(),
  recipient: z.string(),
  subject: z.string(),
  body: z.string(),
  state: messageState,
  version: z.int().positive(),
  code: z.string().nullable(),
  provider: z.literal('mock'),
  provider_message_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const communicationEventSchema = z.strictObject({
  id: z.uuid(),
  message_id: z.uuid(),
  event: z.string(),
  code: z.string().nullable(),
  created_at: z.string(),
});
export const communicationEventPageSchema = z.strictObject({
  items: z.array(communicationEventSchema).max(100),
  next: z.string().nullable(),
});
export const conversationSchema = z.strictObject({
  id: z.uuid(),
  contact_id: z.uuid(),
  lead_id: z.uuid().nullable(),
  channel: communicationChannel,
  contact_name: z.string(),
  lead_title: z.string().nullable(),
  state: messageState,
  updated_at: z.string(),
});
export const conversationPageSchema = z.strictObject({
  items: z.array(conversationSchema).max(50),
  next: z.string().nullable(),
});
export const communicationHistorySchema = z.strictObject({
  messages: z.array(communicationMessageSchema).max(50),
  events: z.array(communicationEventSchema).max(500),
  next: z.string().nullable(),
});
export const communicationPermissionSchema = z.strictObject({
  channel: communicationChannel,
  purpose: communicationPurpose,
  recipient: z.string(),
  status: z.enum(['granted', 'revoked']),
  source: z.string(),
  collected_at: z.string(),
  revoked_at: z.string().nullable(),
  jurisdiction: z.string(),
  policy_version: z.string(),
  evidence: z.string(),
});
export const communicationEligibilitySchema = z.strictObject({
  code: z.string().nullable(),
  permissions: z.array(communicationPermissionSchema).max(12),
  suppressed: z.boolean(),
});
export const communicationClaimSchema = z.strictObject({
  id: z.uuid(),
  token: z.uuid(),
  generation: z.int().positive(),
});
export const dispatchEnvelopeSchema = z.strictObject({
  id: z.uuid(),
  channel: communicationChannel,
  sender: z.string(),
  recipient: z.string(),
  subject: z.string(),
  body: z.string(),
  providerReference: z.string(),
  operation: z.enum(['send', 'reconcile']),
});
export const providerEventSchema = z.strictObject({
  eventId: z.string().regex(/^[A-Za-z0-9:_-]{1,160}$/),
  reference: z
    .string()
    .regex(/^mock:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
  channel: communicationChannel,
  type: z.enum(['delivered', 'failed', 'bounced', 'opt_out', 'start']),
});
export type CommunicationMessage = z.infer<typeof communicationMessageSchema>;
export type DispatchEnvelope = z.infer<typeof dispatchEnvelopeSchema>;
export type ProviderEvent = z.infer<typeof providerEventSchema>;
