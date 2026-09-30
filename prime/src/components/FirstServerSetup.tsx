import * as React from 'react';
import { addServer, type ServerSummary } from '@/api';
import { Button, Card, Input } from './ui/primitives';
import { VantageLogo } from './ui/brand';
import { cn } from '@/lib/utils';
import { authClient } from '@/auth';

/**
 * Shown after login when the user's server registry is empty. The auth
 * service stores per-user server entries; new accounts start with zero, so
 * we route them through this focused form instead of dropping them into a
 * dashboard with nothing to render. Visually mirrors SetupPage so the
 * onboarding path feels coherent: create admin → add first server →
 * dashboard.
 */
export function FirstServerSetup({
  userEmail,
  onAdded,
}: {
  userEmail: string;
  onAdded: (s: ServerSummary) => void;
}) {
  const [name, setName] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const added = await addServer({
        name: name.trim(),
        url: url.trim().replace(/\/$/, ''),
        token,
      });
      onAdded(added);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    await authClient.signOut();
    // Reload so App.tsx re-runs the auth-status check and lands on Login.
    window.location.assign('/');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background font-sans antialiased px-6">
      <Card className="w-full max-w-md p-6">
        <div className="flex items-center gap-3 mb-2">
          <VantageLogo className="h-9 w-9 shrink-0" />
          <div>
            <div className="font-serif text-xl font-semibold leading-tight">Vantage</div>
            <div className="font-mono text-[11px] text-muted-foreground mt-0.5">
              add your first server
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground mb-5">
          Welcome, <span className="font-mono">{userEmail}</span>. Point this dashboard at a
          running vantage-outpost to start collecting metrics. The URL and the outpost's
          shared-secret token are stored encrypted; only this browser session can see
          them in transit.
        </p>

        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
              Name
              <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                a short label shown in the switcher
              </span>
            </div>
            <Input
              autoFocus
              placeholder="e.g. homelab"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="block">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
              URL
              <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                the outpost's base URL — e.g. <span className="font-mono">http://100.64.0.5:8080</span>
              </span>
            </div>
            <Input
              type="url"
              placeholder="http://host:8080"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>

          <label className="block">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
              Token
              <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                <span className="font-mono">VANTAGE_OUTPOST_TOKEN</span> from the outpost's env
              </span>
            </div>
            <Input
              type="password"
              autoComplete="off"
              placeholder="shared secret"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>

          <Button
            type="submit"
            disabled={busy || !name || !url || !token}
            className="w-full"
          >
            {busy ? 'Probing outpost…' : 'Add server'}
          </Button>
        </form>

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

        <div className="mt-5 flex items-center justify-between text-[11px] text-muted-foreground">
          <a
            className="hover:text-foreground"
            href="https://github.com/anthropics/vantage-dashboard#installing-an-outpost"
            target="_blank"
            rel="noreferrer"
          >
            How do I run an outpost?
          </a>
          <button
            type="button"
            onClick={onSignOut}
            className="font-mono uppercase tracking-wider hover:text-foreground"
          >
            sign out
          </button>
        </div>
      </Card>
    </div>
  );
}
