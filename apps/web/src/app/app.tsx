import { Route } from 'react-router';
import { lazy } from 'react';
import { AppShell } from './shell';
import { IdentityProvider } from '../features/identity/provider';
import { SessionGate } from '../features/identity/gate';
import {
  OrganizationHome,
  OrganizationRoute,
  WorkspaceDashboard,
  OrganizationSettings,
  JoinPage,
} from '../features/organizations/pages';
import { NotFoundPage } from '../routes/not-found';
import { DraftProvider } from '../features/crm/draft-provider';
const AgentsPage = lazy(() =>
  import('../features/ai/pages').then((m) => ({ default: m.AgentsPage })),
);
const StatusPage = lazy(() => import('../routes/status').then((m) => ({ default: m.StatusPage })));
const AuthPage = lazy(() =>
  import('../features/identity/auth-pages').then((m) => ({ default: m.AuthPage })),
);
const LeadsPage = lazy(() =>
  import('../features/crm/lists').then((m) => ({ default: m.LeadsPage })),
);
const ContactsPage = lazy(() =>
  import('../features/crm/lists').then((m) => ({ default: m.ContactsPage })),
);
const NewLeadPage = lazy(() =>
  import('../features/crm/forms').then((m) => ({ default: m.NewLeadPage })),
);
const NewContactPage = lazy(() =>
  import('../features/crm/forms').then((m) => ({ default: m.NewContactPage })),
);
const LeadDetailPage = lazy(() =>
  import('../features/crm/details').then((m) => ({ default: m.LeadDetailPage })),
);
const ContactDetailPage = lazy(() =>
  import('../features/crm/details').then((m) => ({ default: m.ContactDetailPage })),
);
const LeadEditPage = lazy(() =>
  import('../features/crm/details').then((m) => ({ default: m.LeadEditPage })),
);
const ContactEditPage = lazy(() =>
  import('../features/crm/details').then((m) => ({ default: m.ContactEditPage })),
);
const ImportsPage = lazy(() =>
  import('../features/crm/imports').then((m) => ({ default: m.ImportsPage })),
);
const SourcesPage = lazy(() =>
  import('../features/crm/sources').then((m) => ({ default: m.SourcesPage })),
);
const AutomationsPage = lazy(() =>
  import('../features/automation/pages').then((m) => ({ default: m.AutomationsPage })),
);
const AutomationEditorPage = lazy(() =>
  import('../features/automation/pages').then((m) => ({ default: m.AutomationEditorPage })),
);
const IntegrationsPage = lazy(() =>
  import('../features/automation/pages').then((m) => ({ default: m.IntegrationsPage })),
);
const ConversationsPage = lazy(() =>
  import('../features/communications/pages').then((m) => ({ default: m.ConversationsPage })),
);
const ConversationDetailPage = lazy(() =>
  import('../features/communications/pages').then((m) => ({ default: m.ConversationDetailPage })),
);
const ComposeMessagePage = lazy(() =>
  import('../features/communications/pages').then((m) => ({ default: m.ComposeMessagePage })),
);
const CommunicationSettingsPage = lazy(() =>
  import('../features/communications/pages').then((m) => ({
    default: m.CommunicationSettingsPage,
  })),
);
function RouteFailure() {
  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="text-2xl font-semibold">Something went wrong.</h1>
      <p className="my-4">Reload the workspace to try again.</p>
      <button className="underline" onClick={() => window.location.reload()}>
        Reload workspace
      </button>
    </main>
  );
}
export function AppRoutes() {
  return (
    <Route
      element={
        <IdentityProvider>
          <DraftProvider>
            <AppShell />
          </DraftProvider>
        </IdentityProvider>
      }
      errorElement={<RouteFailure />}
    >
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
          <Route path="leads" element={<LeadsPage />} />
          <Route path="leads/new" element={<NewLeadPage />} />
          <Route path="leads/:id" element={<LeadDetailPage />} />
          <Route path="leads/:id/edit" element={<LeadEditPage />} />
          <Route path="contacts" element={<ContactsPage />} />
          <Route path="contacts/new" element={<NewContactPage />} />
          <Route path="contacts/:id" element={<ContactDetailPage />} />
          <Route path="contacts/:id/edit" element={<ContactEditPage />} />
          <Route path="imports" element={<ImportsPage />} />
          <Route path="imports/:job" element={<ImportsPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="automations" element={<AutomationsPage />} />
          <Route path="automations/new" element={<AutomationEditorPage />} />
          <Route path="automations/:id/edit" element={<AutomationEditorPage />} />
          <Route path="integrations" element={<IntegrationsPage />} />
          <Route path="communications" element={<ConversationsPage />} />
          <Route path="communications/compose" element={<ComposeMessagePage />} />
          <Route path="communications/settings" element={<CommunicationSettingsPage />} />
          <Route path="communications/:id" element={<ConversationDetailPage />} />
          <Route path="sources" element={<SourcesPage />} />
        </Route>
      </Route>
      <Route path="status" element={<StatusPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
  );
}
