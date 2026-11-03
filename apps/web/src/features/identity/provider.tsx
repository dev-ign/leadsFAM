import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiClient, ApiClientError } from '../../lib/api-client';
import { IdentityContext, type IdentityState } from './context';

const focusCheckInterval = 30_000;

export function IdentityProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<IdentityState>({ status: 'loading' });
  const active = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null),
    channel = useRef<BroadcastChannel | null>(null);
  const verified = useRef<Extract<IdentityState, { status: 'ready' }> | null>(null),
    lastCheck = useRef(-Infinity);
  const load = useCallback((supersede = false) => {
    if (active.current && !active.current.controller.signal.aborted && !supersede)
      return active.current.promise;
    active.current?.controller.abort();
    const controller = new AbortController();
    lastCheck.current = Date.now();
    if (!verified.current) setState({ status: 'loading' });
    const promise = apiClient
      .getSession(controller.signal)
      .then(async (session) => {
        if (controller.signal.aborted) return;
        // A confirmed identity/purpose change must hide the previous user's screen,
        // even if fetching the new identity's memberships subsequently fails.
        if (
          verified.current &&
          (verified.current.session.purpose !== session.purpose ||
            verified.current.session.user?.id !== session.user?.id)
        ) {
          verified.current = null;
          setState({ status: 'loading' });
        }
        const organizations =
          session.purpose === 'application' ? await apiClient.organizations(controller.signal) : [];
        if (!controller.signal.aborted) {
          const next: Extract<IdentityState, { status: 'ready' }> = {
            status: 'ready',
            session,
            organizations,
          };
          verified.current = next;
          setState(next);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          if (error instanceof ApiClientError && [401, 403, 404].includes(error.status ?? 0))
            verified.current = null;
          setState(
            verified.current
              ? { ...verified.current, verificationError: true }
              : { status: 'error' },
          );
        }
      })
      .finally(() => {
        if (active.current?.controller === controller) active.current = null;
      });
    active.current = { controller, promise };
    return promise;
  }, []);
  const refresh = useCallback(() => load(), [load]);
  useEffect(() => {
    void load();
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('leadsfam-session');
      channel.current.onmessage = () => {
        void load(true);
      };
    }
    const expired = () => {
      active.current?.controller.abort();
      verified.current = null;
      setState({ status: 'error' });
    };
    window.addEventListener('leadsfam-session-expired', expired);
    const focus = () => {
      if (Date.now() - lastCheck.current >= focusCheckInterval) void load();
    };
    window.addEventListener('focus', focus);
    return () => {
      active.current?.controller.abort();
      channel.current?.close();
      window.removeEventListener('focus', focus);
      window.removeEventListener('leadsfam-session-expired', expired);
    };
  }, [load]);
  const changed = useCallback(async () => {
    channel.current?.postMessage('changed');
    await load(true);
  }, [load]);
  return (
    <IdentityContext.Provider value={{ state, refresh, changed }}>
      {children}
    </IdentityContext.Provider>
  );
}
