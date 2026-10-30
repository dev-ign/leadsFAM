import { useCallback, useEffect, useState } from 'react';
import type { HealthResponse } from '@leadops/shared';
import { apiClient, ApiClientError } from '../../lib/api-client';

type HealthState =
  | { status: 'loading' }
  | { status: 'success'; data: HealthResponse }
  | { status: 'error'; message: string };
export function useHealth() {
  const [state, setState] = useState<HealthState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void apiClient
      .getHealth(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: 'success', data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            status: 'error',
            message:
              error instanceof ApiClientError
                ? error.message
                : 'The API is unavailable. Please try again.',
          });
      });
    return () => controller.abort();
  }, [attempt]);
  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((current) => current + 1);
  }, []);
  return { state, refresh };
}
