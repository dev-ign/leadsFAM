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
import { NavLink } from 'react-router';
import { Button } from '@leadops/ui';

export function Navigation({ onNavigate }: { onNavigate: () => void }) {
  return (
    <>
      <div className="flex h-20 shrink-0 items-center justify-between px-6">
        <a
          href="/"
          className="flex items-center gap-2.5 font-semibold tracking-tight"
          aria-label="LeadOps AI home"
        >
          <span className="grid size-8 place-items-center rounded-lg bg-foreground text-background">
            <Layers3 className="size-4" aria-hidden="true" />
          </span>
          LeadOps<span className="text-xs font-medium text-muted-foreground">AI</span>
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
          <p className="text-xs text-muted-foreground">Workspace</p>
          <p className="mt-1 text-sm font-medium">Your next chapter</p>
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
        <div className="mt-5 flex items-center gap-3 px-2">
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-full bg-accent text-xs font-semibold"
          >
            W
          </span>
          <div>
            <p className="text-xs font-medium">Workspace setup pending</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Foundation preview</p>
          </div>
        </div>
      </div>
    </>
  );
}
