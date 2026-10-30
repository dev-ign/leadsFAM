import { Link } from 'react-router';
import { Inbox, Users, ArrowUpRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@leadops/ui';
import { useOrganization } from '../features/organizations/context';
import { HealthCard } from '../features/system-status/health-card';
export function Dashboard() {
  const { organization } = useOrganization(),
    base = `/organizations/${organization.id}`;
  return (
    <div className="space-y-7">
      <section className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">
            Workspace overview
          </p>
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            A clear starting point.
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Bring new interest into focus, keep contact details current, and choose the next step
            together.
          </p>
        </div>
        <Link
          className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
          to={`${base}/leads/new`}
        >
          New lead
        </Link>
      </section>
      <section className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <Inbox className="mr-2 inline size-4" aria-hidden="true" />
              Lead workspace
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              Follow each opportunity from new interest through a clear closing outcome.
            </p>
            <Link className="text-sm underline" to={`${base}/leads`}>
              Open leads <ArrowUpRight className="inline size-3" aria-hidden="true" />
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>
              <Users className="mr-2 inline size-4" aria-hidden="true" />
              Shared contacts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              Current contact details stay shared across related leads.
            </p>
            <Link className="text-sm underline" to={`${base}/contacts`}>
              Open contacts <ArrowUpRight className="inline size-3" aria-hidden="true" />
            </Link>
          </CardContent>
        </Card>
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Keep acquisition clear</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              Use sources and immutable acquisition history to understand where interest began.
            </p>
            <Link className="text-sm underline" to={`${base}/sources`}>
              Manage lead sources
            </Link>
            {organization.role !== 'member' && (
              <Link className="ml-5 text-sm underline" to={`${base}/imports`}>
                Import a CSV
              </Link>
            )}
          </CardContent>
        </Card>
        <HealthCard />
      </div>
    </div>
  );
}
