import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiClient } from '../../lib/api-client';
import { IdentityContext, type IdentityState } from './context';
export function IdentityProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<IdentityState>({ status: 'loading' });
  const active = useRef<AbortController | null>(null),
    channel = useRef<BroadcastChannel | null>(null);
  const verification = useRef(0);
  const load = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    return apiClient
      .getSession(controller.signal)
      .then(async (session) => {
        const organizations =
          session.purpose === 'application' ? await apiClient.organizations(controller.signal) : [];
        if (!controller.signal.aborted)
          setState({
            status: 'ready',
            session,
            organizations,
            verification: ++verification.current,
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
  }, []);
  const refresh = useCallback(() => {
    setState({ status: 'loading' });
    return load();
  }, [load]);
  useEffect(() => {
    void load();
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel('leadsfam-session');
      channel.current.onmessage = () => {
        void refresh();
      };
    }
    const expired = () => {
      active.current?.abort();
      setState({ status: 'error' });
    };
    window.addEventListener('leadsfam-session-expired', expired);
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    return () => {
      active.current?.abort();
      channel.current?.close();
      window.removeEventListener('focus', focus);
      window.removeEventListener('leadsfam-session-expired', expired);
    };
  }, [load, refresh]);
  const changed = useCallback(async () => {
    channel.current?.postMessage('changed');
    await refresh();
  }, [refresh]);
  return (
    <IdentityContext.Provider value={{ state, refresh, changed }}>
      {children}
    </IdentityContext.Provider>
  );
}
