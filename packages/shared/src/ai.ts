import { z } from 'zod';

export const aiPromptVersion = 'lead-assist-v1' as const;
const short = z.string().trim().min(1).max(160);
export const businessContextSchema = z.strictObject({
  name: z.string().trim().max(80),
  description: z.string().trim().max(600),
  services: z.array(short).max(10),
  serviceAreas: z.array(short).max(10),
  tone: z.enum(['warm', 'concise', 'formal']),
  questions: z.array(short).max(8),
  guidelines: z.string().trim().max(600),
  restrictions: z.string().trim().max(600),
  escalation: z.string().trim().max(300),
});
export const aiSettingsInput = z.strictObject({
  enabled: z.boolean(),
  provider: z.enum(['simulation', 'openai']),
  dailyLimit: z.int().min(1).max(500),
  concurrentLimit: z.int().min(1).max(3),
  business: businessContextSchema,
});
export const aiSettingsSchema = aiSettingsInput.extend({ version: z.int().positive() });
export const aiQuestion = z.enum([
  'service',
  'scope',
  'location',
  'timeframe',
  'contact_preference',
]);
export const aiDraftKind = z.enum([
  'acknowledgment',
  'follow_up',
  'service_response',
  'information_request',
  'handoff',
]);
export const aiRequestInput = z.strictObject({
  leadId: z.uuid(),
  task: z.enum(['analysis', 'draft']),
  channel: z.enum(['email', 'sms']),
  kind: aiDraftKind,
});
export const aiEvidenceSchema = z.strictObject({
  source: z.enum(['lead.title', 'lead.description']),
  quote: z.string().min(1).max(300),
});
// Extracted facts must be verbatim evidence; recommendations are explicitly unverified.
export const aiAnalysisSchema = z.strictObject({
  intent: aiEvidenceSchema.nullable(),
  service: aiEvidenceSchema.nullable(),
  status: z.enum([
    'needs_information',
    'potentially_qualified',
    'qualified_for_review',
    'not_a_match',
    'requires_manual_review',
  ]),
  priority: z.enum(['low', 'normal', 'high']),
  urgency: aiEvidenceSchema.nullable(),
  requirements: z.array(aiEvidenceSchema).max(8),
  location: aiEvidenceSchema.nullable(),
  timeframe: aiEvidenceSchema.nullable(),
  missing: z.array(aiQuestion).max(5),
  nextAction: z.enum(['ask_questions', 'human_review', 'acknowledge', 'not_match']),
  uncertainty: z.enum(['insufficient_information', 'requires_confirmation']),
});
// The provider chooses a bounded response plan, never recipients, policies, or send operations.
export const aiPlanSchema = z.strictObject({ questions: z.array(aiQuestion).max(5) });
export const aiModelOutputSchema = z.strictObject({
  analysis: aiAnalysisSchema,
  plan: aiPlanSchema,
});
export const aiSourceSchema = z.strictObject({
  lead: z.strictObject({ title: z.string().max(160), description: z.string().max(2000) }),
  contactName: z.string().max(80),
  business: businessContextSchema,
});
export const aiOutcomeSchema = z.strictObject({
  analysis: aiAnalysisSchema,
  proposal: z
    .strictObject({ subject: z.string().max(200), body: z.string().min(1).max(1600) })
    .nullable(),
  reasoning: z.string().max(700),
});
export const aiRunSchema = z.strictObject({
  id: z.uuid(),
  lead_id: z.uuid(),
  task: z.enum(['analysis', 'draft']),
  channel: z.enum(['email', 'sms']),
  kind: aiDraftKind,
  trigger: z.enum(['manual', 'workflow']),
  state: z.enum(['queued', 'claimed', 'retryable', 'succeeded', 'failed', 'attention']),
  provider: z.enum(['simulation', 'openai']),
  model: z.string().max(120).nullable(),
  prompt_version: z.literal(aiPromptVersion),
  analysis_version: z.literal(1),
  attempts: z.int().nonnegative(),
  code: z.string().max(60).nullable(),
  result: aiOutcomeSchema.nullable(),
  message_id: z.uuid().nullable(),
  input_tokens: z.int().nonnegative().nullable(),
  output_tokens: z.int().nonnegative().nullable(),
  estimated_cost_microusd: z.number().nonnegative().nullable(),
  pricing_version: z.string().nullable(),
  duration_ms: z.int().nonnegative().nullable(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export const aiHistorySchema = z.strictObject({
  items: z.array(aiRunSchema).max(20),
  next: z.string().nullable(),
});
export const aiClaimSchema = z.strictObject({
  id: z.uuid(),
  token: z.uuid(),
  generation: z.int().positive(),
});
export const aiEnvelopeSchema = z.strictObject({
  source: aiSourceSchema,
  task: z.enum(['analysis', 'draft']),
  channel: z.enum(['email', 'sms']),
  kind: aiDraftKind,
  provider: z.enum(['simulation', 'openai']),
});
export type AiSource = z.infer<typeof aiSourceSchema>;
export type AiRun = z.infer<typeof aiRunSchema>;
export type AiSettings = z.infer<typeof aiSettingsSchema>;
