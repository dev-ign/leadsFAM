import { Route, Routes } from 'react-router';
import { AppShell } from './shell';
import { Dashboard } from '../routes/dashboard';
import { StatusPage } from '../routes/status';
import { NotFoundPage } from '../routes/not-found';
export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Dashboard />} />
        <Route path="status" element={<StatusPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
