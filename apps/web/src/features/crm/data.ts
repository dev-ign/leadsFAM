import { contactInputSchema, type Contact, type ContactInput } from '@leadops/shared';
export const blankContact: ContactInput = {
  kind: 'person',
  displayName: '',
  firstName: '',
  lastName: '',
  companyName: '',
  emails: [],
  phones: [],
};
export function cleanContact(value: ContactInput) {
  return contactInputSchema.parse({
    ...value,
    emails: value.emails.filter((v) => v.trim()),
    phones: value.phones.filter((v) => v?.value.trim()),
  });
}
export function editableContact(contact: Contact): ContactInput {
  return {
    kind: contact.kind,
    displayName: contact.display_name,
    firstName: contact.first_name,
    lastName: contact.last_name,
    companyName: contact.company_name,
    emails: contact.emails.map((v) => v.value),
    phones: contact.phones.map((v) => ({
      value: v.value,
      ...(v.region ? { region: v.region } : {}),
    })),
  };
}
