import { createContext, useContext } from 'react';
import type { Organization } from '@leadops/shared';
export const OrganizationContext = createContext<{
  organization: Organization;
  reload: () => void;
} | null>(null);
export function useOrganization() {
  const value = useContext(OrganizationContext);
  if (!value) throw new Error('Organization context is required');
  return value;
}
