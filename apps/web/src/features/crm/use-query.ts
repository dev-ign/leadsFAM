import { useCallback, useEffect, useState } from 'react';
import { useIdentity } from '../identity/context';
import { useOrganization } from '../organizations/context';
export function useQuery<T>(inputKey: string, load: (signal: AbortSignal) => Promise<T>) {
  const { state: identity } = useIdentity(),
    { organization } = useOrganization();
  const key = JSON.stringify([
    identity.status === 'ready' ? identity.session.user?.id : null,
    organization.id,
    inputKey,
  ]);
  const [attempt, setAttempt] = useState(0),
    [result, setResult] = useState<
      | { key: string; attempt: number; data: T }
      | { key: string; attempt: number; error: unknown }
      | null
    >(null);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, attempt, data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key, attempt, error });
      });
    return () => controller.abort();
  }, [key, load, attempt]);
  const refresh = useCallback(() => setAttempt((v) => v + 1), []);
  const state =
    !result || result.key !== key || result.attempt !== attempt
      ? { status: 'loading' as const }
      : 'error' in result
        ? { status: 'error' as const, error: result.error }
        : { status: 'ready' as const, data: result.data };
  return { state, refresh };
}
