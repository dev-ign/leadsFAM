import { useState, useRef, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { Button, Card, CardContent, CardHeader } from '@leadops/ui';
import { apiClient } from '../../lib/api-client';
import { identityMessage } from './errors';
import { useIdentity } from './context';
type Mode =
  'sign-in' | 'sign-up' | 'verify-email' | 'forgot-password' | 'recovery' | 'reset-password';
const titles: Record<Mode, string> = {
  'sign-in': 'Welcome back',
  'sign-up': 'Create your account',
  'verify-email': 'Verify your email',
  'forgot-password': 'Reset your password',
  recovery: 'Enter your recovery code',
  'reset-password': 'Choose a new password',
};
export function AuthPage({ mode }: { mode: Mode }) {
  const { state, changed, refresh } = useIdentity(),
    navigate = useNavigate(),
    location = useLocation();
  const formElement = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const returnTo = (location.state as { returnTo?: unknown } | null)?.returnTo;
  const next =
    typeof returnTo === 'string' && /^\/(join(?:#|$)|organizations(?:\/|$))/.test(returnTo)
      ? returnTo
      : '/';
  if (state.status === 'loading') return <p role="status">Checking your session…</p>;
  if (state.status === 'error')
    return (
      <div role="alert">
        We could not verify your session. <Button onClick={() => void refresh()}>Try again</Button>
      </div>
    );
  if (state.session.purpose === 'application' && mode === 'sign-in')
    return <Navigate to={next} replace />;
  if (mode === 'reset-password' && state.session.purpose !== 'recovery')
    return <Navigate to="/recovery" replace />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      email = String(form.get('email') ?? ''),
      password = String(form.get('password') ?? ''),
      token = String(form.get('token') ?? '');
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'sign-in') {
        await apiClient.signIn({ email, password });
        await changed();
        navigate(next, { replace: true });
      }
      if (mode === 'sign-up') {
        await apiClient.signUp({
          email,
          password,
          displayName: String(form.get('displayName') ?? ''),
        });
        navigate('/verify-email', { state: { email, returnTo: next } });
      }
      if (mode === 'verify-email') {
        await apiClient.verifyEmail({ email, token });
        setMessage('Email verified. You can now sign in.');
      }
      if (mode === 'forgot-password') {
        await apiClient.forgotPassword(email);
        navigate('/recovery', { state: { email } });
      }
      if (mode === 'recovery') {
        await apiClient.beginRecovery({ email, token });
        await changed();
        navigate('/reset-password');
      }
      if (mode === 'reset-password') {
        await apiClient.resetPassword(password);
        await changed();
        navigate('/sign-in', {
          state: { message: 'Password changed. Sign in with your new password.' },
        });
      }
    } catch (failure) {
      setError(identityMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const emailDefault =
    typeof (location.state as { email?: unknown } | null)?.email === 'string'
      ? (location.state as { email: string }).email
      : '';
  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <p className="mb-2 text-xs text-muted-foreground">Your LeadsFam workspace</p>
        <h1 className="text-2xl font-semibold tracking-tight">{titles[mode]}</h1>
      </CardHeader>
      <CardContent>
        {mode === 'recovery' && (
          <p className="mb-5 text-sm text-muted-foreground">
            If an account exists, a recovery code has been sent. Enter it below.
          </p>
        )}
        {mode === 'verify-email' && (
          <p className="mb-5 text-sm text-muted-foreground">
            If registration is available, check your email for a six-digit code.
          </p>
        )}
        {mode === 'sign-in' &&
          typeof (location.state as { message?: unknown } | null)?.message === 'string' && (
            <p role="status" className="mb-4 text-sm">
              Password changed. Sign in with your new password.
            </p>
          )}
        <form ref={formElement} onSubmit={(event) => void submit(event)} className="space-y-4">
          <fieldset disabled={busy} className="space-y-4">
            {mode === 'sign-up' && (
              <label className="block text-sm">
                Your name
                <input
                  className="field"
                  name="displayName"
                  autoComplete="name"
                  required
                  maxLength={100}
                />
              </label>
            )}
            {mode !== 'reset-password' && (
              <label className="block text-sm">
                Email
                <input
                  className="field"
                  name="email"
                  type="email"
                  autoComplete="email"
                  defaultValue={emailDefault}
                  required
                  maxLength={254}
                />
              </label>
            )}
            {['sign-in', 'sign-up', 'reset-password'].includes(mode) && (
              <label className="block text-sm">
                Password
                <input
                  className="field"
                  name="password"
                  type="password"
                  autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                  minLength={12}
                  maxLength={128}
                  required
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Use 12–128 characters.
                </span>
              </label>
            )}
            {['verify-email', 'recovery'].includes(mode) && (
              <label className="block text-sm">
                Six-digit code
                <input
                  className="field"
                  name="token"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  required
                />
              </label>
            )}
            <Button type="submit" className="w-full">
              {busy
                ? 'Please wait…'
                : mode === 'forgot-password'
                  ? 'Send recovery code'
                  : mode === 'verify-email'
                    ? 'Verify email'
                    : mode === 'recovery'
                      ? 'Continue recovery'
                      : mode === 'reset-password'
                        ? 'Save new password'
                        : mode === 'sign-up'
                          ? 'Create account'
                          : 'Sign in'}
            </Button>
          </fieldset>
        </form>
        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="mt-4 text-sm">
            {message}
          </p>
        )}
        {mode === 'verify-email' && (
          <Button
            className="mt-4"
            variant="outline"
            disabled={busy}
            onClick={() => {
              const email =
                (formElement.current?.elements.namedItem('email') as HTMLInputElement | null)
                  ?.value ?? '';
              setBusy(true);
              void apiClient
                .resend(email)
                .then(() => setMessage('If eligible, another code has been sent.'))
                .catch((e) => setError(identityMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            Resend code
          </Button>
        )}
        <div className="mt-6 flex flex-wrap gap-4 text-sm underline underline-offset-4">
          <Link to="/sign-in" state={{ returnTo: next }}>
            Sign in
          </Link>
          <Link to="/sign-up" state={{ returnTo: next }}>
            Create account
          </Link>
          <Link to="/forgot-password">Forgot password?</Link>
        </div>
      </CardContent>
    </Card>
  );
}
