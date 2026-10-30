import { Route, Routes } from 'react-router';
import { AppShell } from './shell';
import { IdentityProvider } from '../features/identity/provider';
import { SessionGate } from '../features/identity/gate';
import { AuthPage } from '../features/identity/auth-pages';
import {
  OrganizationHome,
  OrganizationRoute,
  WorkspaceDashboard,
  OrganizationSettings,
  JoinPage,
} from '../features/organizations/pages';
import { StatusPage } from '../routes/status';
import { NotFoundPage } from '../routes/not-found';
export function App() {
  return (
    <IdentityProvider>
      <Routes>
        <Route element={<AppShell />}>
          {(
            [
              'sign-in',
              'sign-up',
              'verify-email',
              'forgot-password',
              'recovery',
              'reset-password',
            ] as const
          ).map((mode) => (
            <Route key={mode} path={mode} element={<AuthPage key={mode} mode={mode} />} />
          ))}
          <Route element={<SessionGate />}>
            <Route index element={<OrganizationHome />} />
            <Route path="join" element={<JoinPage />} />
            <Route path="organizations/:org" element={<OrganizationRoute />}>
              <Route index element={<WorkspaceDashboard />} />
              <Route path="settings" element={<OrganizationSettings />} />
            </Route>
          </Route>
          <Route path="status" element={<StatusPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </IdentityProvider>
  );
}
