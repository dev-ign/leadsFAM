import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, createRoutesFromElements, RouterProvider } from 'react-router';
import {
  aiSettingsSchema,
  type Contact,
  type Lead,
  type AutomationOverview,
  type Workflow,
} from '@leadops/shared';
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
  vi.spyOn(apiClient, 'automations').mockResolvedValue({
    integrations: [],
    workflows: [],
    receipts: [],
    attempts: [],
    jobs: [],
    runs: [],
    queue: { pending: 0, failed: 0, oldestPendingAt: null },
  });
  vi.spyOn(apiClient, 'members').mockResolvedValue([]);
  vi.spyOn(apiClient, 'activity').mockResolvedValue({ items: [], cursor: null });
  vi.spyOn(apiClient, 'contact').mockResolvedValue(contact());
  vi.spyOn(apiClient, 'lead').mockResolvedValue(lead());
});

describe('CRM confirmed workflows', () => {
  it('edits approved business knowledge through plain forms and saves the versioned settings', async () => {
    vi.spyOn(apiClient, 'aiSettings').mockResolvedValue(
      aiSettingsSchema.parse({
        enabled: false,
        provider: 'simulation',
        dailyLimit: 10,
        concurrentLimit: 1,
        version: 3,
        business: {
          name: 'FreshNest',
          description: '',
          services: ['Deep cleaning'],
          serviceAreas: ['Tampa'],
          tone: 'warm',
          questions: [],
          guidelines: '',
          restrictions: '',
          escalation: '',
        },
      }),
    );
    vi.spyOn(apiClient, 'aiHistory').mockResolvedValue({ items: [], next: null });
    const save = vi.spyOn(apiClient, 'saveAiSettings').mockResolvedValue({ ok: true });
    app(`/organizations/${orgA.id}/agents`);
    await userEvent.type(
      await screen.findByLabelText('Approved pricing or estimate policy'),
      'Request an estimate after property review.',
    );
    await userEvent.type(
      screen.getByLabelText('Information required to qualify (one per line)'),
      'Bathrooms\nFurnished or empty',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add approved question and answer' }));
    await userEvent.type(
      screen.getByLabelText('Customer question 1'),
      'Do you provide move-out cleaning?',
    );
    await userEvent.type(screen.getByLabelText('Approved answer 1'), 'Please request an estimate.');
    await userEvent.click(screen.getByRole('button', { name: 'Save AI settings' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        orgA.id,
        3,
        expect.objectContaining({
          business: expect.objectContaining({
            knowledge: expect.objectContaining({
              pricing: 'Request an estimate after property review.',
              requiredInformation: ['Bathrooms', 'Furnished or empty'],
              faqs: [
                {
                  question: 'Do you provide move-out cleaning?',
                  answer: 'Please request an estimate.',
                },
              ],
            }),
          }),
        }),
      ),
    );
  });

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
    const field = await nameField();
    await userEvent.type(field, 'Same identity draft');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Email 1 · primary' }),
      'private@example.test',
    );
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(await nameField()).toHaveValue('Same identity draft');
    await broadcast();
    expect(await nameField()).toBe(field);
    expect(await nameField()).toHaveValue('Same identity draft');
    expect(screen.getByRole('textbox', { name: 'Email 1 · primary' })).toHaveValue(
      'private@example.test',
    );
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toMatch(
      /Same identity|private@example/,
    );
  });
  it('keeps the sign-in form mounted during a stale focus check and throttles fresh checks', async () => {
    const anonymous = { ...session(), purpose: 'anonymous' as const, user: null };
    vi.mocked(apiClient.getSession).mockResolvedValue(anonymous);
    const router = app('/sign-in');
    const field = await screen.findByRole('textbox', { name: 'Email' });
    await userEvent.type(field, 'unsaved@example.test');
    const initialRequests = vi.mocked(apiClient.getSession).mock.calls.length;
    for (let i = 0; i < 10; i++) fireEvent(window, new Event('focus'));
    expect(apiClient.getSession).toHaveBeenCalledTimes(initialRequests);
    let finish!: (value: typeof anonymous) => void;
    vi.mocked(apiClient.getSession).mockReturnValueOnce(
      new Promise((resolve) => (finish = resolve)),
    );
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    await act(async () => {
      for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('focus'));
    });
    expect(apiClient.getSession).toHaveBeenCalledTimes(initialRequests + 1);
    expect(screen.queryByText('Checking your session…')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Email' })).toBe(field);
    await act(async () => finish(anonymous));
    expect(field).toHaveValue('unsaved@example.test');
    expect(screen.getByRole('textbox', { name: 'Email' })).toBe(field);
    expect(router.state.location.pathname).toBe('/sign-in');
  });
  it('preserves uncontrolled workspace input without refetching or remounting the page', async () => {
    const router = app(`/organizations/${orgA.id}`);
    const field = await screen.findByRole('textbox', { name: 'Title' });
    await userEvent.type(field, 'Unsaved workspace note');
    const requests = vi.mocked(apiClient.getSession).mock.calls.length;
    const workspaceRequests = vi.mocked(apiClient.organization).mock.calls.length;
    let finish!: (value: ReturnType<typeof session>) => void;
    vi.mocked(apiClient.getSession).mockReturnValueOnce(
      new Promise((resolve) => (finish = resolve)),
    );
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    await act(async () => {
      for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByRole('textbox', { name: 'Title' })).toBe(field);
    expect(apiClient.getSession).toHaveBeenCalledTimes(requests + 1);
    await act(async () => finish(session()));
    expect(screen.getByRole('textbox', { name: 'Title' })).toBe(field);
    expect(field).toHaveValue('Unsaved workspace note');
    expect(apiClient.organization).toHaveBeenCalledTimes(workspaceRequests);
    expect(apiClient.notes).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe(`/organizations/${orgA.id}`);
  });
  it.each(['session', 'memberships'])(
    'retains verified input through a transient %s failure and retry',
    async (operation) => {
      app(`/organizations/${orgA.id}`);
      const field = await screen.findByRole('textbox', { name: 'Title' });
      await userEvent.type(field, 'Keep during API restart');
      if (operation === 'session')
        vi.mocked(apiClient.getSession).mockRejectedValueOnce(new ApiClientError('network'));
      else
        vi.mocked(apiClient.organizations).mockRejectedValueOnce(new ApiClientError('http', 503));
      await broadcast();
      expect(await screen.findByRole('alert')).toHaveTextContent('could not recheck');
      expect(screen.getByRole('textbox', { name: 'Title' })).toBe(field);
      expect(field).toHaveValue('Keep during API restart');
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(screen.getByRole('textbox', { name: 'Title' })).toBe(field);
      expect(field).toHaveValue('Keep during API restart');
    },
  );
  it('blocks initial verification failure and hides old content when a different identity cannot load memberships', async () => {
    vi.mocked(apiClient.getSession).mockRejectedValueOnce(new ApiClientError('network'));
    app();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not verify');
    expect(screen.queryByRole('textbox', { name: 'Display name' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await userEvent.type(await nameField(), 'Previous identity private work');
    vi.mocked(apiClient.getSession).mockResolvedValue(session(userB));
    vi.mocked(apiClient.organizations).mockRejectedValueOnce(new ApiClientError('network'));
    await broadcast();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not verify');
    expect(screen.queryByDisplayValue('Previous identity private work')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await nameField()).toHaveValue('');
  });
  it('rejects confirmed expiry during a pending recheck and ignores its late success', async () => {
    app();
    await userEvent.type(await nameField(), 'Revoked session draft');
    let finish!: (value: ReturnType<typeof session>) => void;
    vi.mocked(apiClient.getSession).mockReturnValueOnce(
      new Promise((resolve) => (finish = resolve)),
    );
    await broadcast();
    await act(async () => window.dispatchEvent(new Event('leadsfam-session-expired')));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not verify');
    await act(async () => finish(session()));
    expect(screen.queryByRole('textbox', { name: 'Display name' })).not.toBeInTheDocument();
    vi.mocked(apiClient.getSession).mockResolvedValue({
      ...session(),
      purpose: 'anonymous',
      user: null,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Revoked session draft')).not.toBeInTheDocument();
  });
  it('does not treat a confirmed membership authorization denial as a transient outage', async () => {
    app();
    await userEvent.type(await nameField(), 'Previously authorized draft');
    vi.mocked(apiClient.organizations).mockRejectedValueOnce(new ApiClientError('http', 403));
    await broadcast();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not verify');
    expect(screen.queryByRole('textbox', { name: 'Display name' })).not.toBeInTheDocument();
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

describe('guided automation experience', () => {
  const definition = {
    schemaVersion: 1 as const,
    trigger: 'lead.created' as const,
    conditions: [],
    steps: [
      {
        id: 'record',
        tool: 'activities.create' as const,
        version: 1 as const,
        arguments: { message: 'Synthetic review' },
      },
    ],
  };
  const workflow: Workflow = {
    id: '77777777-7777-4777-8777-777777777777',
    organization_id: orgA.id,
    name: 'Review inquiries',
    status: 'draft',
    version: 1,
    published_version: null,
    created_by: userA,
    created_at: '2026-10-30T00:00:00Z',
    updated_at: '2026-10-30T00:00:00Z',
    definition,
  };
  const overview = (workflows: Workflow[] = []): AutomationOverview => ({
    integrations: [],
    workflows,
    receipts: [],
    attempts: [],
    jobs: [],
    runs: [],
    queue: { pending: 0, failed: 0, oldestPendingAt: null },
  });
  it.each(['activities.create', 'ai.analyze'] as const)(
    'reviews %s and saves a draft without activating it',
    async (tool) => {
      vi.spyOn(apiClient, 'saveWorkflow').mockResolvedValue(workflow);
      vi.spyOn(apiClient, 'changeWorkflow').mockResolvedValue(workflow);
      app(`/organizations/${orgA.id}/automations/new`);
      expect(
        await screen.findByRole('heading', { name: 'Create an automation' }),
      ).toBeInTheDocument();
      await userEvent.clear(screen.getByRole('textbox', { name: 'Automation name' }));
      await userEvent.type(
        screen.getByRole('textbox', { name: 'Automation name' }),
        'Review inquiries',
      );
      if (tool === 'ai.analyze') {
        await userEvent.clear(screen.getByRole('textbox', { name: 'Internal activity' }));
        await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Action' }), tool);
        expect(
          screen.queryByRole('textbox', { name: 'Internal activity' }),
        ).not.toBeInTheDocument();
        expect(screen.getByText(/queues a separate analysis for review/)).toBeInTheDocument();
      }
      await userEvent.click(screen.getByRole('button', { name: 'Review automation' }));
      expect(
        await screen.findByRole('heading', { name: 'Review your automation' }),
      ).toBeInTheDocument();
      expect(apiClient.saveWorkflow).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
      await waitFor(() => expect(apiClient.saveWorkflow).toHaveBeenCalledOnce());
      expect(vi.mocked(apiClient.saveWorkflow).mock.calls[0]?.[1].definition.steps[0]?.tool).toBe(
        tool,
      );
      expect(apiClient.changeWorkflow).not.toHaveBeenCalled();
      expect(
        await screen.findByRole('heading', { name: 'Automations', level: 2 }),
      ).toBeInTheDocument();
    },
  );
  it('requires reviewing the exact saved workflow before activation', async () => {
    vi.mocked(apiClient.automations).mockResolvedValue(overview([workflow]));
    vi.spyOn(apiClient, 'changeWorkflow').mockResolvedValue({
      ...workflow,
      status: 'active',
      version: 2,
      published_version: 2,
    });
    app(`/organizations/${orgA.id}/automations`);
    await userEvent.click(await screen.findByRole('button', { name: 'Review & activate' }));
    expect(apiClient.changeWorkflow).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Activate automation' }));
    await waitFor(() =>
      expect(apiClient.changeWorkflow).toHaveBeenCalledWith(orgA.id, workflow.id, 1, 'publish'),
    );
  });
  it('preserves unsupported advanced configuration and never offers an editable approximation', async () => {
    vi.mocked(apiClient.automations).mockResolvedValue(
      overview([{ ...workflow, definition: { ...definition, branches: [{ unfamiliar: true }] } }]),
    );
    vi.spyOn(apiClient, 'saveWorkflow').mockResolvedValue(workflow);
    app(`/organizations/${orgA.id}/automations/${workflow.id}/edit`);
    expect(
      await screen.findByText(/uses features the guided builder cannot edit/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Automation name' })).not.toBeInTheDocument();
    expect(apiClient.saveWorkflow).not.toHaveBeenCalled();
  });
  it('hides integration management and makes permission denial understandable', async () => {
    vi.mocked(apiClient.organization).mockResolvedValue({ ...orgA, role: 'member' });
    app(`/organizations/${orgA.id}/integrations`);
    expect(await screen.findByText(/owner or administrator can manage/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add integration' })).not.toBeInTheDocument();
    expect(apiClient.automations).not.toHaveBeenCalled();
  });
});

it('shows a newly created integration key only in the current workspace and confirms revocation', async () => {
  const integration = {
    id: '88888888-8888-4888-8888-888888888888',
    organization_id: orgA.id,
    type: 'first_party' as const,
    name: 'Synthetic backend',
    status: 'active' as const,
    source_id: null,
    expires_at: '2027-01-01T00:00:00Z',
    created_by: userA,
    authorized_by: userA,
    version: 1,
    created_at: '2026-10-30T00:00:00Z',
    updated_at: '2026-10-30T00:00:00Z',
  };
  const credential = 'lf_ing_' + 's'.repeat(43);
  vi.mocked(apiClient.automations).mockResolvedValue({
    integrations: [integration],
    workflows: [],
    receipts: [],
    attempts: [],
    jobs: [],
    runs: [],
    queue: { pending: 0, failed: 0, oldestPendingAt: null },
  });
  vi.spyOn(apiClient, 'createIntegration').mockResolvedValue({ integration, credential });
  vi.spyOn(apiClient, 'changeIntegration').mockResolvedValue({ integration });
  app(`/organizations/${orgA.id}/integrations`);
  await userEvent.click(await screen.findByRole('button', { name: 'Add integration' }));
  expect(await screen.findByRole('textbox', { name: 'Integration key' })).toHaveValue(credential);
  await userEvent.click(screen.getByRole('button', { name: 'I have saved the key' }));
  expect(screen.queryByDisplayValue(credential)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Revoke integration' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(apiClient.changeIntegration).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(apiClient.changeIntegration).not.toHaveBeenCalled();
});

it('activates the reviewed definition using its newly saved version', async () => {
  const definition = {
    schemaVersion: 1 as const,
    trigger: 'lead.created' as const,
    conditions: [],
    steps: [
      {
        id: 'record',
        tool: 'activities.create' as const,
        version: 1 as const,
        arguments: { message: 'Review this new inquiry and choose the next step.' },
      },
    ],
  };
  const saved: Workflow = {
    id: '99999999-9999-4999-8999-999999999999',
    organization_id: orgA.id,
    name: 'Review new inquiries',
    status: 'draft',
    version: 3,
    published_version: null,
    created_by: userA,
    created_at: '2026-10-30T00:00:00Z',
    updated_at: '2026-10-30T00:00:00Z',
    definition,
  };
  vi.spyOn(apiClient, 'saveWorkflow').mockResolvedValue(saved);
  vi.spyOn(apiClient, 'changeWorkflow').mockResolvedValue({ ...saved, status: 'active' });
  app(`/organizations/${orgA.id}/automations/new`);
  await userEvent.click(await screen.findByRole('button', { name: 'Review automation' }));
  expect(await screen.findByRole('heading', { name: 'Review your automation' })).toHaveFocus();
  expect(apiClient.saveWorkflow).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Activate automation' }));
  await waitFor(() =>
    expect(apiClient.changeWorkflow).toHaveBeenCalledWith(orgA.id, saved.id, 3, 'publish'),
  );
});

describe('communication approval and operational controls', () => {
  it('persists a draft, records explicit evidence, and sends only after reviewing the saved version', async () => {
    vi.mocked(apiClient.contact).mockResolvedValue({
      ...contact(),
      emails: [{ value: 'synthetic@example.test', normalized: 'synthetic@example.test' }],
    });
    let eligible = false;
    vi.spyOn(apiClient, 'communicationEligibility').mockImplementation(async () => ({
      code: eligible ? null : 'CONSENT_REQUIRED',
      permissions: [],
      suppressed: false,
    }));
    const permission = vi
      .spyOn(apiClient, 'recordCommunicationPermission')
      .mockImplementation(async () => {
        eligible = true;
        return { ok: true };
      });
    const saved = {
      id: '77777777-7777-4777-8777-777777777777',
      conversation_id: '88888888-8888-4888-8888-888888888888',
      contact_id: contact().id,
      lead_id: null,
      direction: 'outbound' as const,
      channel: 'email' as const,
      purpose: 'transactional' as const,
      sender: 'FreshNest <mock@example.test>',
      recipient: 'synthetic@example.test',
      subject: 'Synthetic appointment',
      body: 'Synthetic service details',
      state: 'draft' as const,
      version: 1,
      code: null,
      provider: 'mock' as const,
      provider_message_id: null,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
    };
    const save = vi
      .spyOn(apiClient, 'saveMessageDraft')
      .mockImplementation(async (_org, input) => ({ ...saved, id: input.id }));
    const send = vi
      .spyOn(apiClient, 'sendMessage')
      .mockResolvedValue({ ...saved, state: 'queued', version: 2 });
    app(`/organizations/${orgA.id}/communications/compose?contactId=${contact().id}`);
    await userEvent.type(await screen.findByRole('textbox', { name: 'Subject' }), saved.subject);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), saved.body);
    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const review = await screen.findByRole('heading', { name: 'Review saved message' });
    await waitFor(() => expect(review).toHaveFocus());
    expect(save).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Record permission evidence', { exact: true }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Consent source' }),
      'Synthetic service request',
    );
    fireEvent.change(screen.getByLabelText('Collected at (your local time)'), {
      target: { value: '2026-10-30T12:00' },
    });
    await userEvent.type(screen.getByRole('textbox', { name: 'Recipient country code' }), 'US');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Disclosure or policy version' }),
      'synthetic-v1',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Evidence reference' }),
      'fixture-only',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Record explicit permission' }));
    await waitFor(() => expect(permission).toHaveBeenCalledOnce());
    const approve = screen.getByRole('button', { name: 'Confirm and queue mock message' });
    expect(approve).toBeDisabled();
    await userEvent.click(
      screen.getByRole('checkbox', { name: /I reviewed this exact saved message/ }),
    );
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);
    expect(
      await screen.findByRole('heading', { name: 'Message queued for mock delivery' }),
    ).toBeInTheDocument();
    expect(send).toHaveBeenCalledWith(orgA.id, save.mock.calls[0]![1].id, 1);
  });
  it('submits the pause and budget form through the server API', async () => {
    vi.spyOn(apiClient, 'communicationSettings').mockResolvedValue({
      paused: true,
      dailyLimit: 100,
      recipientDailyLimit: 5,
      channelDailyLimit: 100,
      concurrentLimit: 2,
      requestsPerMinute: 30,
      maxAttempts: 3,
      mode: 'mock',
      liveEnabled: false,
      senderEmail: 'FreshNest <mock@example.test>',
      senderSms: '+15005550006',
      attentionCount: 0,
      queuedCount: 0,
    });
    const save = vi.spyOn(apiClient, 'saveCommunicationSettings').mockResolvedValue({ ok: true });
    app(`/organizations/${orgA.id}/communications/settings`);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Pause new submissions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save sending controls' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        orgA.id,
        expect.objectContaining({ paused: false, dailyLimit: 100 }),
      ),
    );
  });
});
