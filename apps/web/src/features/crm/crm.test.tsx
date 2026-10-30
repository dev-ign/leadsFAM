import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, createRoutesFromElements, RouterProvider } from 'react-router';
import type { Contact, Lead } from '@leadops/shared';
import { AppRoutes } from '../../app/app';
import { apiClient, ApiClientError } from '../../lib/api-client';
const orgA = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Synthetic team A',
    role: 'owner' as const,
  },
  orgB = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Synthetic team B',
    role: 'owner' as const,
  };
const userA = '33333333-3333-4333-8333-333333333333',
  userB = '44444444-4444-4444-8444-444444444444';
const session = (user = userA) => ({
  csrfToken: 'c'.repeat(43),
  purpose: 'application' as const,
  user: { id: user, email: 'synthetic@example.test' },
  onboardingEnabled: true,
});
const contact = (name = 'Synthetic saved contact'): Contact => ({
  id: '55555555-5555-4555-8555-555555555555',
  organization_id: orgA.id,
  kind: 'person',
  display_name: name,
  first_name: '',
  last_name: '',
  company_name: '',
  version: 1,
  archived_at: null,
  created_by: userA,
  created_at: '2026-10-30T00:00:00Z',
  updated_at: '2026-10-30T00:00:00Z',
  emails: [],
  phones: [],
  first_touch: null,
});
const lead = (): Lead => ({
  ...contact(),
  id: '66666666-6666-4666-8666-666666666666',
  contact_id: contact().id,
  title: 'Synthetic inquiry',
  description: '',
  priority: 'normal',
  status: 'new',
  outcome: null,
  closed_at: null,
  last_assigned_user_id: null,
  assigned_membership_generation: null,
  current_assignee_id: null,
  last_activity_at: '2026-10-30T00:00:00Z',
  contact: contact(),
  attribution: null,
});
class Channel {
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  static instances: Channel[] = [];
  constructor() {
    Channel.instances.push(this);
  }
  postMessage = vi.fn();
  close = vi.fn();
}
const routers: ReturnType<typeof createMemoryRouter>[] = [];
beforeEach(() => {
  Channel.instances = [];
  vi.stubGlobal('BroadcastChannel', Channel);
  vi.spyOn(apiClient, 'getSession').mockResolvedValue(session());
  vi.spyOn(apiClient, 'organizations').mockResolvedValue([orgA, orgB]);
  vi.spyOn(apiClient, 'organization').mockImplementation(async (id) =>
    id === orgA.id ? orgA : orgB,
  );
  vi.spyOn(apiClient, 'notes').mockResolvedValue([]);
  vi.spyOn(apiClient, 'getHealth').mockResolvedValue({ status: 'ok', service: 'leadops-api' });
  vi.spyOn(apiClient, 'leads').mockResolvedValue({ items: [], cursor: null });
  vi.spyOn(apiClient, 'contacts').mockResolvedValue({ items: [], cursor: null });
  vi.spyOn(apiClient, 'sources').mockResolvedValue([]);
  vi.spyOn(apiClient, 'members').mockResolvedValue([]);
  vi.spyOn(apiClient, 'activity').mockResolvedValue({ items: [], cursor: null });
  vi.spyOn(apiClient, 'contact').mockResolvedValue(contact());
  vi.spyOn(apiClient, 'lead').mockResolvedValue(lead());
});

