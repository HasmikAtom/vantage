import * as React from 'react';
import { authClient } from '@/auth';
import { Button, Card, Input, Separator } from './ui/primitives';
import { VantageLogo } from './ui/brand';
import { cn } from '@/lib/utils';

type Method = 'password' | 'passkey';
type AuthMode = 'signin' | 'signup';

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [method, setMethod] = React.useState<Method>('password');
  // signin vs signup is now an EXPLICIT user choice (toggle button below
  // the form) rather than something inferred from /auth/_email_status.
  // The endpoint used to return `new` for whitelisted-but-not-registered
  // emails, letting an attacker enumerate the whitelist by sweeping a
  // wordlist. The collapse + explicit toggle is the privacy-preserving
  // alternative: whether an email is on the whitelist is now only
  // revealed at sign-up submit time, behind whatever rate limiting the
  // server applies.
  const [authMode, setAuthMode] = React.useState<AuthMode>('signin');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const onPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (authMode === 'signup') {
        // Sign-up succeeds only when the server-side hook decides:
        //   - first user ever → claims the bootstrap slot, becomes admin
        //   - subsequent user → only if the email is on the whitelist
        // Otherwise the server returns FORBIDDEN with a clear message,
        // which we surface verbatim. better-auth has autoSignIn on, so a
        // successful sign-up sets the session cookie in the same
        // response — no second round-trip.
        const name = email.includes('@') ? email.slice(0, email.indexOf('@')) : email;
        const res = await authClient.signUp.email({ email, password, name });
        if (res.error) throw new Error(res.error.message || 'Sign-up failed');
      } else {
        const res = await authClient.signIn.email({ email, password });
        if (res.error) throw new Error(res.error.message || 'Sign-in failed');
      }
      // Session cookie is set; ask App to re-read the session store so it
      // re-renders into the dashboard. No full-page reload — keeps the SPA
      // state intact.
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSocial = async (provider: 'github' | 'google') => {
    setError(null);
    setBusy(true);
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: '/',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const onPasskey = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await authClient.signIn.passkey();
      if (res?.error) throw new Error(res.error.message || 'Passkey sign-in failed');
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background font-sans antialiased px-6">
      <Card className="w-full max-w-sm p-6">
        <div className="flex items-center gap-3 mb-6">
          <VantageLogo className="h-9 w-9 shrink-0" />
          <div>
            <div className="font-serif text-xl font-semibold leading-tight">Vantage</div>
            <div className="font-mono text-[11px] text-muted-foreground mt-0.5">
              {authMode === 'signup' ? 'create your account' : 'sign in to continue'}
            </div>
          </div>
        </div>

        {method === 'password' && (
          <form onSubmit={onPassword} className="space-y-3">
            <label className="block">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                Email
              </div>
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="block">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                {authMode === 'signup' ? 'Create a password' : 'Password'}
              </div>
              <Input
                type="password"
                autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={busy} className="w-full">
              {busy
                ? authMode === 'signup'
                  ? 'Creating account…'
                  : 'Signing in…'
                : authMode === 'signup'
                  ? 'Create account'
                  : 'Sign in'}
            </Button>
            <button
              type="button"
              className="w-full text-[11px] font-mono text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
              onClick={() => {
                setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
                setError(null);
              }}
            >
              {authMode === 'signin'
                ? "Don't have an account? Create one"
                : 'Have an account already? Sign in'}
            </button>
          </form>
        )}

        {method === 'passkey' && (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Use a previously-registered passkey (Touch ID, Windows Hello, or a hardware key).
            </div>
            <Button onClick={onPasskey} disabled={busy} className="w-full">
              {busy ? 'Waiting for authenticator…' : 'Sign in with passkey'}
            </Button>
          </div>
        )}

        <button
          type="button"
          className="mt-2 w-full text-[11px] font-mono text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
          onClick={() => setMethod(method === 'password' ? 'passkey' : 'password')}
        >
          {method === 'password' ? 'Use a passkey instead' : 'Use email + password instead'}
        </button>

        <div className="my-5 flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            or
          </span>
          <Separator className="flex-1" />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={() => onSocial('github')} disabled={busy}>
            GitHub
          </Button>
          <Button variant="outline" onClick={() => onSocial('google')} disabled={busy}>
            Google
          </Button>
        </div>

        {error && (
          <div
            className={cn(
              'mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2',
              'font-mono text-[11px] text-destructive',
            )}
          >
            {error}
          </div>
        )}
      </Card>
    </div>
  );
}
