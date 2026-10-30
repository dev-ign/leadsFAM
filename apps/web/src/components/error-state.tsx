import { Button } from '@leadops/ui';
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="space-y-3">
      <p className="text-sm leading-6 text-muted-foreground">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
