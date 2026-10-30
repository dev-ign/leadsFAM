import {
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useBlocker } from 'react-router';
import { Button } from '@leadops/ui';
import { useIdentity } from '../identity/context';
import { DraftContext } from './draft-context';
import { DraftStore } from './draft-store';
export function DraftProvider({ children }: { children: ReactNode }) {
  const { state } = useIdentity(),
    [store] = useState(() => new DraftStore()),
    [pending, setPending] = useState<(() => void) | null>(null),
    dialog = useRef<HTMLDialogElement>(null);
  useSyncExternalStore(store.subscribe, store.snapshot);
  useLayoutEffect(() => {
    if (state.status !== 'ready') store.suspend();
    else if (state.session.purpose === 'application' && state.session.user)
      store.establish(
        state.session.user.id,
        state.organizations.map((v) => ({ id: v.id, role: v.role })),
      );
    else store.clear();
  }, [state, store]);
  const shouldBlock = useCallback(() => store.hasDirty(), [store]);
  const dirty = store.hasDirty(),
    blocker = useBlocker(shouldBlock);
  const shown = blocker.state === 'blocked' || pending !== null;
  useEffect(() => {
    if (shown && !dialog.current?.open) dialog.current?.showModal();
    if (!shown && dialog.current?.open) dialog.current.close();
  }, [shown]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (store.hasDirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const expired = () => store.clear();
    window.addEventListener('beforeunload', unload);
    window.addEventListener('leadsfam-session-expired', expired);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('leadsfam-session-expired', expired);
    };
  }, [store]);
  useEffect(() => {
    if (!dirty && blocker.state === 'blocked') blocker.reset();
  }, [dirty, blocker]);
  const stay = () => {
    if (blocker.state === 'blocked') blocker.reset();
    setPending(null);
  };
  const discard = () => {
    const action = pending;
    setPending(null);
    store.discardActive();
    if (blocker.state === 'blocked') blocker.proceed();
    action?.();
  };
  return (
    <DraftContext.Provider
      value={{
        store,
        confirmDiscard: (action) => {
          if (store.hasDirty()) setPending(() => action);
          else action();
        },
      }}
    >
      {children}
      <dialog
        ref={dialog}
        aria-labelledby="discard-title"
        className="m-auto max-h-[90vh] w-[90vw] max-w-md rounded-xl border border-border bg-card p-6 text-foreground shadow-xl backdrop:bg-black/40"
        onCancel={(e) => {
          e.preventDefault();
          stay();
        }}
      >
        <h2 id="discard-title" className="text-lg font-semibold">
          Discard unsaved changes?
        </h2>
        <p className="my-4 text-sm text-muted-foreground">
          Your changes are kept only while this workspace is open. A save already sent may still
          finish.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={stay} autoFocus>
            Keep editing
          </Button>
          <Button onClick={discard}>Discard changes</Button>
        </div>
      </dialog>
    </DraftContext.Provider>
  );
}
