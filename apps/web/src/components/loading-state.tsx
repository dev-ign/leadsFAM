export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <span
        aria-hidden="true"
        className="size-2 rounded-full bg-muted-foreground motion-safe:animate-pulse"
      />
      {label}
    </div>
  );
}
