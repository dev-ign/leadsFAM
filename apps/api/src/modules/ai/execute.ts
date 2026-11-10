import type { AutomationDatabase } from '@leadops/database';
import { aiClaimSchema, aiEnvelopeSchema, aiOutcomeSchema } from '@leadops/shared';
import {
  AiFailure,
  openAiProvider,
  questionText,
  knowledgeText,
  simulationProvider,
  validateGroundedOutput,
  type AiConfig,
  type AiProvider,
  type Usage,
} from './provider.js';

export async function processAi(
  db: Pick<AutomationDatabase, 'prepareAi' | 'finishAi'>,
  claimInput: unknown,
  config: AiConfig,
  stop?: AbortSignal,
  override?: AiProvider,
) {
  const claim = aiClaimSchema.parse(claimInput);
  const prepared = await db.prepareAi(
    claim.id,
    claim.token,
    claim.generation,
    config.model ?? 'unconfigured',
  );
  if (prepared === null) return;
  const started = Date.now();
  let usage: Usage = {},
    code: string | null = null;
  let providerModel: string | null = null;
  let result: ReturnType<typeof aiOutcomeSchema.parse> | null;
  const signal = stop
    ? AbortSignal.any([stop, AbortSignal.timeout(config.deadlineMs ?? 15000)])
    : AbortSignal.timeout(config.deadlineMs ?? 15000);
  let aborted: (() => void) | undefined;
  try {
    const envelope = aiEnvelopeSchema.parse(prepared);
    if (signal.aborted) throw new AiFailure('CANCELLED_UNCERTAIN');
    if (Buffer.byteLength(JSON.stringify(envelope.source)) > (config.maxInputBytes ?? 24000))
      throw new AiFailure('INPUT_LIMIT');
    const provider =
      override ??
      (envelope.provider === 'simulation' ? simulationProvider : openAiProvider(config));
    const failure = new Promise<never>((_, reject) => {
      aborted = () =>
        reject(new AiFailure(stop?.aborted ? 'CANCELLED_UNCERTAIN' : 'TIMEOUT_UNCERTAIN'));
      signal.addEventListener('abort', aborted, { once: true });
    });
    const answer = await Promise.race([
      provider.execute(
        {
          ...envelope.source,
          contactName: envelope.task === 'analysis' ? '' : envelope.source.contactName,
          request: { task: envelope.task, channel: envelope.channel, kind: envelope.kind },
        },
        signal,
      ),
      failure,
    ]);
    usage = answer.usage;
    providerModel = answer.model ?? null;
    const output = validateGroundedOutput(answer.output, envelope.source);
    const a = output.analysis;
    const reasoning =
      a.nextAction === 'human_review'
        ? 'Human review is recommended. Customer text is untrusted and cannot authorize actions. No customer facts or permissions have been verified.'
        : `This is an unverified recommendation based on quoted lead fields. ${a.missing.length ? `Information to confirm: ${a.missing.map((q) => q.replaceAll('_', ' ')).join(', ')}.` : 'A team member should confirm the extracted details before acting.'}`;
    let proposal = null;
    if (envelope.task === 'draft') {
      const firstName = envelope.source.contactName
        .replace(/[^\p{L}\p{N} .'-]/gu, '')
        .split(' ')[0]
        ?.slice(0, 30);
      const formal = envelope.source.business.tone === 'formal';
      const greeting = firstName ? `${formal ? 'Hello' : 'Hi'} ${firstName},` : 'Hello,';
      const thanks = `Thank you for contacting${envelope.source.business.name ? ` ${envelope.source.business.name}` : ' our team'}.`;
      const handoff =
        envelope.kind === 'handoff' ||
        a.status === 'requires_manual_review' ||
        a.conflictingInformation ||
        a.serviceFit === 'unsupported' ||
        a.areaFit === 'unsupported';
      const service =
        a.serviceFit === 'supported' && a.approvedService !== null
          ? envelope.source.business.services[a.approvedService]
          : undefined;
      const questions = handoff
        ? []
        : output.plan.questions
            .filter((q) => q !== 'scope' || output.plan.businessQuestions.length === 0)
            .slice(0, envelope.channel === 'sms' ? 2 : 3)
            .map((q) => questionText[q]);
      const approvedFacts = handoff
        ? []
        : output.plan.knowledge.map((ref) => knowledgeText(envelope.source, ref));
      const businessQuestions = handoff
        ? []
        : output.plan.businessQuestions.map((index) => envelope.source.business.questions[index]!);
      // Compose only server wording and exact, validated approved facts/questions.
      // Customer excerpts and arbitrary provider prose never enter the customer message.
      const safeText = (text: string) =>
        !/https?:|www\.|[\w.+-]+@[\w.-]+|system prompt|ignore.{0,40}instruction/i.test(text);
      if (![envelope.source.business.name, service ?? '', ...businessQuestions].every(safeText))
        throw new AiFailure('INVALID_OUTPUT');
      const body = [
        greeting,
        thanks,
        ...(service ? [`About your ${service.toLowerCase()} request:`] : []),
        ...approvedFacts.slice(0, envelope.channel === 'sms' ? 1 : 3),
        handoff
          ? 'Your inquiry needs a team review before we can recommend the next step.'
          : envelope.kind === 'acknowledgment'
            ? 'We have received your inquiry for review.'
            : 'To help our team review your inquiry:',
        ...[...businessQuestions, ...questions].slice(0, envelope.channel === 'sms' ? 2 : 3),
        'Thank you.',
      ].join(envelope.channel === 'sms' ? ' ' : '\n\n');
      proposal = {
        subject:
          envelope.channel === 'email'
            ? envelope.kind === 'handoff'
              ? 'Your inquiry: team review'
              : 'A few details about your inquiry'
            : '',
        body,
      };
    }
    result = aiOutcomeSchema.parse({
      analysis: a,
      proposal,
      reasoning,
      grounding: {
        knowledgeVersion: envelope.source.knowledgeVersion,
        inquiryAt: envelope.source.inquiryAt,
        knowledge: output.plan.knowledge.map((reference) => ({
          reference,
          text: knowledgeText(envelope.source, reference),
        })),
        questions: a.requiredAnswers
          .filter((r) => r.evidence === null)
          .map((r) => envelope.source.business.knowledge.requiredInformation[r.index]!),
        conversationIds: envelope.source.conversation.map((m) => m.id),
      },
    });
  } catch (error) {
    result = null;
    if (error instanceof AiFailure) {
      code = error.code;
      usage = { ...usage, ...error.usage };
    } else code = 'INVALID_OUTPUT';
  } finally {
    if (aborted) signal.removeEventListener('abort', aborted);
  }
  const estimate =
    usage.inputTokens !== undefined &&
    usage.outputTokens !== undefined &&
    config.inputRate !== undefined &&
    config.outputRate !== undefined
      ? Math.ceil(usage.inputTokens * config.inputRate + usage.outputTokens * config.outputRate)
      : null;
  const completion = {
    result,
    code,
    retryable: code === 'RATE_LIMITED',
    durationMs: Math.min(60000, Date.now() - started),
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    estimatedCostMicrousd: estimate,
    pricingVersion: estimate === null ? null : (config.pricingVersion ?? null),
    providerModel,
  };
  try {
    await db.finishAi(claim.id, claim.token, claim.generation, completion);
  } catch (error) {
    if (error instanceof Error && error.message === 'lease_lost') throw error;
    // One recovery attempt, with the original fence and supplied metadata.
    // Never repeat inference or retry the result that failed persistence.
    try {
      await db.finishAi(claim.id, claim.token, claim.generation, {
        ...completion,
        result: null,
        code: code ?? 'INVALID_OUTPUT',
      });
    } catch (recoveryError) {
      // An uncertain first commit may already have consumed this fence. A
      // competing completion/recovery must not be overwritten or finalized twice.
      if (!(recoveryError instanceof Error && recoveryError.message === 'lease_lost'))
        throw recoveryError;
    }
  }
}
