import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { can, canRemoveMember, canChangeMemberRole, type Note } from '@leadops/shared';
import { Button, Card, CardHeader, CardTitle, CardContent } from '@leadops/ui';
import { apiClient } from '../../lib/api-client';
import { useIdentity } from '../identity/context';
import { identityMessage } from '../identity/errors';
import { OrganizationContext, useOrganization } from './context';
import { useResource } from './use-resource';
import { Dashboard } from '../../routes/dashboard';

function Failure({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="space-y-3">
      <p>{identityMessage(error)}</p>
      <Button onClick={retry}>Try again</Button>
      <Link className="ml-3 underline" to="/">
        Choose another workspace
      </Link>
    </div>
  );
}
export function OrganizationHome() {
  const { state, changed } = useIdentity(),
    navigate = useNavigate();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  if (state.status !== 'ready') return null;
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '');
    setBusy(true);
    setError('');
    try {
      const org = await apiClient.createOrganization(name);
      await changed();
      navigate(`/organizations/${org.id}`);
    } catch (e) {
      setError(identityMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="max-w-3xl space-y-7">
      <div>
        <p className="mb-2 text-xs text-muted-foreground">LeadsFam</p>
        <h1 className="text-3xl font-semibold">Your workspaces</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Choose a team to get started. Each workspace keeps its own members and records.
        </p>
      </div>
      {state.organizations.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {state.organizations.map((org) => (
            <li key={org.id}>
              <Link
                className="block rounded-xl border border-border bg-card p-5 hover:bg-accent focus-visible:outline-2"
                to={`/organizations/${org.id}`}
              >
                <span className="block font-medium">{org.name}</span>
                <span className="mt-2 block text-xs capitalize text-muted-foreground">
                  {org.role}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-border p-5">
          You have no workspaces yet. Accept a team invitation or create a workspace below.
        </p>
      )}
      {state.session.onboardingEnabled ? (
        <Card>
          <CardHeader>
            <CardTitle>Create a workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={(event) => void create(event)} className="space-y-4">
              <label className="block text-sm">
                Workspace name
                <input className="field" name="name" required maxLength={80} minLength={1} />
              </label>
              <Button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create workspace'}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <p>Workspace creation is currently closed. Ask your team for an invitation.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Link className="text-sm underline" to="/join">
        Accept an invitation
      </Link>
    </div>
  );
}
export function OrganizationRoute() {
  const { org } = useParams();
  return org ? <OrganizationBoundary key={org} org={org} /> : <Navigate to="/" replace />;
}
function OrganizationBoundary({ org }: { org: string }) {
  const load = useCallback((signal: AbortSignal) => apiClient.organization(org, signal), [org]);
  const { state, refresh } = useResource(load);
  if (state.status === 'loading') return <p role="status">Opening workspace…</p>;
  if (state.status === 'error') return <Failure error={state.error} retry={refresh} />;
  return (
    <OrganizationContext.Provider value={{ organization: state.data, reload: refresh }}>
      <div className="mb-7 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="text-xs text-muted-foreground">Current workspace</p>
          <h1 className="mt-1 text-2xl font-semibold">{state.data.name}</h1>
        </div>
        <nav
          aria-label="Workspace pages"
          className="flex gap-4 text-sm underline underline-offset-4"
        >
          <Link to={`/organizations/${org}`}>Overview</Link>
          <Link to={`/organizations/${org}/settings`}>Team & settings</Link>
        </nav>
      </div>
      <Outlet />
    </OrganizationContext.Provider>
  );
}
export function WorkspaceDashboard() {
  return (
    <div className="space-y-8">
      <Notes />
      <Dashboard />
    </div>
  );
}
function Notes() {
  const { organization } = useOrganization(),
    { state: identity } = useIdentity();
  const load = useCallback(
    (signal: AbortSignal) => apiClient.notes(organization.id, signal),
    [organization.id],
  );
  const { state, refresh } = useResource(load);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [editing, setEditing] = useState<Note | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form);
    setBusy(true);
    setError('');
    try {
      await apiClient.writeNote(
        organization.id,
        { title: String(data.get('title') ?? ''), body: String(data.get('body') ?? '') },
        editing?.id,
      );
      setEditing(null);
      form.reset();
      refresh();
    } catch (e) {
      setError(identityMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(note: Note) {
    setBusy(true);
    setError('');
    try {
      await apiClient.deleteNote(organization.id, note.id);
      refresh();
    } catch (e) {
      setError(identityMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const user = identity.status === 'ready' ? identity.session.user?.id : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace notes</CardTitle>
        <p className="text-sm text-muted-foreground">
          A private space for your team. Lead sources and outreach are coming later.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {state.status === 'loading' ? (
          <p role="status">Loading notes…</p>
        ) : state.status === 'error' ? (
          <Failure error={state.error} retry={refresh} />
        ) : state.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="space-y-3">
            {state.data.map((note) => (
              <li key={note.id} className="rounded-lg border border-border p-4">
                <h3 className="font-medium">{note.title}</h3>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {note.body}
                </p>
                {(note.authorId === user || can(organization.role, 'moderate_note')) && (
                  <div className="mt-3 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setEditing(note)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void remove(note)}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          key={editing?.id ?? 'new'}
          onSubmit={(event) => void save(event)}
          className="space-y-3 border-t border-border pt-5"
        >
          <h3 className="text-sm font-medium">{editing ? 'Edit note' : 'Add a note'}</h3>
          <fieldset className="space-y-3" disabled={busy}>
            <label className="block text-sm">
              Title
              <input
                className="field"
                name="title"
                required
                maxLength={120}
                defaultValue={editing?.title ?? ''}
              />
            </label>
            <label className="block text-sm">
              Note
              <textarea
                className="field min-h-24"
                name="body"
                maxLength={4000}
                defaultValue={editing?.body ?? ''}
              />
            </label>
            <Button type="submit">{busy ? 'Saving…' : 'Save note'}</Button>
            {editing && (
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel edit
              </Button>
            )}
          </fieldset>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
export function OrganizationSettings() {
  const { organization, reload } = useOrganization(),
    { changed, state: identity } = useIdentity();
  const memberLoad = useCallback(
    (signal: AbortSignal) => apiClient.members(organization.id, signal),
    [organization.id],
  );
  const invitationLoad = useCallback(
    (signal: AbortSignal) =>
      can(organization.role, 'invite_member')
        ? apiClient.invitations(organization.id, signal)
        : Promise.resolve([]),
    [organization.id, organization.role],
  );
  const members = useResource(memberLoad),
    invitations = useResource(invitationLoad);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [link, setLink] = useState('');
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      members.refresh();
      if (can(organization.role, 'invite_member')) invitations.refresh();
    } catch (e) {
      setError(identityMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '');
    await action(async () => {
      await apiClient.renameOrganization(organization.id, name);
      await changed();
      reload();
    });
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await action(async () => {
      const result = await apiClient.invite(
        organization.id,
        String(data.get('email') ?? ''),
        data.get('role') === 'admin' ? 'admin' : 'member',
      );
      setLink(`${window.location.origin}/join#${result.token}`);
    });
  }
  const currentUser = identity.status === 'ready' ? identity.session.user?.id : undefined;
  return (
    <div className="space-y-6">
      {can(organization.role, 'settings') && (
        <Card>
          <CardHeader>
            <CardTitle>Workspace settings</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={(event) => void rename(event)} className="space-y-4">
              <label className="block text-sm">
                Workspace name
                <input
                  className="field"
                  name="name"
                  required
                  maxLength={80}
                  defaultValue={organization.name}
                />
              </label>
              <Button type="submit" disabled={busy}>
                Save name
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Team members</CardTitle>
        </CardHeader>
        <CardContent>
          {members.state.status === 'loading' ? (
            <p role="status">Loading members…</p>
          ) : members.state.status === 'error' ? (
            <Failure error={members.state.error} retry={members.refresh} />
          ) : (
            <ul className="divide-y divide-border">
              {members.state.data.map((member) => (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {member.displayName || 'Team member'}
                      {member.userId === currentUser ? ' (you)' : ''}
                    </p>
                    <p className="mt-1 text-xs capitalize text-muted-foreground">
                      {member.role}
                      {member.revoked ? ' · Removed' : ''}
                    </p>
                  </div>
                  {!member.revoked && member.role !== 'owner' && (
                    <div className="flex flex-wrap gap-2">
                      {canChangeMemberRole(organization.role, member.role) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void action(() =>
                              apiClient.changeMember(
                                organization.id,
                                member.userId,
                                member.role === 'admin' ? 'member' : 'admin',
                              ),
                            )
                          }
                        >
                          {member.role === 'admin' ? 'Make member' : 'Make admin'}
                        </Button>
                      )}
                      {canRemoveMember(
                        organization.role,
                        member.role,
                        member.userId === currentUser,
                      ) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await apiClient.removeMember(organization.id, member.userId);
                              if (member.userId === currentUser) await changed();
                            })
                          }
                        >
                          {member.userId === currentUser ? 'Leave workspace' : 'Remove'}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {can(organization.role, 'invite_member') && (
        <Card>
          <CardHeader>
            <CardTitle>Invite a teammate</CardTitle>
            <p className="text-sm text-muted-foreground">
              Share the generated link with the matching email address. Invitations expire after 72
              hours.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            <form onSubmit={(event) => void invite(event)} className="space-y-4">
              <fieldset disabled={busy} className="space-y-4">
                <label className="block text-sm">
                  Teammate email
                  <input className="field" name="email" type="email" required maxLength={254} />
                </label>
                <label className="block text-sm">
                  Role
                  <select className="field" name="role">
                    <option value="member">Member</option>
                    {can(organization.role, 'invite_admin') && <option value="admin">Admin</option>}
                  </select>
                </label>
                <Button type="submit">Create invitation link</Button>
              </fieldset>
            </form>
            {link && (
              <label className="block text-sm">
                Invitation link
                <input
                  className="field"
                  readOnly
                  value={link}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Copy this link now. It is shown only in this page.
                </span>
              </label>
            )}
            {invitations.state.status === 'loading' ? (
              <p role="status">Loading invitations…</p>
            ) : invitations.state.status === 'error' ? (
              <Failure error={invitations.state.error} retry={invitations.refresh} />
            ) : (
              <ul className="divide-y divide-border">
                {invitations.state.data.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                  >
                    <div>
                      <p>{inv.email}</p>
                      <p className="mt-1 text-xs capitalize text-muted-foreground">
                        {inv.role} ·{' '}
                        {inv.accepted
                          ? 'Accepted'
                          : inv.revoked
                            ? 'Revoked'
                            : new Date(inv.expiresAt) < new Date()
                              ? 'Expired'
                              : 'Pending'}
                      </p>
                    </div>
                    {!inv.accepted &&
                      !inv.revoked &&
                      (inv.role === 'member' || can(organization.role, 'invite_admin')) && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void action(() => apiClient.revokeInvitation(organization.id, inv.id))
                          }
                        >
                          Revoke
                        </Button>
                      )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
export function JoinPage() {
  const location = useLocation(),
    navigate = useNavigate(),
    { changed } = useIdentity();
  const [initialToken] = useState(() => location.hash.slice(1));
  useEffect(() => {
    if (location.hash)
      window.history.replaceState(window.history.state, '', window.location.pathname);
  }, [location.hash]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = String(new FormData(event.currentTarget).get('token') ?? '').trim();
    setBusy(true);
    setError('');
    try {
      const org = await apiClient.acceptInvitation(token);
      window.history.replaceState(null, '', window.location.pathname);
      await changed();
      navigate(`/organizations/${org.id}`, { replace: true });
    } catch (e) {
      setError(identityMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>Join a workspace</CardTitle>
        <p className="text-sm text-muted-foreground">
          Sign in with the verified email address the invitation was sent to.
        </p>
      </CardHeader>
      <CardContent>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <label className="block text-sm">
            Invitation code
            <input
              className="field"
              name="token"
              defaultValue={initialToken}
              required
              pattern="[A-Za-z0-9_-]{43}"
            />
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? 'Joining…' : 'Accept invitation'}
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
