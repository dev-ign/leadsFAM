import type { AutomationDatabase } from '@leadops/database';
import { aiClaimSchema, aiEnvelopeSchema, aiOutcomeSchema } from '@leadops/shared';
import {
  AiFailure,
  openAiProvider,
  questionText,
  simulationProvider,
  validateGroundedOutput,
  type AiConfig,
  type AiProvider,
  type Usage,
} from './provider.js';

export async function processAi(
  db: AutomationDatabase,
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
  const envelope = aiEnvelopeSchema.parse(prepared);
  const started = Date.now();
  let usage: Usage = {},
    code: string | null = null;
  let result: ReturnType<typeof aiOutcomeSchema.parse> | null = null;
  const signal = stop
    ? AbortSignal.any([stop, AbortSignal.timeout(config.deadlineMs ?? 8000)])
    : AbortSignal.timeout(config.deadlineMs ?? 8000);
  let aborted: (() => void) | undefined;
  try {
    if (signal.aborted) throw new AiFailure('CANCELLED_UNCERTAIN');
    if (Buffer.byteLength(JSON.stringify(envelope.source)) > (config.maxInputBytes ?? 10000))
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
        envelope.task === 'analysis' ? { ...envelope.source, contactName: '' } : envelope.source,
        signal,
      ),
      failure,
    ]);
    usage = answer.usage;
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
      const handoff = envelope.kind === 'handoff' || a.nextAction === 'human_review';
      const service = envelope.source.business.services.find(
        (s) => s.toLowerCase() === a.service?.quote.toLowerCase(),
      );
      const questions = handoff
        ? []
        : output.plan.questions
            .slice(0, envelope.channel === 'sms' ? 2 : 3)
            .map((q) => questionText[q]);
      const body = [
        greeting,
        thanks,
        ...(service ? [`Regarding your inquiry about ${service}:`] : []),
        handoff
          ? 'Your inquiry needs a team review before we can recommend the next step.'
          : envelope.kind === 'acknowledgment'
            ? 'We have received your inquiry for review.'
            : 'To help our team review your inquiry:',
        ...questions,
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
    result = aiOutcomeSchema.parse({ analysis: a, proposal, reasoning });
  } catch (error) {
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
  await db.finishAi(claim.id, claim.token, claim.generation, {
    result,
    code,
    retryable: code === 'RATE_LIMITED',
    durationMs: Math.min(60000, Date.now() - started),
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    estimatedCostMicrousd: estimate,
    pricingVersion: estimate === null ? null : (config.pricingVersion ?? null),
  });
}
