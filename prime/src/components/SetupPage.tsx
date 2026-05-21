import * as React from 'react';
import { authClient } from '@/auth';
import { Button, Card, Input, Separator } from './ui/primitives';
import { VantageLogo } from './ui/brand';
import { cn } from '@/lib/utils';

/**
 * Shown when the auth service reports no users exist yet. Whoever finishes
 * this form first becomes the single admin — any future sign-up attempts
 * get rejected server-side.
 */
export function SetupPage({ onDone }: { onDone: () => void }) {
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setBusy(true);
    try {
      const res = await authClient.signUp.email({ email, password, name });
      if (res.error) throw new Error(res.error.message || 'Setup failed');
      // emailAndPassword.autoSignIn is on in the server config, so a session
      // cookie is already set. Tell App that bootstrap is complete and to
      // refetch the session — App routes from Setup → Dashboard without a
      // full-page reload.
      onDone();
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
      await authClient.signIn.social({ provider, callbackURL: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background font-sans antialiased px-6">
      <Card className="w-full max-w-sm p-6">
        <div className="flex items-center gap-3 mb-2">
          <VantageLogo className="h-9 w-9 shrink-0" />
          <div>
            <div className="font-serif text-xl font-semibold leading-tight">Vantage</div>
            <div className="font-mono text-[11px] text-muted-foreground mt-0.5">
              first-time setup
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground mb-5">
          Create your admin account. You'll be the only user — further sign-ups are blocked.
        </p>

        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
              Name
            </div>
            <Input
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
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
              Password
            </div>
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="block">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
              Confirm password
            </div>
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Creating account…' : 'Create admin account'}
          </Button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            or use
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
