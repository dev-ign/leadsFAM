import { leadIntakeSchema, type LeadIntake } from '@leadops/shared';
import { normalizeContact } from './normalize.js';

export function normalizeIntake(input: LeadIntake) {
  const attribution = { ...input.attribution };
  if (attribution.landingUrl) {
    const url = new URL(attribution.landingUrl);
    attribution.landingUrl = `${url.origin}${url.pathname}`;
  }
  return {
    ...input,
    contact:
      input.contact.mode === 'create'
        ? { mode: 'create', data: normalizeContact(input.contact.data) }
        : input.contact,
    attribution,
  };
}
// Invalid rows still get an immutable attempt fingerprint that includes the
// original input. They cannot be accidentally accepted by skipping normalization.
export function importIntake(input: unknown) {
  const result = leadIntakeSchema.safeParse(input);
  if (!result.success) return { invalidInput: input };
  try {
    return normalizeIntake(result.data);
  } catch {
    return { invalidInput: input };
  }
}
