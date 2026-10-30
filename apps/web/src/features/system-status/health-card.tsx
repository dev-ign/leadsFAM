import { Activity, ArrowUpRight, RefreshCw } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@leadops/ui';
import { useHealth } from './use-health';
import { LoadingState } from '../../components/loading-state';
import { ErrorState } from '../../components/error-state';

export function HealthCard() {
  const { state, refresh } = useHealth();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>Platform status</CardTitle>
          <Activity aria-hidden="true" className="size-4 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent>
        <div aria-live="polite" aria-atomic="true" className="min-h-24">
          {state.status === 'loading' && <LoadingState label="Checking API connection…" />}
          {state.status === 'error' && <ErrorState message={state.message} onRetry={refresh} />}
          {state.status === 'success' && (
            <>
              <p className="flex items-center gap-2 text-sm font-medium">
                <span aria-hidden="true" className="size-2 rounded-full bg-success" />
                API reachable
              </p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                The application can reach its API.
              </p>
            </>
          )}
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">Live connection check</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={state.status === 'loading'}
            aria-label="Refresh API status"
          >
            <RefreshCw aria-hidden="true" />
            Refresh
            <ArrowUpRight aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
