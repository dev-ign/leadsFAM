import { Link } from 'react-router';
import { Button } from '@leadops/ui';
export function NotFoundPage() {
  return (
    <div className="py-20 text-center">
      <p className="text-xs text-muted-foreground">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">This page isn’t here.</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Return to your workspace to keep exploring.
      </p>
      <Button asChild className="mt-6">
        <Link to="/">Back to overview</Link>
      </Button>
    </div>
  );
}
