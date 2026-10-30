import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Button } from '../src/button.js';

afterEach(cleanup);
describe('Button', () => {
  it('supports keyboard activation without submitting its enclosing form', async () => {
    const activate = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <Button onClick={activate}>Continue</Button>
      </form>,
    );
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue' }));
    await user.keyboard('{Enter}');
    expect(activate).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });
  it('does not activate while disabled', async () => {
    const activate = vi.fn();
    render(
      <Button disabled onClick={activate}>
        Unavailable
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(activate).not.toHaveBeenCalled();
  });
  it('composes a link with native link semantics', () => {
    render(
      <Button asChild>
        <a href="/status">View status</a>
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'View status' }).getAttribute('href')).toBe('/status');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
