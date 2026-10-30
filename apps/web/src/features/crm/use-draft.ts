import { useEffect, useState, useSyncExternalStore } from 'react';
import { useOrganization } from '../organizations/context';
import { useDrafts } from './draft-context';
import type { Draft } from './draft-store';
export function useDraft<T>(form: string, initial: T) {
  const { organization } = useOrganization(),
    { store } = useDrafts();
  const [seed] = useState<Draft<T>>(() => ({
    value: initial,
    dirty: false,
    phase: 'editing',
    requestKey: crypto.randomUUID(),
    submitted: null,
    resultId: null,
    error: '',
  }));
  useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    store.ensure(organization.id, form, seed);
  }, [store, organization.id, form, seed]);
  const draft = store.read<T>(organization.id, form) ?? seed,
    token = store.token(organization.id);
  const update = (change: (value: Draft<T>) => Draft<T>) => store.write(token, form, seed, change);
  return {
    draft,
    update,
    visible: () => store.visible(token),
    enabled: token !== null,
    change: (value: T) =>
      update((old) => ({
        ...old,
        value,
        dirty: true,
        error: '',
        requestKey: old.phase === 'editing' ? crypto.randomUUID() : old.requestKey,
      })),
    clear: () => store.remove(token, form),
  };
}
