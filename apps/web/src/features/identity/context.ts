import { createContext, useContext } from 'react';
import type { Organization, Session } from '@leadops/shared';
export type IdentityState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; session: Session; organizations: Organization[]; verification: number };
export const IdentityContext = createContext<{
  state: IdentityState;
  refresh: () => Promise<void>;
  changed: () => Promise<void>;
}>({ state: { status: 'loading' }, refresh: async () => {}, changed: async () => {} });
export const useIdentity = () => useContext(IdentityContext);
