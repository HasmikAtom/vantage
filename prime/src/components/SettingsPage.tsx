import * as React from 'react';
import {
  fetchSettings,
  saveCloudflareSettings,
  clearCloudflareSettings,
  addServer,
  removeServer,
  addWhitelist,
  listWhitelist,
  removeWhitelist,
  fetchGateVersion,
  fetchOutpostVersion,
  type SettingsView,
  type ServerSummary,
  type VersionInfo,
} from '@/api';
import type { WhitelistEntry } from '@/types';
import { PRIME_VERSION } from '@/version';
import { Badge, Button, Card, Input, Separator } from './ui/primitives';
import { ChevronRightIcon, TrashIcon } from './ui/icons';
import { useCan } from '@/auth';
import { cn } from '@/lib/utils';

type RefreshUnit = 'seconds' | 'minutes' | 'hours';

const UNIT_TO_SECS: Record<RefreshUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
};

// pickUnit picks the chunkiest natural unit for a given second-count, so
// "300" displays as "5 minutes" rather than "300 seconds".
function pickUnit(seconds: number): RefreshUnit {
  if (seconds > 0 && seconds % 3600 === 0) return 'hours';
  if (seconds > 0 && seconds % 60 === 0) return 'minutes';
  return 'seconds';
}

interface Props {
  servers: ServerSummary[];
  activeServerId: string;
  onSelectServer: (id: string) => void;
  onServersChanged: () => void;
  onBack: () => void;
}

