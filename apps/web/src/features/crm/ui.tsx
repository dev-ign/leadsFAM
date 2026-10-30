import { Link } from 'react-router';
import { Button } from '@leadops/ui';
import type { ContactInput } from '@leadops/shared';
import { crmMessage } from './errors';
export function CrmFailure({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="space-y-3 rounded-xl border border-border p-5">
      <p>{crmMessage(error)}</p>
      <Button variant="outline" onClick={retry}>
        Try again
      </Button>
      <Link className="ml-4 underline" to="/">
        Choose a workspace
      </Link>
    </div>
  );
}
export function ContactFields({
  value,
  onChange,
  disabled = false,
}: {
  value: ContactInput;
  onChange: (value: ContactInput) => void;
  disabled?: boolean;
}) {
  const text = (
    key: 'displayName' | 'firstName' | 'lastName' | 'companyName',
    label: string,
    required = false,
    maxLength = 80,
  ) => (
    <label className="block text-sm">
      {label}
      <input
        className="field"
        value={value[key]}
        required={required}
        maxLength={maxLength}
        onChange={(e) => onChange({ ...value, [key]: e.currentTarget.value })}
      />
    </label>
  );
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <legend className="mb-4 text-lg font-medium">Contact details</legend>
      <label className="block text-sm">
        Contact type
        <select
          className="field"
          value={value.kind}
          onChange={(e) =>
            onChange({ ...value, kind: e.currentTarget.value as 'person' | 'company' })
          }
        >
          <option value="person">Person</option>
          <option value="company">Company</option>
        </select>
      </label>
      {text('displayName', 'Display name', true, 160)}
      <div className="grid gap-4 sm:grid-cols-2">
        {text('firstName', 'First name')}
        {text('lastName', 'Last name')}
      </div>
      {text('companyName', 'Company name', value.kind === 'company', 160)}
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <label className="block text-sm" key={i}>
            Email {i + 1}
            {i === 0 ? ' · primary' : ''}
            <input
              className="field"
              type="email"
              maxLength={254}
              value={value.emails[i] ?? ''}
              onChange={(e) => {
                const emails = [...value.emails];
                emails[i] = e.currentTarget.value;
                onChange({ ...value, emails });
              }}
            />
          </label>
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]" key={i}>
          <label className="block text-sm">
            Phone {i + 1}
            {i === 0 ? ' · primary' : ''}
            <input
              className="field"
              type="tel"
              maxLength={40}
              value={value.phones[i]?.value ?? ''}
              onChange={(e) => {
                const phones = [...value.phones];
                phones[i] = { ...phones[i], value: e.currentTarget.value };
                onChange({ ...value, phones });
              }}
            />
          </label>
          <label className="block text-sm">
            Country code {i + 1}
            <input
              className="field"
              placeholder="e.g. US"
              maxLength={2}
              value={value.phones[i]?.region ?? ''}
              onChange={(e) => {
                const phones = [...value.phones],
                  region = e.currentTarget.value.toUpperCase();
                phones[i] = { value: phones[i]?.value ?? '', ...(region ? { region } : {}) };
                onChange({ ...value, phones });
              }}
            />
          </label>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Use an international + prefix or an explicit country code to match phone numbers. A blank
        country leaves a local number unmatched.
      </p>
    </fieldset>
  );
}