describe('CRM confirmed workflows', () => {
  it('submits server filters, follows cursors and rejects a late previous-query response', async () => {
    let finish!: (value: { items: Lead[]; cursor: string | null }) => void;
    vi.mocked(apiClient.leads)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce({ items: [lead()], cursor: 'signed-next' })
      .mockResolvedValue({ items: [{ ...lead(), title: 'Next result' }], cursor: null });
    app(`/organizations/${orgA.id}/leads`);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Search leads' }), 'Inquiry');
    await userEvent.click(screen.getByRole('button', { name: /^Search$/ }));
    expect(await screen.findByRole('link', { name: 'Synthetic inquiry' })).toBeInTheDocument();
    await act(async () =>
      finish({ items: [{ ...lead(), title: 'Stale private result' }], cursor: null }),
    );
    expect(screen.queryByText('Stale private result')).not.toBeInTheDocument();
    expect(vi.mocked(apiClient.leads).mock.calls.at(-1)?.[1]).toMatchObject({ q: 'Inquiry' });
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByRole('link', { name: 'Next result' })).toBeInTheDocument();
    expect(vi.mocked(apiClient.leads).mock.calls.at(-1)?.[1]).toMatchObject({
      cursor: 'signed-next',
      q: 'Inquiry',
    });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'qualified');
    await waitFor(() =>
      expect(vi.mocked(apiClient.leads).mock.calls.at(-1)?.[1]).toMatchObject({
        status: 'qualified',
        cursor: undefined,
      }),
    );
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });
  it('shows a retryable failure and an explicit empty state', async () => {
    vi.mocked(apiClient.leads)
      .mockRejectedValueOnce(new ApiClientError('network'))
      .mockResolvedValue({ items: [], cursor: null });
    app(`/organizations/${orgA.id}/leads`);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'No leads match this view.' }),
    ).toBeInTheDocument();
  });
  it('keeps the original edit version after revalidation and presents stale-write conflicts', async () => {
    vi.spyOn(apiClient, 'updateLead').mockRejectedValue(
      new ApiClientError('http', 409, 'VERSION_CONFLICT'),
    );
    app(`/organizations/${orgA.id}/leads/${lead().id}/edit`);
    const field = await screen.findByRole('textbox', { name: 'Lead title' });
    await waitFor(() => expect(field).toBeEnabled());
    await userEvent.clear(field);
    await userEvent.type(field, 'My unsaved edit');
    vi.mocked(apiClient.lead).mockResolvedValue({
      ...lead(),
      title: 'Someone else saved',
      version: 2,
    });
    await broadcast();
    expect(await screen.findByRole('textbox', { name: 'Lead title' })).toHaveValue(
      'My unsaved edit',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save lead' }));
    await waitFor(() =>
      expect(apiClient.updateLead).toHaveBeenCalledWith(
        orgA.id,
        lead().id,
        1,
        expect.objectContaining({ title: 'My unsaved edit' }),
      ),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed|refresh/i);
  });
  it('submits a status change through the visible button and hides privileged actions from members', async () => {
    vi.spyOn(apiClient, 'transitionLead').mockResolvedValue({
      ...lead(),
      status: 'qualified',
      version: 2,
    });
    vi.mocked(apiClient.organizations).mockResolvedValue([{ ...orgA, role: 'member' }]);
    vi.mocked(apiClient.organization).mockResolvedValue({ ...orgA, role: 'member' });
    app(`/organizations/${orgA.id}/leads/${lead().id}`);
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Move lead to' }),
      'qualified',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save status' }));
    await waitFor(() =>
      expect(apiClient.transitionLead).toHaveBeenCalledWith(orgA.id, lead().id, {
        version: 1,
        status: 'qualified',
      }),
    );
    expect(screen.queryByRole('button', { name: 'Archive lead' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update assignment' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim lead' })).toBeInTheDocument();
  });
  it('adds a source with the visible submit button', async () => {
    vi.spyOn(apiClient, 'createSource').mockResolvedValue({
      ...contact(),
      name: 'Synthetic referral',
    });
    app(`/organizations/${orgA.id}/sources`);
    const field = await screen.findByRole('textbox', { name: 'New source name' });
    await waitFor(() => expect(field).toBeEnabled());
    await userEvent.type(field, 'Synthetic referral');
    await userEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() =>
      expect(apiClient.createSource).toHaveBeenCalledWith(orgA.id, {
        name: 'Synthetic referral',
        archived: false,
      }),
    );
  });
});
afterEach(() => {
  for (const router of routers.splice(0)) router.dispose();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
function app(path = `/organizations/${orgA.id}/contacts/new`) {
  const router = createMemoryRouter(createRoutesFromElements(AppRoutes()), {
    initialEntries: [path],
  });
  routers.push(router);
  render(<RouterProvider router={router} />);
  return router;
}
async function nameField() {
  const input = await screen.findByRole('textbox', { name: 'Display name' });
  await waitFor(() => expect(input).toBeEnabled());
  return input;
}
async function broadcast() {
  await act(async () => {
    Channel.instances.at(-1)?.onmessage?.(new MessageEvent('message', { data: 'changed' }));
  });
}
describe('scoped drafts and CRM navigation', () => {
  it('warns on navigation and refresh, supports staying, and discards explicitly', async () => {
    app();
    await userEvent.type(await nameField(), 'Private draft name');
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(
      'Private draft name',
    );
    await userEvent.click(screen.getAllByRole('link', { name: 'Leads' })[0]!);
    expect(
      await screen.findByRole('dialog', { name: 'Discard unsaved changes?' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(await nameField()).toHaveValue('Private draft name');
    await userEvent.click(screen.getAllByRole('link', { name: 'Leads' })[0]!);
    await userEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByRole('heading', { name: 'Leads', level: 2 })).toBeInTheDocument();
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
  });
  it('preserves contact fields on same-identity focus and cross-tab revalidation', async () => {
    app();
    await userEvent.type(await nameField(), 'Same identity draft');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Email 1 · primary' }),
      'private@example.test',
    );
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(await nameField()).toHaveValue('Same identity draft');
    await broadcast();
    expect(await nameField()).toHaveValue('Same identity draft');
    expect(screen.getByRole('textbox', { name: 'Email 1 · primary' })).toHaveValue(
      'private@example.test',
    );
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(
      /Same identity|private@example/,
    );
  });
  it('discards on cross-tab sign-out and never restores a prior user’s form', async () => {
    const router = app();
    await userEvent.type(await nameField(), 'Old user private draft');
    vi.mocked(apiClient.getSession).mockResolvedValue({
      csrfToken: 'd'.repeat(43),
      purpose: 'anonymous',
      user: null,
      onboardingEnabled: true,
    });
    await broadcast();
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    vi.mocked(apiClient.getSession).mockResolvedValue(session(userB));
    await broadcast();
    await act(async () => {
      await router.navigate(`/organizations/${orgA.id}/contacts/new`);
    });
    expect(await nameField()).toHaveValue('');
    expect(screen.queryByDisplayValue('Old user private draft')).not.toBeInTheDocument();
  });
  it('discards on revocation and role changes instead of resurfacing privileged drafts', async () => {
    const router = app();
    await userEvent.type(await nameField(), 'Revoked private draft');
    vi.mocked(apiClient.organizations).mockResolvedValue([orgB]);
    vi.mocked(apiClient.organization).mockRejectedValue(new ApiClientError('http', 404));
    await broadcast();
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
    expect(screen.queryByDisplayValue('Revoked private draft')).not.toBeInTheDocument();
    vi.mocked(apiClient.organizations).mockResolvedValue([orgA, orgB]);
    vi.mocked(apiClient.organization).mockResolvedValue(orgA);
    await broadcast();
    await act(async () => {
      await router.navigate(`/organizations/${orgA.id}/contacts/new`);
    });
    expect(await nameField()).toHaveValue('');
    await userEvent.type(await nameField(), 'Before role change');
    vi.mocked(apiClient.organizations).mockResolvedValue([{ ...orgA, role: 'member' }, orgB]);
    vi.mocked(apiClient.organization).mockResolvedValue({ ...orgA, role: 'member' });
    await broadcast();
    expect(await nameField()).toHaveValue('');
  });
  it('isolates workspace switches and ignores an old save callback', async () => {
    let finish!: (value: Contact) => void;
    vi.spyOn(apiClient, 'createContact').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    app();
    await userEvent.type(await nameField(), 'Pending team A');
    await userEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    await waitFor(() => expect(apiClient.createContact).toHaveBeenCalled());
    await userEvent.selectOptions(
      screen.getAllByRole('combobox', { name: 'Switch workspace' })[0]!,
      orgB.id,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    expect(await screen.findByRole('heading', { name: orgB.name })).toBeInTheDocument();
    await act(async () => finish(contact('Old request completed')));
    expect(screen.getByRole('heading', { name: orgB.name })).toBeInTheDocument();
    expect(screen.queryByText('Old request completed')).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('link', { name: 'Contacts' })[0]!);
    await userEvent.click(await screen.findByRole('link', { name: 'New contact' }));
    expect(await nameField()).toHaveValue('');
  });
  it('requires explicit discard before sign-out takes effect', async () => {
    vi.spyOn(apiClient, 'signOut').mockImplementation(async () => {
      vi.mocked(apiClient.getSession).mockResolvedValue({
        csrfToken: 'x'.repeat(43),
        purpose: 'anonymous',
        user: null,
        onboardingEnabled: true,
      });
      return { ok: true };
    });
    app();
    await userEvent.type(await nameField(), 'Sign out draft');
    await userEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]!);
    expect(apiClient.signOut).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(await nameField()).toHaveValue('Sign out draft');
    await userEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0]!);
    await userEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(apiClient.signOut).toHaveBeenCalledOnce());
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
  });
  it('freezes an uncertain create and retries with the original payload and key', async () => {
    vi.spyOn(apiClient, 'createContact')
      .mockRejectedValueOnce(new ApiClientError('network'))
      .mockResolvedValueOnce(contact('Saved after retry'));
    app();
    await userEvent.type(await nameField(), 'Retry proof');
    await userEvent.click(screen.getByRole('button', { name: 'Save contact' }));
    await screen.findByRole('button', { name: 'Retry save' });
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(apiClient.createContact).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(apiClient.createContact).mock.calls;
    expect(first?.[1]).toEqual(second?.[1]);
    expect(first?.[2]).toBe(second?.[2]);
    expect(
      await screen.findByRole('heading', { name: 'Synthetic saved contact', level: 2 }),
    ).toBeInTheDocument();
  });
});
