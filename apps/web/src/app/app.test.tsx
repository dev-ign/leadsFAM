import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { apiClient } from '../lib/api-client';
import { App } from './app';

function renderApp(path = '/') {
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
    expect(screen.getByRole('heading', { name: 'A clear starting point.' })).toBeInTheDocument();
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
    vi.spyOn(apiClient, 'getHealth')
      .mockRejectedValueOnce(new Error('sensitive provider text'))
      .mockResolvedValue({ status: 'ok', service: 'leadops-api' });
    renderApp();
    expect(screen.getByRole('status')).toHaveTextContent('Checking API connection');
    expect(await screen.findByRole('alert')).not.toHaveTextContent('sensitive');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('API reachable')).toBeInTheDocument();
  });
  it('navigates to status and explains security limits', async () => {
    vi.spyOn(apiClient, 'getHealth').mockResolvedValue({ status: 'ok', service: 'leadops-api' });
    renderApp();
    await userEvent.click(screen.getAllByRole('link', { name: 'Platform status' })[0]!);
    expect(screen.getByRole('heading', { name: 'Platform status', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Account sign-in, organization permissions/)).toBeInTheDocument();
    expect(await screen.findByText('API reachable')).toBeInTheDocument();
  });
  it('supports a persisted theme toggle', async () => {
    vi.spyOn(apiClient, 'getHealth').mockResolvedValue({ status: 'ok', service: 'leadops-api' });
    renderApp();
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
