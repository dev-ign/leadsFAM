import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { apiClient } from '../lib/api-client';
import { App } from './app';

const orgId = '11111111-1111-4111-8111-111111111111';
const org = { id: orgId, name: 'Synthetic workspace A', role: 'owner' as const };
beforeEach(() => {
  vi.spyOn(apiClient, 'getSession').mockResolvedValue({
    csrfToken: 'c'.repeat(43),
    purpose: 'application',
    user: { id: orgId, email: 'synthetic@example.test' },
    onboardingEnabled: true,
  });
  vi.spyOn(apiClient, 'organizations').mockResolvedValue([org]);
  vi.spyOn(apiClient, 'organization').mockResolvedValue(org);
  vi.spyOn(apiClient, 'notes').mockResolvedValue([]);
});
function renderApp(path = `/organizations/${orgId}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}
describe('application shell', () => {
  it('shows an honest preview and live connectivity status', async () => {
    vi.spyOn(apiClient, 'getHealth').mockResolvedValue({ status: 'ok', service: 'leadops-api' });
    renderApp();
    expect(screen.getByRole('link', { name: 'LeadsFam home' })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'A clear starting point.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByRole('button', { name: /Lead setup coming later/ })).toBeDisabled();
    expect(await screen.findByText('API reachable')).toBeInTheDocument();
    expect(
      screen.getByText('No lead sources connected. No business data is displayed.'),
    ).toBeInTheDocument();
  });
  it('shows loading, recovers from failure, and supports retry', async () => {
    let fail!: (reason: Error) => void;
    vi.spyOn(apiClient, 'getHealth')
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      )
      .mockResolvedValue({ status: 'ok', service: 'leadops-api' });
    renderApp();
    expect(await screen.findByText(/Checking API connection/)).toBeInTheDocument();
    await act(async () => fail(new Error('sensitive provider text')));
    expect(await screen.findByRole('alert')).not.toHaveTextContent('sensitive');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('API reachable')).toBeInTheDocument();
  });
  it('navigates to status and explains security limits', async () => {
    vi.spyOn(apiClient, 'getHealth').mockResolvedValue({ status: 'ok', service: 'leadops-api' });
    renderApp();
    await screen.findByRole('heading', { name: 'A clear starting point.' });
    await userEvent.click(screen.getAllByRole('link', { name: 'Platform status' })[0]!);
    expect(screen.getByRole('heading', { name: 'Platform status', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Account sign-in, organization permissions/)).toBeInTheDocument();
    expect(await screen.findByText('API reachable')).toBeInTheDocument();
  });
  it('supports a persisted theme toggle', async () => {
    vi.spyOn(apiClient, 'getHealth').mockResolvedValue({ status: 'ok', service: 'leadops-api' });
    renderApp();
    await screen.findByRole('heading', { name: 'A clear starting point.' });
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('leadops-theme')).toBe('dark');
    expect(await screen.findByText('API reachable')).toBeInTheDocument();
  });
  it('provides recovery from an unknown URL', () => {
    renderApp('/missing');
    expect(screen.getByRole('heading', { name: 'This page isn’t here.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to overview' })).toHaveAttribute('href', '/');
  });
});

describe('identity and tenant boundaries in the browser', () => {
  it('shows no protected content while session verification is pending', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof apiClient.getSession>>) => void;
    vi.spyOn(apiClient, 'getSession').mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    renderApp();
    expect(screen.getByText('Checking your session…')).toBeInTheDocument();
    expect(screen.queryByText('Workspace notes')).not.toBeInTheDocument();
    expect(apiClient.organization).not.toHaveBeenCalled();
    await act(async () =>
      resolve({
        csrfToken: 'c'.repeat(43),
        purpose: 'anonymous',
        user: null,
        onboardingEnabled: true,
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByText('Workspace notes')).not.toBeInTheDocument();
  });
  it('recovery sessions are sent to password completion and cannot load an organization', async () => {
    vi.spyOn(apiClient, 'getSession').mockResolvedValue({
      csrfToken: 'c'.repeat(43),
      purpose: 'recovery',
      user: { id: orgId, email: 'synthetic@example.test' },
      onboardingEnabled: true,
    });
    renderApp();
    expect(
      await screen.findByRole('heading', { name: 'Choose a new password' }),
    ).toBeInTheDocument();
    expect(apiClient.organization).not.toHaveBeenCalled();
    expect(apiClient.notes).not.toHaveBeenCalled();
  });
  it('discards late note responses when switching workspaces', async () => {
    const second = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Synthetic workspace B',
      role: 'member' as const,
    };
    vi.spyOn(apiClient, 'organizations').mockResolvedValue([org, second]);
    vi.spyOn(apiClient, 'organization').mockImplementation(async (id) =>
      id === orgId ? org : second,
    );
    let release!: (notes: Awaited<ReturnType<typeof apiClient.notes>>) => void;
    vi.spyOn(apiClient, 'notes').mockImplementation((id) =>
      id === orgId
        ? new Promise((done) => {
            release = done;
          })
        : Promise.resolve([]),
    );
    vi.spyOn(apiClient, 'getHealth').mockResolvedValue({ status: 'ok', service: 'leadops-api' });
    renderApp();
    await screen.findByRole('heading', { name: 'Synthetic workspace A' });
    await waitFor(() => expect(apiClient.notes).toHaveBeenCalled());
    await userEvent.selectOptions(
      screen.getAllByRole('combobox', { name: 'Switch workspace' })[0]!,
      second.id,
    );
    await screen.findByRole('heading', { name: 'Synthetic workspace B' });
    await act(async () =>
      release([
        {
          id: orgId,
          organizationId: orgId,
          authorId: orgId,
          title: 'Delayed private note from A',
          body: 'Must not appear in B',
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    expect(screen.queryByText('Delayed private note from A')).not.toBeInTheDocument();
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
  });
  it('renders permission failures without exposing server details', async () => {
    const { ApiClientError } = await import('../lib/api-client');
    vi.spyOn(apiClient, 'organization').mockRejectedValue(new ApiClientError('http', 404));
    renderApp();
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
    expect(screen.queryByText('Workspace notes')).not.toBeInTheDocument();
  });
  it('keeps member controls within the centralized permission matrix', async () => {
    const memberOrg = { ...org, role: 'member' as const };
    vi.spyOn(apiClient, 'organization').mockResolvedValue(memberOrg);
    vi.spyOn(apiClient, 'members').mockResolvedValue([
      { userId: orgId, displayName: 'Synthetic owner', role: 'owner', revoked: false },
    ]);
    vi.spyOn(apiClient, 'invitations').mockResolvedValue([]);
    renderApp(`/organizations/${orgId}/settings`);
    expect(await screen.findByText('Synthetic owner (you)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save name' })).not.toBeInTheDocument();
    expect(apiClient.invitations).not.toHaveBeenCalled();
  });
});
