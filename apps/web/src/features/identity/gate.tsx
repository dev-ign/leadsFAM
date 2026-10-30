import { Navigate, Outlet, useLocation } from 'react-router';
import { Button } from '@leadops/ui';
import { useIdentity } from './context';
export function SessionGate() {
  const { state, refresh } = useIdentity(),
    location = useLocation();
  if (state.status === 'loading') return <p role="status">Checking your session…</p>;
  if (state.status === 'error')
    return (
      <div role="alert">
        <p>We could not verify your session.</p>
        <Button onClick={() => void refresh()}>Try again</Button>
      </div>
    );
  if (state.session.purpose === 'recovery') return <Navigate to="/reset-password" replace />;
  if (state.session.purpose !== 'application')
    return (
      <Navigate to="/sign-in" replace state={{ returnTo: location.pathname + location.hash }} />
    );
  return <Outlet />;
}
