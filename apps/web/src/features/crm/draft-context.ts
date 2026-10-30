import { createContext, useContext } from 'react';
import type { DraftStore } from './draft-store';
export const DraftContext = createContext<{
  store: DraftStore;
  confirmDiscard: (action: () => void) => void;
} | null>(null);
export function useDrafts() {
  const value = useContext(DraftContext);
  if (!value) throw new Error('Draft context is required');
  return value;
}
