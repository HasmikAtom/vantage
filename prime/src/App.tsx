import * as React from 'react';
import { fetchServers, type ServerSummary } from './api';
import { useEventStream } from './hooks/useEventStream';
import { useFloatingTooltip } from './hooks/useTooltip';
import { hostFromServerURL } from './lib/utils';
import type { DashboardSnapshot, Tunnel } from './types';
import { AppHeader } from './components/AppHeader';
import { TunnelDialog } from './components/TunnelDialog';
// Tab components are code-split: each becomes its own chunk so the
// initial bundle only carries the shell + whatever tab the user lands
// on. The named-export → default-export adapter on each lazy() call is
// the standard workaround for React.lazy's hard requirement on default
// exports — we keep the named exports at the source so unit tests and
// future static imports still work.
const OverviewTab = React.lazy(() =>
  import('./components/tabs/OverviewTab').then((m) => ({ default: m.OverviewTab })),
);
const ContainersTab = React.lazy(() =>
  import('./components/tabs/ContainersTab').then((m) => ({ default: m.ContainersTab })),
);
const NetworkTab = React.lazy(() =>
  import('./components/tabs/NetworkTab').then((m) => ({ default: m.NetworkTab })),
);
const StorageTab = React.lazy(() =>
  import('./components/tabs/StorageTab').then((m) => ({ default: m.StorageTab })),
);
const UsersTab = React.lazy(() =>
  import('./components/tabs/UsersTab').then((m) => ({ default: m.UsersTab })),
);
const FilesTab = React.lazy(() =>
  import('./components/tabs/FilesTab').then((m) => ({ default: m.FilesTab })),
);

// Centred placeholder shown while a lazy tab chunk is loading. Plain
// text keeps it cheap — no extra dependency on the spinner library — and
// most chunks are small enough that the user sees this for <100ms on a
// fresh page load. Subsequent tab switches are instant (chunk cached).
function TabLoading() {
  return (
    <div className="flex items-center justify-center py-16 text-xs font-mono text-muted-foreground">
      Loading…
    </div>
  );
}
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import {
  ActivityIcon,
  FileTextIcon,
  HardDriveIcon,
  NetworkIcon,
  RadioIcon,
  ServerIcon,
  UsersIcon,
} from './components/ui/icons';
import type { ThemeMode } from './components/ui/theme-toggle';
import { useSession } from './auth';
import { LoginPage } from './components/LoginPage';
import { SetupPage } from './components/SetupPage';
import { SettingsPage } from './components/SettingsPage';
import { FirstServerSetup } from './components/FirstServerSetup';
import { StatusBar } from './components/StatusBar';
import { ErrorBoundary } from './components/ErrorBoundary';

// Top-level routing — three possible states, evaluated in this order:
//   1. /auth/_status says no users exist → first-time SetupPage
//   2. signed-in session present              → Dashboard
//   3. otherwise                              → LoginPage
//
// Hooks are isolated inside <Dashboard /> so they only mount once the user
// is authenticated (avoids React's "hooks order changed" complaints).
export default function App() {
  const [bootstrapped, setBootstrapped] = React.useState<boolean | null>(null);

  // /auth/_status decides Setup vs Login on first paint. AbortController
  // cancels the in-flight request on unmount instead of letting it land in
  // a dead component.
  React.useEffect(() => {
    const ctrl = new AbortController();
    fetch('/auth/_status', { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((j: { bootstrapped: boolean }) => {
        setBootstrapped(j.bootstrapped);
      })
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name === 'AbortError') return;
        setBootstrapped(true); // fail closed: show login, not setup
      });
    return () => {
      ctrl.abort();
    };
  }, []);

  const session = useSession();

  // After signin/signup the auth client sets the session cookie. Re-read
  // the session store so App re-renders into the Dashboard branch without
  // a full-page reload (preserves devtools, in-memory caches, scroll, …).
  const refreshSession = React.useCallback(() => {
    void session.refetch();
  }, [session]);

  if (bootstrapped === null || session.isPending) {
    return <div className="min-h-screen bg-background" />;
  }
  if (!bootstrapped) {
    return (
      <SetupPage
        onDone={() => {
          setBootstrapped(true);
          refreshSession();
        }}
      />
    );
  }
  if (!session.data) {
    return <LoginPage onSignedIn={refreshSession} />;
  }
  // Boundary scoped to the authenticated dashboard tree so a throwing tab
  // doesn't kill the shell. Auth/Setup/Login paths stay outside — we don't
  // want to swallow errors that should bounce the user back to login.
  return (
    <ErrorBoundary label="the dashboard">
      <Dashboard userEmail={session.data.user.email} />
    </ErrorBoundary>
  );
}

// Names of the dashboard's top-level tabs. The hash on the URL mirrors this
// so a refresh / shared link lands on the same tab the user was viewing
// instead of always snapping back to Overview. Any other hash value falls
// back to 'overview' on parse.
const TAB_NAMES = ['overview', 'containers', 'network', 'storage', 'users', 'files'] as const;
type TabName = (typeof TAB_NAMES)[number];

