import { Component, type ReactNode } from 'react';
import { Button } from '@leadops/ui';
export class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  override state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  override render() {
    if (this.state.hasError)
      return (
        <main className="mx-auto max-w-lg px-6 py-24">
          <h1 className="text-2xl font-semibold">Something went wrong.</h1>
          <p className="mt-3 text-sm text-muted-foreground">Reload the workspace to try again.</p>
          <Button className="mt-6" onClick={() => window.location.reload()}>
            Reload workspace
          </Button>
        </main>
      );
    return this.props.children;
  }
}