export function SettingsPage({
  servers,
  activeServerId,
  onSelectServer,
  onServersChanged,
  onBack,
}: Props) {
  const [view, setView] = React.useState<SettingsView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Cloudflare form-local state.
  const [apiToken, setApiToken] = React.useState('');
  const [accountId, setAccountId] = React.useState('');
  const [tunnelId, setTunnelId] = React.useState('');
  const [refreshValue, setRefreshValue] = React.useState<string>('');
  const [refreshUnit, setRefreshUnit] = React.useState<RefreshUnit>('minutes');
  const [saving, setSaving] = React.useState(false);
  const [saveMsg, setSaveMsg] = React.useState<string | null>(null);
  const [refreshErr, setRefreshErr] = React.useState<string | null>(null);

  // Add-server form state.
  const [newName, setNewName] = React.useState('');
  const [newURL, setNewURL] = React.useState('');
  const [newToken, setNewToken] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [addErr, setAddErr] = React.useState<string | null>(null);
  const [removingId, setRemovingId] = React.useState<string | null>(null);

  // Refetch settings whenever the active server changes — Cloudflare creds
  // live with each outpost, so the panel always reflects the current target.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaveMsg(null);
    setRefreshErr(null);
    setApiToken('');
    fetchSettings(activeServerId)
      .then((v) => {
        if (cancelled) return;
        setView(v);
        setAccountId(v.cloudflareAccountId);
        setTunnelId(v.cloudflareTunnelId);
        const u = pickUnit(v.cloudflareRefreshSecs);
        setRefreshUnit(u);
        setRefreshValue(String(v.cloudflareRefreshSecs / UNIT_TO_SECS[u]));
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [activeServerId]);

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveMsg(null);
    setRefreshErr(null);
    setSaving(true);
    try {
      const parsed = parseFloat(refreshValue);
      const totalSecs =
        Number.isFinite(parsed) && parsed > 0
          ? Math.round(parsed * UNIT_TO_SECS[refreshUnit])
          : undefined;
      const res = await saveCloudflareSettings(activeServerId, {
        ...(apiToken ? { apiToken } : {}),
        accountId,
        tunnelId,
        ...(totalSecs !== undefined ? { refreshSecs: totalSecs } : {}),
      });
      setView(res.view);
      // Re-display in the chunkiest unit the saved value fits, in case the
      // outpost clamped or normalised what we sent.
      const u = pickUnit(res.view.cloudflareRefreshSecs);
      setRefreshUnit(u);
      setRefreshValue(String(res.view.cloudflareRefreshSecs / UNIT_TO_SECS[u]));
      setApiToken('');
      setSaveMsg('Saved.');
      if (res.refresh) setRefreshErr(res.refresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onClear = async () => {
    if (!confirm('Clear all Cloudflare credentials?')) return;
    setSaving(true);
    setSaveMsg(null);
    setRefreshErr(null);
    try {
      await clearCloudflareSettings(activeServerId);
      const fresh = await fetchSettings(activeServerId);
      setView(fresh);
      setApiToken('');
      setAccountId('');
      setTunnelId('');
      const u = pickUnit(fresh.cloudflareRefreshSecs);
      setRefreshUnit(u);
      setRefreshValue(String(fresh.cloudflareRefreshSecs / UNIT_TO_SECS[u]));
      setSaveMsg('Cleared.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onAddServer = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddErr(null);
    setAdding(true);
    try {
      const added = await addServer({ name: newName, url: newURL, token: newToken });
      setNewName('');
      setNewURL('');
      setNewToken('');
      onServersChanged();
      onSelectServer(added.id);
    } catch (err) {
      setAddErr(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const onRemoveServer = async (id: string) => {
    if (!confirm('Remove this server?')) return;
    setRemovingId(id);
    try {
      await removeServer(id);
      // If they removed the active server, clear the selection so App.tsx's
      // refreshServers picks a remaining one (or shows the empty-registry
      // state if none are left).
      if (id === activeServerId) onSelectServer('');
      onServersChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingId(null);
    }
  };

  const activeName = servers.find((s) => s.id === activeServerId)?.name ?? activeServerId;

  return (
    <div className="min-h-screen bg-background text-foreground font-sans antialiased">
      <header className="border-b bg-card">
        <div className="flex items-center gap-3 px-8 py-3.5">
          <button
            onClick={onBack}
            className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            ← back to dashboard
          </button>
          <Separator orientation="vertical" className="h-5" />
          <div className="font-serif text-lg font-semibold leading-tight tracking-tight">
            Settings
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-8 py-8 space-y-6">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
            {error}
          </div>
        )}

        {/* ----- Servers panel ----- */}
        <Card className="p-5 space-y-4">
          <div className="flex items-baseline justify-between">
            <div>
              <h2 className="font-serif text-lg font-semibold tracking-tight">Servers</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Add another vantage-outpost to monitor it from this dashboard. You'll need its base URL
                and the <span className="font-mono">VANTAGE_OUTPOST_TOKEN</span> it was started with —
                stored encrypted on the gate service.
              </p>
            </div>
          </div>

          <Separator />

          <ul className="divide-y rounded-md border">
            {servers.length === 0 && (
              <li className="px-3 py-3 font-mono text-[11px] text-muted-foreground">
                No servers yet. Add one below.
              </li>
            )}
            {servers.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-3 py-2">
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] truncate">{s.name}</span>
                    {s.id === activeServerId && (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-primary">
                        active
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground/80 truncate">
                    {s.url}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {s.id !== activeServerId && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onSelectServer(s.id)}
                    >
                      Select
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onRemoveServer(s.id)}
                    disabled={removingId === s.id}
                  >
                    {removingId === s.id ? 'Removing…' : 'Remove'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>

          <Separator />

          <form onSubmit={onAddServer} className="space-y-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Add a server
            </div>
            <label className="block">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                Name
              </div>
              <Input
                placeholder="e.g. homelab"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
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
                placeholder="http://host:8080"
                value={newURL}
                onChange={(e) => setNewURL(e.target.value)}
              />
            </label>
            <label className="block">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                Token
                <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                  the outpost's <span className="font-mono">VANTAGE_OUTPOST_TOKEN</span> — stored encrypted, never sent back to the browser
                </span>
              </div>
              <Input
                type="password"
                autoComplete="off"
                placeholder="shared secret from the outpost's env"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
              />
            </label>
            <div className="flex items-center gap-2 pt-2">
              <Button type="submit" disabled={adding || !newName || !newURL || !newToken}>
                {adding ? 'Probing…' : 'Add server'}
              </Button>
              {addErr && (
                <span className="font-mono text-[11px] text-destructive">{addErr}</span>
              )}
            </div>
          </form>
        </Card>

        {/* ----- Email whitelist (admin-only) ----- */}
        <WhitelistPanel />

        {/* ----- Cloudflare panel (scoped to active server) ----- */}
        <Card className="p-5 space-y-4">
          <div className="flex items-baseline justify-between">
            <div>
              <h2 className="font-serif text-lg font-semibold tracking-tight">
                Cloudflare tunnels
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Credentials for <span className="font-mono">{activeName}</span>. Encrypted at
                rest on that outpost and never sent back to the browser.
              </p>
            </div>
            {loading ? (
              <Badge variant="muted">Loading…</Badge>
            ) : view?.cloudflareTokenSet ? (
              <Badge variant="success">Token saved</Badge>
            ) : (
              <Badge variant="muted">Not configured</Badge>
            )}
          </div>

          <Separator />

          <form onSubmit={onSave} className="space-y-3">
            <label className="block">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                API token
                <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                  scope: Account → Cloudflare Tunnel: Read
                </span>
              </div>
              <Input
                type="password"
                autoComplete="off"
                placeholder={view?.cloudflareTokenSet ? '(leave blank to keep existing)' : 'Bearer token'}
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
              />
            </label>

            <label className="block">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                Account ID
              </div>
              <Input
                placeholder="32 hex chars"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              />
            </label>

            <label className="block">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                Tunnel ID
                <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                  optional — leave blank to fetch all tunnels in the account
                </span>
              </div>
              <Input
                placeholder="UUID"
                value={tunnelId}
                onChange={(e) => setTunnelId(e.target.value)}
              />
            </label>

            <label className="block">
              <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
                Refresh interval
                <span className="ml-2 normal-case tracking-normal text-muted-foreground/70">
                  how often to poll the Cloudflare API (min 30s, max 24h, default 5m)
                </span>
              </div>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={refreshUnit === 'seconds' ? 30 : 1}
                  step={refreshUnit === 'seconds' ? 5 : 1}
                  value={refreshValue}
                  onChange={(e) => setRefreshValue(e.target.value)}
                  className="flex-1"
                />
                <select
                  value={refreshUnit}
                  onChange={(e) => setRefreshUnit(e.target.value as RefreshUnit)}
                  className={cn(
                    'h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  )}
                >
                  <option value="seconds">seconds</option>
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                </select>
              </div>
            </label>

            <div className="flex items-center gap-2 pt-2">
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {view?.cloudflareTokenSet && (
                <Button type="button" variant="outline" onClick={onClear} disabled={saving}>
                  Clear
                </Button>
              )}
              {saveMsg && (
                <span className="font-mono text-[11px] text-primary">{saveMsg}</span>
              )}
            </div>

            {refreshErr && (
              <div
                className={cn(
                  'mt-1 rounded-md border border-warn/40 bg-warn/10 px-3 py-2',
                  'font-mono text-[11px] text-warn',
                )}
              >
                Saved, but the test fetch failed: {refreshErr}
              </div>
            )}
          </form>

          <Separator />

          <div className="text-[11px] text-muted-foreground space-y-1.5">
            <div className="flex items-center gap-1">
              <ChevronRightIcon size={11} />
              Generate an API token in the{' '}
              <a
                className="underline"
                href="https://dash.cloudflare.com/profile/api-tokens"
                target="_blank"
                rel="noreferrer"
              >
                Cloudflare dashboard
              </a>
              .
            </div>
            <div className="flex items-center gap-1">
              <ChevronRightIcon size={11} />
              Use the <span className="font-mono">Cloudflare Tunnel: Read</span> account
              scope.
            </div>
            <div className="flex items-center gap-1">
              <ChevronRightIcon size={11} />
              Tunnels appear on the Network tab within a few seconds of saving.
            </div>
          </div>
        </Card>

        {/* ----- About (prime + gate + outpost versions) ----- */}
        <AboutPanel servers={servers} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WhitelistPanel — admin-only. Lets the admin pre-authorize email addresses
// so a whitelisted person can sign in (via the regular login form) and
// pick a password on first try.
//
// Renders nothing for non-admin users — the panel is gated client-side
// here AND server-side by the /api/whitelist handlers. The client gate is
// purely about not showing useless UI; the security boundary is the
// server.
// ---------------------------------------------------------------------------

function WhitelistPanel() {
  const isAdmin = useCan('admin');
  const [items, setItems] = React.useState<WhitelistEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [newEmail, setNewEmail] = React.useState('');
  const [newRole, setNewRole] = React.useState<'viewer' | 'operator' | 'admin'>('viewer');
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listWhitelist());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!isAdmin) return;
    void refresh();
  }, [isAdmin, refresh]);

  if (!isAdmin) return null;

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEmail.includes('@')) {
      setError('Enter a valid email.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addWhitelist(newEmail.trim(), newRole);
      setNewEmail('');
      setNewRole('viewer');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="font-serif text-lg font-semibold tracking-tight">Authorized emails</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pre-authorize emails so they can sign in and create a password on first try.
            The recorded role is applied when they sign up.
          </p>
        </div>
      </div>

      <Separator />

      <ul className="divide-y rounded-md border">
        {loading ? (
          <li className="px-3 py-3 font-mono text-[11px] text-muted-foreground">loading…</li>
        ) : items.length === 0 ? (
          <li className="px-3 py-3 font-mono text-[11px] text-muted-foreground">
            No authorized emails yet. Add one below.
          </li>
        ) : (
          items.map((it) => (
            <li key={it.email} className="flex items-center justify-between px-3 py-2 gap-3">
              <div className="flex flex-col min-w-0">
                <span className="font-mono text-xs truncate">{it.email}</span>
                <span className="font-mono text-[10px] text-muted-foreground mt-0.5">
                  added {formatRel(it.addedAt)}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="muted" className="rounded-sm">{it.role}</Badge>
                <Button
                  size="iconSm"
                  variant="ghost"
                  disabled={busy}
                  title="Remove from whitelist"
                  onClick={async () => {
                    if (!confirm(`Remove ${it.email} from the whitelist? Existing accounts keep their access — this only blocks future sign-ups for that email.`)) {
                      return;
                    }
                    setBusy(true);
                    setError(null);
                    try {
                      await removeWhitelist(it.email);
                      await refresh();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <TrashIcon size={12} />
                </Button>
              </div>
            </li>
          ))
        )}
      </ul>

      <form onSubmit={onAdd} className="grid grid-cols-[1fr_auto_auto] gap-2 items-end">
        <label className="block">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
            Email
          </div>
          <Input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="person@example.com"
            className="text-xs"
          />
        </label>
        <label className="block">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
            Role
          </div>
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as 'viewer' | 'operator' | 'admin')}
            className="h-9 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="viewer">viewer</option>
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <Button type="submit" size="sm" disabled={busy || !newEmail}>
          {busy ? 'Adding…' : 'Add'}
        </Button>
      </form>

      {error && (
        <div className="font-mono text-[11px] text-destructive">{error}</div>
      )}

      <div className="space-y-1.5 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <ChevronRightIcon size={11} />
          When they go to the login page and type their email, the password field
          turns into "Create a password" automatically.
        </div>
        <div className="flex items-center gap-1">
          <ChevronRightIcon size={11} />
          Removing an email here doesn't sign them out if they're already
          signed up — it only blocks future sign-ups for that address.
        </div>
      </div>
    </Card>
  );
}

function formatRel(unixMs: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// AboutPanel — surfaces the monorepo version each running service is reporting
// so an operator can confirm at a glance which build prime, gate, and every
// registered outpost are on. Useful when an outpost drifts (someone forgot to
// pull on a remote box) or when debugging wire-compat issues — same minor
// version across prime/gate/outpost is the supported configuration.
// ---------------------------------------------------------------------------

type RemoteVersion = { loading: true } | { error: string } | VersionInfo;

function AboutPanel({ servers }: { servers: ServerSummary[] }) {
  const [gate, setGate] = React.useState<RemoteVersion>({ loading: true });
  const [outposts, setOutposts] = React.useState<Record<string, RemoteVersion>>({});

  React.useEffect(() => {
    let cancelled = false;
    fetchGateVersion()
      .then((v) => {
        if (!cancelled) setGate(v);
      })
      .catch((e) => {
        if (!cancelled) setGate({ error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    // Seed the loading state for every current server up front so the
    // table renders a row per outpost immediately. Resolves to the
    // version (or per-outpost error) as each fetch settles.
    setOutposts(Object.fromEntries(servers.map((s) => [s.id, { loading: true } as RemoteVersion])));
    for (const s of servers) {
      fetchOutpostVersion(s.id)
        .then((v) => {
          if (cancelled) return;
          setOutposts((prev) => ({ ...prev, [s.id]: v }));
        })
        .catch((e) => {
          if (cancelled) return;
          setOutposts((prev) => ({
            ...prev,
            [s.id]: { error: e instanceof Error ? e.message : String(e) },
          }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [servers]);

  return (
    <Card className="p-5 space-y-4">
      <div>
        <h2 className="font-serif text-lg font-semibold tracking-tight">About</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Vantage ships as one monorepo; prime, gate, and every registered
          outpost should report the same version. A mismatch is the first
          thing to check when something on a remote outpost looks off.
        </p>
      </div>

      <Separator />

      <ul className="divide-y rounded-md border">
        <VersionRow label="prime" sublabel="this dashboard" value={PRIME_VERSION} />
        <VersionRow label="gate" sublabel="auth + proxy" value={gate} />
        {servers.map((s) => (
          <VersionRow
            key={s.id}
            label={`outpost · ${s.name}`}
            sublabel={s.url}
            value={outposts[s.id] ?? { loading: true }}
          />
        ))}
      </ul>
    </Card>
  );
}

function VersionRow({
  label,
  sublabel,
  value,
}: {
  label: string;
  sublabel: string;
  value: RemoteVersion | string;
}) {
  const rendered =
    typeof value === 'string' ? (
      <span className="font-mono text-xs">v{value}</span>
    ) : 'loading' in value ? (
      <span className="font-mono text-[11px] text-muted-foreground">loading…</span>
    ) : 'error' in value ? (
      <span
        className="font-mono text-[11px] text-destructive max-w-[200px] truncate"
        title={value.error}
      >
        {value.error}
      </span>
    ) : (
      <span className="font-mono text-xs">v{value.version}</span>
    );

  return (
    <li className="flex items-center justify-between px-3 py-2 gap-3">
      <div className="flex flex-col min-w-0">
        <span className="font-mono text-xs truncate">{label}</span>
        <span className="font-mono text-[10px] text-muted-foreground mt-0.5 truncate">
          {sublabel}
        </span>
      </div>
      <div className="shrink-0">{rendered}</div>
    </li>
  );
}
