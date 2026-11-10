import { z } from 'zod';

export const aiPromptVersion = 'lead-assist-v2' as const;
const short = z.string().trim().min(1).max(160);
export const businessKnowledgeSchema = z.strictObject({
  serviceDescriptions: z
    .array(z.strictObject({ service: short, description: z.string().trim().min(1).max(400) }))
    .max(10),
  faqs: z
    .array(z.strictObject({ question: short, answer: z.string().trim().min(1).max(400) }))
    .max(8),
  pricing: z.string().trim().max(600),
  scheduling: z.string().trim().max(600),
  hours: z.string().trim().max(300),
  requiredInformation: z.array(short).max(8),
  unsupportedRequests: z.array(short).max(8),
});
export const emptyBusinessKnowledge = {
  serviceDescriptions: [],
  faqs: [],
  pricing: '',
  scheduling: '',
  hours: '',
  requiredInformation: [],
  unsupportedRequests: [],
};
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
  knowledge: businessKnowledgeSchema.default(emptyBusinessKnowledge),
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
  source: z.string().regex(/^(lead\.(title|description)|conversation\.[0-9a-f-]{36})$/),
  quote: z.string().min(1).max(300),
});
// Extracted facts must be verbatim evidence; recommendations are explicitly unverified.
const legacyAnalysisSchema = z.strictObject({
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
const qualificationFields = {
  intentCategory: z.enum([
    'service_inquiry',
    'pricing',
    'scheduling',
    'complaint',
    'other',
    'unknown',
  ]),
  serviceFit: z.enum(['supported', 'unsupported', 'unknown']),
  approvedService: z.int().min(0).max(9).nullable(),
  areaFit: z.enum(['supported', 'unsupported', 'unknown']),
  urgencyLevel: z.enum(['urgent', 'routine', 'unknown']),
  budget: aiEvidenceSchema.nullable(),
  requiredAnswers: z
    .array(z.strictObject({ index: z.int().min(0).max(7), evidence: aiEvidenceSchema.nullable() }))
    .max(8),
  conflictingInformation: z.boolean(),
  humanReview: z.boolean(),
};
// Old saved results remain readable without rewriting their content.
export const aiAnalysisSchema = legacyAnalysisSchema.extend(
  Object.fromEntries(
    Object.entries(qualificationFields).map(([key, schema]) => [key, schema.optional()]),
  ) as {
    [K in keyof typeof qualificationFields]: z.ZodOptional<(typeof qualificationFields)[K]>;
  },
);
export const aiQualificationSchema = legacyAnalysisSchema.extend(qualificationFields);
export const aiKnowledgeRefSchema = z.strictObject({
  category: z.enum(['serviceDescriptions', 'faqs', 'pricing', 'scheduling', 'hours']),
  index: z.int().min(0).max(9),
});
// The provider chooses a bounded response plan, never recipients, policies, or send operations.
export const aiPlanSchema = z.strictObject({
  questions: z.array(aiQuestion).max(5),
  businessQuestions: z.array(z.int().min(0).max(7)).max(3),
  knowledge: z.array(aiKnowledgeRefSchema).max(3),
});
export const aiModelOutputSchema = z.strictObject({
  analysis: aiQualificationSchema,
  plan: aiPlanSchema,
});
export const aiSourceSchema = z.strictObject({
  lead: z.strictObject({ title: z.string().max(160), description: z.string().max(2000) }),
  contactName: z.string().max(80),
  business: businessContextSchema,
  knowledgeVersion: z.int().positive().default(1),
  inquiryAt: z.string().default(''),
  request: aiRequestInput
    .omit({ leadId: true })
    .default({ task: 'analysis', channel: 'email', kind: 'follow_up' }),
  conversation: z
    .array(
      z.strictObject({
        id: z.uuid(),
        direction: z.enum(['inbound', 'outbound']),
        body: z.string().max(600),
        at: z.string(),
      }),
    )
    .max(6)
    .default([]),
});
export const aiOutcomeSchema = z.strictObject({
  analysis: aiAnalysisSchema,
  proposal: z
    .strictObject({ subject: z.string().max(200), body: z.string().min(1).max(1600) })
    .nullable(),
  reasoning: z.string().max(700),
  grounding: z
    .strictObject({
      knowledgeVersion: z.int().positive(),
      inquiryAt: z.string(),
      knowledge: z
        .array(z.strictObject({ reference: aiKnowledgeRefSchema, text: z.string().max(600) }))
        .max(3),
      questions: z.array(z.string().max(160)).max(8),
      conversationIds: z.array(z.uuid()).max(6),
    })
    .optional(),
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
  prompt_version: z.enum(['lead-assist-v1', aiPromptVersion]),
  analysis_version: z.union([z.literal(1), z.literal(2)]),
  attempts: z.int().nonnegative(),
  code: z.string().max(60).nullable(),
  result: aiOutcomeSchema.nullable(),
  message_id: z.uuid().nullable(),
  recommendation_conversation_id: z.uuid().nullable().optional(),
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

export const conversationEvaluationInput = z.strictObject({
  conversationId: z.uuid(),
  sourceVersion: z.string().regex(/^[a-f0-9]{64}$/),
});
export const recommendationDecisionInput = z.strictObject({
  version: z.int().positive(),
  decision: z.enum(['accept', 'dismiss', 'defer', 'prepare']),
});
export const conversationRecommendationSchema = z.strictObject({
  id: z.uuid(),
  conversation_id: z.uuid(),
  contact_id: z.uuid(),
  lead_id: z.uuid(),
  trigger_message_id: z.uuid(),
  ai_run_id: z.uuid(),
  source_version: z.string().regex(/^[a-f0-9]{64}$/),
  knowledge_version: z.int().positive(),
  contract_version: z.literal(1),
  kind: z
    .enum(['ASK_FOR_INFORMATION', 'PREPARE_FOLLOW_UP', 'HUMAN_ATTENTION', 'NO_ACTION'])
    .nullable(),
  state: z.enum([
    'evaluating',
    'pending_review',
    'accepted',
    'dismissed',
    'deferred',
    'stale',
    'failed',
  ]),
  version: z.int().positive(),
  message_id: z.uuid().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  reviewed_by: z.uuid().nullable(),
  reviewed_at: z.string().nullable(),
  decision: z.enum(['accept', 'dismiss', 'defer', 'prepare']).nullable(),
  stale: z.boolean(),
  evaluation: aiRunSchema,
});
export const conversationRecommendationsSchema = z.strictObject({
  eligible: z.boolean(),
  reason: z.enum(['LEAD_UNAVAILABLE', 'NO_ATTRIBUTED_REPLY', 'RECENT_CONTEXT_REQUIRED']).nullable(),
  sourceVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  items: z.array(conversationRecommendationSchema).max(20),
  next: z.string().nullable(),
});
export type ConversationRecommendation = z.infer<typeof conversationRecommendationSchema>;
