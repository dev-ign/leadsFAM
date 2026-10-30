import {
  Activity,
  ArrowUpRight,
  Bot,
  Inbox,
  Layers3,
  LayoutDashboard,
  MessageSquare,
  Plug,
  X,
} from 'lucide-react';
import { NavLink, useNavigate, useMatch, Link } from 'react-router';
import { useIdentity } from '../features/identity/context';
import { apiClient } from '../lib/api-client';
import { useState } from 'react';
import { identityMessage } from '../features/identity/errors';
import { Button } from '@leadops/ui';

export function Navigation({ onNavigate }: { onNavigate: () => void }) {
  const { state, changed } = useIdentity(),
    navigate = useNavigate(),
    match = useMatch('/organizations/:org/*'),
    org = match?.params.org;
  const [error, setError] = useState('');
  return (
    <>
      <div className="flex h-20 shrink-0 items-center justify-between px-6">
        <a
          href="/"
          className="flex items-center gap-2.5 font-semibold tracking-tight"
          aria-label="LeadsFam home"
        >
          <span className="grid size-8 place-items-center rounded-lg bg-foreground text-background">
            <Layers3 className="size-4" aria-hidden="true" />
          </span>
          LeadsFam
        </a>
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={onNavigate}
          aria-label="Close navigation"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="px-4">
        <div className="mb-8 rounded-lg border border-border bg-card px-3 py-3">
          {state.status === 'ready' && state.session.purpose === 'application' ? (
            <label className="block text-xs text-muted-foreground">
              Workspace
              <select
                className="field text-foreground"
                aria-label="Switch workspace"
                value={org ?? ''}
                onChange={(event) => {
                  navigate(
                    event.currentTarget.value ? `/organizations/${event.currentTarget.value}` : '/',
                  );
                  onNavigate();
                }}
              >
                <option value="">All workspaces</option>
                {state.organizations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-sm">Your next chapter</p>
          )}
        </div>
        <nav aria-label="Main navigation">
          <p className="mb-3 px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Workspace
          </p>
          <div className="space-y-1">
            {[
              { to: '/', label: 'Overview', icon: LayoutDashboard },
              { to: '/status', label: 'Platform status', icon: Activity },
            ].map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end
                onClick={onNavigate}
                className={({ isActive }) =>
                  `flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm ${isActive ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent'}`
                }
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </NavLink>
            ))}
          </div>
          <p className="mb-3 mt-8 px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Coming later
          </p>
          <ul className="space-y-1">
            {[
              { label: 'Leads', icon: Inbox },
              { label: 'Conversations', icon: MessageSquare },
              { label: 'Agents', icon: Bot },
              { label: 'Integrations', icon: Plug },
            ].map(({ label, icon: Icon }) => (
              <li
                key={label}
                className="flex min-h-11 items-center gap-3 px-3 text-sm text-muted-foreground"
              >
                <Icon className="size-4" aria-hidden="true" />
                <span>{label}</span>
                <span className="sr-only"> — coming later</span>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="mt-auto p-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium">Room to grow</p>
            <ArrowUpRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            One place for your leads, conversations, and next steps.
          </p>
        </div>
        <div className="mt-5 space-y-3 px-2 text-xs">
          {state.status === 'ready' && state.session.user ? (
            <>
              <p className="break-all">{state.session.user.email}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError('');
                  void apiClient
                    .signOut()
                    .then(async () => {
                      await changed();
                      navigate('/sign-in');
                    })
                    .catch((e) => setError(identityMessage(e)));
                }}
              >
                Sign out
              </Button>
            </>
          ) : (
            <Link className="underline" to="/sign-in" onClick={onNavigate}>
              Sign in
            </Link>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      </div>
    </>
  );
}
