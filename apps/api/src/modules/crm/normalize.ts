import {
  parsePhoneNumberFromString,
  isSupportedCountry,
  type CountryCode,
} from 'libphonenumber-js/max';
import type { ContactInput } from '@leadops/shared';
import { IdentityFailure } from '../identity/failure.js';

export function normalizeContact(input: ContactInput) {
  const emails = input.emails.map((value) => ({
    value: value.trim(),
    normalized: value.trim().toLowerCase(),
  }));
  const phones = input.phones.map(({ value, region }) => {
    if (region && !isSupportedCountry(region))
      throw new IdentityFailure(422, 'INVALID_PHONE_REGION');
    const parsed =
      value.startsWith('+') || region
        ? parsePhoneNumberFromString(value, {
            ...(region ? { defaultCountry: region as CountryCode } : {}),
            extract: false,
          })
        : undefined;
    if ((value.startsWith('+') || region) && (!parsed?.isValid() || parsed.ext))
      throw new IdentityFailure(422, 'INVALID_PHONE');
    return { value, normalized: parsed?.number ?? null, region: region ?? null };
  });
  if (
    new Set(emails.map((entry) => entry.normalized)).size !== emails.length ||
    new Set(phones.map((entry) => entry.normalized ?? entry.value)).size !== phones.length
  )
    throw new IdentityFailure(422, 'DUPLICATE_CHANNEL');
  return { ...input, emails, phones };
}
