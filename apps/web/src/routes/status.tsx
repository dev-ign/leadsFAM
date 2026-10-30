import { Card, CardContent, CardHeader, CardTitle } from '@leadops/ui';
import { HealthCard } from '../features/system-status/health-card';
export function StatusPage() {
  return (
    <div className="max-w-3xl space-y-7">
      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Workspace
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Platform status</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          A live look at the application’s API connection.
        </p>
      </div>
      <HealthCard />
      <Card>
        <CardHeader>
          <CardTitle>What this check tells you</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-7 text-muted-foreground">
            The API connection check confirms that the server responds. Account sign-in,
            organization permissions and tenant isolation have separate checks. This status endpoint
            does not test them or confirm production readiness. This local preview is not ready to
            hold business data.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