function parseHashTab(): TabName {
  if (typeof window === 'undefined') return 'overview';
  // Tabs may carry per-tab state after a ":" (e.g. "#files:/etc/hosts").
  // Strip everything from the colon onward so the tab match still works.
  const h = window.location.hash.replace(/^#/, '').split(':')[0] ?? '';
  return (TAB_NAMES as readonly string[]).includes(h) ? (h as TabName) : 'overview';
}

function Dashboard({ userEmail }: { userEmail: string }) {
  const [themeMode, setThemeMode] = React.useState<ThemeMode>(
    () => (localStorage.getItem('vantage-theme') as ThemeMode) || 'dark',
  );
  // Hash-backed tab state. Initial value comes from window.location.hash
  // so a hard refresh keeps the user on the same tab. Use replaceState
  // (not pushState) on tab clicks so the browser back button still leaves
  // the dashboard rather than stepping through tab history.
  const [tab, setTabState] = React.useState<TabName>(() => parseHashTab());
  const setTab = React.useCallback((next: string) => {
    if (!(TAB_NAMES as readonly string[]).includes(next)) return;
    const tabName = next as TabName;
    setTabState(tabName);
    if (window.location.hash !== `#${tabName}`) {
      window.history.replaceState(null, '', `#${tabName}`);
    }
  }, []);

  // Sync state from external hash changes (browser back/forward, manual edit
  // in the address bar). Tab-click updates use replaceState, which does NOT
  // fire hashchange, so this listener is exclusively for outside-the-app
  // navigation.
  React.useEffect(() => {
    const onHash = () => setTabState(parseHashTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // On first mount, normalize the URL: if the user landed without a hash
  // (or with a garbage one), write the resolved tab back so the URL is a
  // shareable, accurate reflection of the visible state.
  React.useEffect(() => {
    if (window.location.hash !== `#${tab}`) {
      window.history.replaceState(null, '', `#${tab}`);
    }
    // tab is captured at mount on purpose — this effect only fires once;
    // subsequent tab changes are handled by setTab above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [tunnel, setTunnel] = React.useState<Tunnel | null>(null);
  const [view, setView] = React.useState<'dashboard' | 'settings'>('dashboard');
  // The registry lives on the auth service per user; empty until they add
  // their first server. We track loaded state separately so we don't flash
  // the first-run page before the initial fetch lands.
  const [servers, setServers] = React.useState<ServerSummary[]>([]);
  const [serversLoaded, setServersLoaded] = React.useState(false);
  const [activeServerId, setActiveServerId] = React.useState<string>(
    () => localStorage.getItem('vantage-active-server') || '',
  );
  const { tt, Portal: tooltipPortal } = useFloatingTooltip();

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', themeMode === 'dark');
    localStorage.setItem('vantage-theme', themeMode);
  }, [themeMode]);

  React.useEffect(() => {
    localStorage.setItem('vantage-active-server', activeServerId);
  }, [activeServerId]);

  // Stable reference so React.memo'd children (StatusBar) don't re-render
  // just because we made a fresh arrow each tick. setTab is itself
  // useCallback-stable (see above), so listing it as a dep doesn't bust
  // memoization — it just satisfies react-hooks/exhaustive-deps.
  const jumpToOverview = React.useCallback(() => setTab('overview'), [setTab]);

  const refreshServers = React.useCallback(async () => {
    try {
      const list = await fetchServers();
      setServers(list);
      // If the active server vanished (removed elsewhere) or was never
      // set, pick the first server in the list so the SSE stream has a
      // target. Empty list → empty activeServerId; the branch below
      // renders FirstServerSetup instead.
      if (!activeServerId || !list.some((s) => s.id === activeServerId)) {
        setActiveServerId(list[0]?.id ?? '');
      }
    } catch {
      // leave the existing list in place
    } finally {
      setServersLoaded(true);
    }
  }, [activeServerId]);

  React.useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  // Dashboard data flows through Server-Sent Events: the backend pushes a
  // fresh snapshot only when its internal version actually advances, so an
  // idle dashboard sends ~zero traffic instead of polling every 2s. Empty
  // url leaves the connection unopened (FirstServerSetup branch handles
  // the no-server case below).
  const streamUrl = activeServerId
    ? `/api/servers/${encodeURIComponent(activeServerId)}/stream`
    : null;
  const { data: snapshot, error, loading } = useEventStream<DashboardSnapshot>(
    streamUrl,
    activeServerId,
  );

  // serverHost is the hostname portion of the active server's registered
  // URL — used by container "open in browser" links so they target the
  // host the container actually runs on, not the dashboard's domain
  // (which is critical when accessing the dashboard via a Cloudflare
  // tunnel that doesn't route arbitrary container ports). Empty string
  // when no server is selected; the URL helpers fall back to
  // window.location.hostname in that case.
  const serverHost = React.useMemo(() => {
    const s = servers.find((x) => x.id === activeServerId);
    return s ? hostFromServerURL(s.url) : '';
  }, [servers, activeServerId]);

  // Wait for the initial registry fetch before deciding between dashboard
  // and first-run flow — otherwise we flash FirstServerSetup on every load.
  if (!serversLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground font-mono text-xs">
        Loading…
      </div>
    );
  }

  // Empty registry → first-run flow. Wins over view='settings' so users
  // who just deleted their last server land here rather than on a
  // managing-nothing settings page.
  if (servers.length === 0) {
    return (
      <FirstServerSetup
        userEmail={userEmail}
        onAdded={(s) => {
          setActiveServerId(s.id);
          void refreshServers();
        }}
      />
    );
  }

  if (view === 'settings') {
    return (
      <SettingsPage
        servers={servers}
        activeServerId={activeServerId}
        onSelectServer={setActiveServerId}
        onServersChanged={refreshServers}
        onBack={() => setView('dashboard')}
      />
    );
  }

  if (loading && !snapshot) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground font-mono text-xs">
        Connecting to vantage-prime…
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-destructive font-mono text-xs">
        API unreachable: {error.message}
      </div>
    );
  }

  if (!snapshot) return null;

  return (
    <div className="min-h-screen bg-background text-foreground font-sans antialiased">
      <Tabs value={tab} onValueChange={setTab}>
        {/* Sticky chrome — header + tabs row pin to the top while the
            dashboard body below scrolls. z-40 sits below open dropdowns
            (the header's server switcher uses z-50) and the tooltip portal. */}
        <div className="sticky top-0 z-40 bg-background">
          <AppHeader
            system={snapshot.system}
            themeMode={themeMode}
            setThemeMode={setThemeMode}
            userEmail={userEmail}
            onOpenSettings={() => setView('settings')}
            servers={servers}
            activeServerId={activeServerId}
            onSelectServer={setActiveServerId}
          />
          <div className="border-b bg-card">
            <div className="flex items-center justify-between px-8 py-2">
              <TabsList className="bg-transparent p-0 gap-0.5">
                <TabsTrigger value="overview" className="data-[state=active]:bg-muted gap-1.5">
                  <ActivityIcon size={13} />
                  Overview
                </TabsTrigger>
                <TabsTrigger value="containers" className="data-[state=active]:bg-muted gap-1.5">
                  <ServerIcon size={13} />
                  Containers
                </TabsTrigger>
                <TabsTrigger value="network" className="data-[state=active]:bg-muted gap-1.5">
                  <NetworkIcon size={13} />
                  Network
                </TabsTrigger>
                <TabsTrigger value="storage" className="data-[state=active]:bg-muted gap-1.5">
                  <HardDriveIcon size={13} />
                  Storage
                </TabsTrigger>
                <TabsTrigger value="users" className="data-[state=active]:bg-muted gap-1.5">
                  <UsersIcon size={13} />
                  Users
                </TabsTrigger>
                <TabsTrigger value="files" className="data-[state=active]:bg-muted gap-1.5">
                  <FileTextIcon size={13} />
                  Files
                </TabsTrigger>
              </TabsList>
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
                <RadioIcon size={11} className="text-primary" />
                <span className="text-primary">{error ? 'Stale' : 'Live'}</span>
                <span>· streaming</span>
              </div>
            </div>
          </div>
        </div>

        <main className="px-8 py-6">
          <StatusBar
            services={snapshot.services ?? []}
            updates={snapshot.updates}
            onJumpToServices={jumpToOverview}
          />
          <TabsContent value="overview" className="mt-0">
            <React.Suspense fallback={<TabLoading />}>
              <OverviewTab
                snapshot={snapshot}
                tt={tt}
                onTunnelClick={setTunnel}
                activeServerId={activeServerId}
                serverHost={serverHost}
              />
            </React.Suspense>
          </TabsContent>
          <TabsContent value="containers" className="mt-0">
            <React.Suspense fallback={<TabLoading />}>
              <ContainersTab snapshot={snapshot} tt={tt} serverId={activeServerId} serverHost={serverHost} />
            </React.Suspense>
          </TabsContent>
          <TabsContent value="network" className="mt-0">
            <React.Suspense fallback={<TabLoading />}>
              <NetworkTab
                snapshot={snapshot}
                tt={tt}
                onTunnelClick={setTunnel}
                activeServerId={activeServerId}
              />
            </React.Suspense>
          </TabsContent>
          <TabsContent value="storage" className="mt-0">
            <React.Suspense fallback={<TabLoading />}>
              <StorageTab snapshot={snapshot} />
            </React.Suspense>
          </TabsContent>
          <TabsContent value="users" className="mt-0">
            <React.Suspense fallback={<TabLoading />}>
              <UsersTab snapshot={snapshot} tt={tt} />
            </React.Suspense>
          </TabsContent>
          <TabsContent value="files" className="mt-0">
            <React.Suspense fallback={<TabLoading />}>
              <FilesTab serverId={activeServerId} />
            </React.Suspense>
          </TabsContent>
        </main>
      </Tabs>

      {tooltipPortal}
      <TunnelDialog tunnel={tunnel} onClose={() => setTunnel(null)} />
    </div>
  );
}
