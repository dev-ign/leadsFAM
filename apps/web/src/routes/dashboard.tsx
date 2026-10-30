import {
  ArrowDownToLine,
  ArrowUpRight,
  Bot,
  Check,
  Inbox,
  MessageSquare,
  Sparkles,
  Unplug,
} from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@leadops/ui';
import { EmptyState } from '../components/empty-state';
import { HealthCard } from '../features/system-status/health-card';

const capabilities = [
  {
    label: 'Lead acquisition',
    value: 'Not connected',
    detail: 'Bring your lead sources together.',
    icon: ArrowDownToLine,
  },
  {
    label: 'Conversations',
    value: 'Not configured',
    detail: 'Make every first impression count.',
    icon: MessageSquare,
  },
  {
    label: 'Agent activity',
    value: 'Not enabled',
    detail: 'Thoughtful automation, on your terms.',
    icon: Bot,
  },
];
export function Dashboard() {
  return (
    <div className="space-y-8">
      <section>
        <p className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
          WORKSPACE OVERVIEW
        </p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              A clear starting point.
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
              Your workspace for turning new interest into meaningful conversations.
              <br className="hidden sm:block" /> Built to grow with the way you do business.
            </p>
          </div>
          <span className="mb-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
            Setup pending
          </span>
        </div>
      </section>
      <section aria-label="Workspace setup status" className="grid gap-4 md:grid-cols-3">
        {capabilities.map(({ label, value, detail, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="pt-5">
              <div className="flex items-center justify-between text-muted-foreground">
                <p className="text-xs font-medium">{label}</p>
                <Icon className="size-4" aria-hidden="true" />
              </div>
              <p className="mt-6 text-xl font-medium tracking-tight">{value}</p>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{detail}</p>
            </CardContent>
          </Card>
        ))}
      </section>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(290px,1fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <CardTitle>Your pipeline</CardTitle>
                <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">
                  Preview
                </span>
              </div>
            </CardHeader>
            <div className="mx-6 flex items-center gap-2 border-y border-border py-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground" />
                New interest
              </span>
              <span aria-hidden="true" className="flex-1 border-t border-dashed border-border" />
              <span>Conversation</span>
              <span aria-hidden="true" className="flex-1 border-t border-dashed border-border" />
              <span>Qualified</span>
            </div>
            <EmptyState
              icon={<Inbox className="size-6" />}
              title="Good conversations start with a lead."
            >
              <p>When you connect a lead source, new opportunities will have a home here.</p>
              <Button className="mt-5" disabled>
                <Unplug aria-hidden="true" />
                Lead setup coming later
              </Button>
            </EmptyState>
            <div className="border-t border-border px-6 py-3 text-xs text-muted-foreground">
              No lead sources connected. No business data is displayed.
            </div>
          </Card>
          <div className="flex items-start gap-3 rounded-xl border border-border bg-sidebar p-5">
            <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Designed around your business.</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Your sources, your engagement rules, your workflow. Future setup will adapt the
                workspace to your team.
              </p>
            </div>
          </div>
        </div>
        <div className="space-y-5">
          <HealthCard />
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>What comes next</CardTitle>
                <ArrowUpRight aria-hidden="true" className="size-4 text-muted-foreground" />
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                Invite your team now. Lead sources and engagement rules follow in future phases.
              </p>
            </CardHeader>
            <CardContent>
              <ol className="space-y-5">
                {[
                  { title: 'Invite your team', text: 'Manage access in Team & settings.' },
                  {
                    title: 'Connect a lead source',
                    text: 'Meet new opportunities where they begin.',
                  },
                  { title: 'Set engagement rules', text: 'Keep your team in control.' },
                ].map(({ title, text }, index) => (
                  <li key={title} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="grid size-6 shrink-0 place-items-center rounded-full border border-border text-[11px] text-muted-foreground"
                    >
                      {index + 1}
                    </span>
                    <div>
                      <p className="text-xs font-medium">{title}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{text}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="mt-6 flex items-center gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
                <Check aria-hidden="true" className="size-3.5" />
                You’re viewing the local workspace preview.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
