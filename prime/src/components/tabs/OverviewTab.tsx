import * as React from 'react';
import type { DashboardSnapshot, Tunnel } from '@/types';
import { cn, firstContainerPortURL, formatBps, formatMem, formatProcTime, heatColor, isPositiveStatus, journalSeverity, processStateMeta, safeHref, tunnelsForContainer } from '@/lib/utils';
import { Button, Card } from '../ui/primitives';
import { StatusDot } from '../ui/status-dot';
import { ChevronRightIcon, CpuIcon, ExternalLinkIcon, HardDriveIcon, NetworkIcon, ServerIcon, ZapIcon } from '../ui/icons';
import { HeroMetric } from '../HeroMetric';
import { SectionHeader } from '../SectionHeader';
import { SensorTile } from '../SensorTile';
import { GPUDetail } from '../GPUDetail';
import { CPUDetail } from '../CPUDetail';
import { CloudflareRefreshButton } from '../CloudflareRefreshButton';
import type { FloatingTooltip } from '@/hooks/useTooltip';
import { gpuFanText } from '@/lib/gpu';

export interface OverviewTabProps {
  snapshot: DashboardSnapshot;
  tt: FloatingTooltip;
  onTunnelClick: (tunnel: Tunnel) => void;
  activeServerId: string;
  // serverHost is the hostname portion of the active server's registered
  // URL. Used by the container quick-link so we don't point at the
  // dashboard's own domain (see ContainersTab for the same reason).
  serverHost: string;
  // Failed services the user dismissed as harmless, and undoing that.
  isDismissed?: (unit: string) => boolean;
  onRestore?: (unit: string) => void;
}

// Rewrite localhost upstreams to the current host so the link works when the
// dashboard is reached over LAN. Returns undefined for non-http(s) schemes
// (ssh://, tcp://, unix:) which a browser can't open as a tab anyway, and
// for any URL that fails safeHref's protocol/userinfo checks — the service
// string is sourced from the user's Cloudflare account (writable by other
// collaborators), so we route it through safeHref before any consumer.
function browserReachableServiceURL(service: string): string | undefined {
  const m = service.match(/^(https?):\/\/([^/]+)(\/.*)?$/);
  if (!m) return undefined;
  const [, scheme, hostport, path = ''] = m;
  let host = hostport!;
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    const colon = host.indexOf(':');
    const port = colon >= 0 ? host.slice(colon) : '';
    host = window.location.hostname + port;
  }
  return safeHref(`${scheme}://${host}${path}`);
}

// Stable empty fallbacks for the `?? EMPTY_*` coalescing below. Using one
// frozen array per type means the array identity doesn't churn on every
// render when a collector hasn't populated yet, which would otherwise
// invalidate every downstream useMemo on the empty path.
const EMPTY_SENSORS: DashboardSnapshot['sensors'] = [];
const EMPTY_TUNNELS: DashboardSnapshot['tunnels'] = [];
const EMPTY_CONTAINERS: DashboardSnapshot['containers'] = [];
const EMPTY_SERVICES: DashboardSnapshot['services'] = [];
const EMPTY_DISKS: DashboardSnapshot['disks'] = [];
const EMPTY_CORES: DashboardSnapshot['cores'] = [];
const EMPTY_PROCESSES: DashboardSnapshot['processes'] = [];
const EMPTY_JOURNAL: DashboardSnapshot['journal'] = [];
const EMPTY_FILESYSTEMS: DashboardSnapshot['filesystems'] = [];
const EMPTY_DISKIO: DashboardSnapshot['diskIo'] = [];
const EMPTY_NET_INTERFACES: DashboardSnapshot['network']['interfaces'] = [];
const EMPTY_ALERTS: DashboardSnapshot['alerts'] = [];

function storagePoolStats(disks: DashboardSnapshot['disks']) {
  const total = disks.reduce((acc, d) => acc + d.total, 0);
  const used = disks.reduce((acc, d) => acc + d.used, 0);
  const pct = (used / total) * 100;
  const free = total - used;
  return {
    pct: pct.toFixed(1),
    used: (used / 1024).toFixed(1),
    free: (free / 1024).toFixed(1),
    totalTB: (total / 1024).toFixed(1),
    count: disks.length,
    hottest: disks.reduce((m, d) => Math.max(m, d.tempC), 0),
  };
}

export const OverviewTab = ({
  snapshot,
  tt,
  onTunnelClick,
  activeServerId,
  serverHost,
  isDismissed,
  onRestore,
}: OverviewTabProps) => {
  const { system, headline: h } = snapshot;
  // Coalesce — some collectors may not have populated yet on cold start,
  // or may legitimately return nothing (e.g. tunnels without CF creds).
  const sensors = snapshot.sensors ?? EMPTY_SENSORS;
  const tunnels = snapshot.tunnels ?? EMPTY_TUNNELS;
  const containers = snapshot.containers ?? EMPTY_CONTAINERS;
  const services = snapshot.services ?? EMPTY_SERVICES;
  const disks = snapshot.disks ?? EMPTY_DISKS;
  const cores = snapshot.cores ?? EMPTY_CORES;
  const processes = snapshot.processes ?? EMPTY_PROCESSES;
  const journal = snapshot.journal ?? EMPTY_JOURNAL;
  const filesystems = snapshot.filesystems ?? EMPTY_FILESYSTEMS;
  const diskIo = snapshot.diskIo ?? EMPTY_DISKIO;
  const netInterfaces = snapshot.network?.interfaces ?? EMPTY_NET_INTERFACES;
  const pressure = snapshot.pressure;
  // Process state counts. The outpost always populates a zeroed value, but
  // older outpost binaries (pre-this-rollout) may not — coalesce so the
  // chip strip stays inert instead of throwing.
  const procStates = snapshot.processStates ?? { total: 0, running: 0, sleeping: 0, diskWait: 0, stopped: 0, zombie: 0, threads: 0 };
  const alerts = snapshot.alerts ?? EMPTY_ALERTS;
  // Split open vs resolved for grouping; the engine returns open first
  // but we want an explicit count for the header chip.
  const alertsOpen = React.useMemo(() => alerts.filter((a) => !a.endedAt), [alerts]);
  const alertsResolved = React.useMemo(() => alerts.filter((a) => a.endedAt), [alerts]);

  // Reduce over all disks every tick — memoize on the disks array identity.
  const pool = React.useMemo(() => storagePoolStats(disks), [disks]);

  // Counts/slices over snapshot arrays — JSX consumes these in multiple
  // places per render; memoize so the same containers/tunnels/services
  // identity skips the re-traversal.
  const tunnelsHealthy = React.useMemo(
    () => tunnels.filter((t) => isPositiveStatus(t.status)).length,
    [tunnels],
  );
  const containersRunning = React.useMemo(
    () => containers.filter((c) => isPositiveStatus(c.status)).length,
    [containers],
  );
  const containersTop = React.useMemo(() => containers.slice(0, 6), [containers]);
  const servicesActive = React.useMemo(
    () => services.filter((s) => isPositiveStatus(s.status)).length,
    [services],
  );
  const servicesTop = React.useMemo(() => services.slice(0, 6), [services]);

  return (
    <div className="space-y-6">
      {/* compact system meta strip — replaces the old System card */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 font-mono text-[10px]">
        {(
          [
            ['Uptime', system.uptimeText],
            ['Booted', system.bootedAt],
            ['Kernel', system.kernel.replace('Linux ', '')],
            ['OS', system.os],
          ] as const
        ).map(([k, v]) => (
          <span key={k}>
            <span className="uppercase tracking-wider text-muted-foreground/60">{k}</span>{' '}
            <span className="text-foreground/85 tabular-nums">{v}</span>
          </span>
        ))}
        <span>
          <span className="uppercase tracking-wider text-muted-foreground/60">Load</span>{' '}
          {/* loadavg vs core count — 1.0 per logical CPU is "full". Color the
              1-minute number against that fraction so a quad-core at 3.8 load
              reads cool while a dual-core at the same number reads hot. */}
          <span
            className="tabular-nums"
            style={{ color: heatColor(Math.min(1, system.loadAvg[0] / Math.max(1, system.cpuCores))) }}
            title={`1m / 5m / 15m (vs ${system.cpuCores} logical CPUs)`}
          >
            {system.loadAvg[0].toFixed(2)}
          </span>{' '}
          <span className="text-foreground/85 tabular-nums">
            {system.loadAvg[1].toFixed(2)} {system.loadAvg[2].toFixed(2)}
          </span>
        </span>
        <span>
          <span className="uppercase tracking-wider text-muted-foreground/60">Swap</span>{' '}
          <span
            className="tabular-nums"
            style={{ color: heatColor(h.swap.pct / 100) }}
            title={`${h.swap.used} / ${h.swap.total} ${h.swap.unit} swap used`}
          >
            {h.swap.pct.toFixed(1)}%
          </span>{' '}
          <span className="text-muted-foreground/70 tabular-nums">
            {h.swap.used}/{h.swap.total}{h.swap.unit}
          </span>
        </span>
        <span className="ml-auto text-muted-foreground/50 tabular-nums">{system.fingerprint}</span>
      </div>

      {/* hero strip */}
      <div className="grid grid-cols-4 gap-3">
        <HeroMetric
          icon={CpuIcon}
          title="CPU"
          subtitle={system.cpuModel}
          big={h.cpu.pct.toFixed(1)}
          bigUnit="%"
          sub={
            <>
              {/* "4 cores · 8 threads" on SMT systems; collapses to just
                  "N cores" when physical == logical (no hyperthreading). */}
              {system.cpuPhysicalCores < system.cpuCores
                ? `${system.cpuPhysicalCores} cores · ${system.cpuCores} threads · ${system.cpuClock.split('·')[0]!.trim()}`
                : `${system.cpuCores} cores · ${system.cpuClock.split('·')[0]!.trim()}`}
              {h.cpu.powerW > 0 && ` · ${h.cpu.powerW.toFixed(1)} W`}
            </>
          }
          temp={h.cpu.temp}
          tempMax={95}
          sparkData={h.cpuSpark}
        />
        {(() => {
          // Nouveau (and any other driver that doesn't surface util/VRAM)
          // leaves these fields at zero. Make the difference between
          // "GPU is idle" and "the kernel won't tell us" visible.
          const utilUnavailable =
            h.gpu.driver === 'nouveau' || (h.gpu.pct === 0 && h.gpu.vram.total === 0);
          const sub = utilUnavailable
            ? `${h.gpu.powerW ? h.gpu.powerW.toFixed(1) + ' W draw' : '—'} · fan ${gpuFanText(h.gpu)}`
            : `${h.gpu.vram.used.toFixed(1)}/${h.gpu.vram.total.toFixed(0)} ${h.gpu.vram.unit} VRAM · fan ${gpuFanText(h.gpu)}`;
          const unavailableNote = utilUnavailable
            ? `Utilization / VRAM not exposed by the ${
                h.gpu.driver || 'open-source'
              } driver. The 0 isn't idle — the kernel doesn't surface this metric. See the GPU detail panel for power draw (a reliable proxy).`
            : undefined;
          return (
            <HeroMetric
              icon={ZapIcon}
              title="GPU"
              subtitle={h.gpu.name}
              big={h.gpu.pct.toFixed(1)}
              bigUnit="%"
              sub={sub}
              temp={h.gpu.temp}
              tempMax={90}
              sparkData={h.gpuSpark}
              {...(unavailableNote !== undefined ? { unavailableNote } : {})}
            />
          );
        })()}
        <HeroMetric
          icon={ServerIcon}
          title="Memory"
          subtitle={`${h.mem.total} GB DDR4 · 2×16`}
          big={h.mem.pct.toFixed(1)}
          bigUnit="%"
          sub={
            <>
              {`${h.mem.used} GB used · ${h.mem.cached} GB cached`}
              {h.mem.powerW > 0 && (
                <>
                  {' · '}
                  <span title="DRAM RAPL domain — measured on server SKUs, modeled on consumer Intel">
                    {h.mem.powerW.toFixed(1)} W (est.)
                  </span>
                </>
              )}
            </>
          }
          sparkData={h.memSpark}
        />
        <HeroMetric
          icon={HardDriveIcon}
          title="Storage"
          subtitle={`${pool.count} disks · ${pool.totalTB} TB pool`}
          big={pool.pct}
          bigUnit="%"
          sub={`${pool.used} TB used · ${pool.free} TB free`}
          temp={pool.hottest}
          tempMax={70}
          sparkData={h.storageSpark}
        />
      </div>

      {/* CPU detail + GPU detail */}
      <div className="grid grid-cols-2 gap-6">
        <CPUDetail cpu={h.cpu} system={system} sensors={sensors} cores={cores} pressure={pressure} />

        <GPUDetail gpu={h.gpu} />
      </div>

      {/* I/O row — filesystems · disk I/O · network interfaces. Glances surfaces
          these as sidebar lists; we group them as a single dense row so they
          sit alongside the headline metrics rather than dominating the page. */}
      <div className="grid grid-cols-3 gap-6">
        <div>
          <SectionHeader
            label="Filesystems"
            count={filesystems.length}
            right={<HardDriveIcon size={14} className="text-muted-foreground/60" />}
          />
          <Card className="overflow-hidden">
            {filesystems.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">No filesystems reported.</div>
            ) : (
              filesystems.map((fs, i) => {
                // total can legitimately be zero for pseudo-fs like tmpfs that
                // never reached the collector — guard the divide rather than
                // emit NaN%.
                const pct = fs.total > 0 ? (fs.used / fs.total) * 100 : 0;
                const free = Math.max(0, fs.total - fs.used);
                return (
                  <div
                    key={fs.mount}
                    className={cn(
                      'grid grid-cols-[1fr_44px_64px] items-center gap-3 px-4 py-2',
                      i > 0 && 'border-t',
                    )}
                    title={`${fs.used.toFixed(1)} / ${fs.total.toFixed(1)} ${fs.unit} · ${free.toFixed(1)} ${fs.unit} free`}
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">{fs.mount}</div>
                      <div className="font-mono text-[10px] text-muted-foreground/80 truncate">
                        {fs.fstype}
                      </div>
                      <div className="h-[3px] rounded-full bg-muted overflow-hidden mt-1">
                        <div
                          className="h-full"
                          style={{ width: `${Math.min(100, pct)}%`, background: heatColor(pct / 100) }}
                        />
                      </div>
                    </div>
                    <div
                      className="text-right font-mono text-[11px] tabular-nums"
                      style={{ color: heatColor(pct / 100) }}
                    >
                      {pct.toFixed(0)}%
                    </div>
                    <div className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                      {fs.used.toFixed(0)}/{fs.total.toFixed(0)}
                      <span className="text-muted-foreground/60"> {fs.unit}</span>
                    </div>
                  </div>
                );
              })
            )}
          </Card>
        </div>

        <div>
          <SectionHeader
            label="Disk I/O"
            count={diskIo.length}
            right={<span className="font-mono text-[10px] text-muted-foreground/60">r/w · util</span>}
          />
          <Card className="overflow-hidden">
            {diskIo.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">Sampling…</div>
            ) : (
              diskIo.map((d, i) => (
                <div
                  key={d.id}
                  className={cn(
                    'grid grid-cols-[1fr_72px_56px] items-center gap-3 px-4 py-2',
                    i > 0 && 'border-t',
                  )}
                  title={`${d.readIops.toFixed(0)} r/s · ${d.writeIops.toFixed(0)} w/s IOPS`}
                >
                  <div className="text-xs font-mono truncate">{d.id}</div>
                  <div className="text-right font-mono text-[10px] tabular-nums leading-tight">
                    <div className="text-foreground/85">↓ {formatBps(d.readBps)}</div>
                    <div className="text-muted-foreground">↑ {formatBps(d.writeBps)}</div>
                  </div>
                  <div
                    className="text-right font-mono text-[11px] tabular-nums"
                    style={{ color: heatColor(d.utilPct / 100) }}
                  >
                    {d.utilPct.toFixed(0)}%
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>

        <div>
          <SectionHeader
            label="Network"
            count={netInterfaces.length}
            right={<NetworkIcon size={14} className="text-muted-foreground/60" />}
          />
          <Card className="overflow-hidden">
            {netInterfaces.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">No interfaces.</div>
            ) : (
              netInterfaces.map((iface, i) => (
                <div
                  key={iface.name}
                  className={cn(
                    'grid grid-cols-[16px_1fr_88px] items-center gap-3 px-4 py-2',
                    i > 0 && 'border-t',
                  )}
                >
                  <StatusDot status={iface.status} pulse={isPositiveStatus(iface.status)} />
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{iface.name}</div>
                    <div className="font-mono text-[10px] text-muted-foreground/80 truncate">
                      {iface.ip || '—'}
                    </div>
                  </div>
                  <div className="text-right font-mono text-[10px] tabular-nums leading-tight">
                    <div className="text-foreground/85">↓ {formatBps(iface.rx)}</div>
                    <div className="text-muted-foreground">↑ {formatBps(iface.tx)}</div>
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>

      {/* heat sensors — chip strip; per-core util/temps already live in CPU detail */}
      <div>
        <SectionHeader
          label="Heat sensors"
          count={sensors.length + ' probes'}
          right={
            <span className="font-mono text-[11px] text-muted-foreground">live</span>
          }
        />
        <div className="flex flex-wrap gap-1.5">
          {sensors.map((s) => (
            <SensorTile key={s.id} sensor={s} tt={tt} />
          ))}
        </div>
      </div>

      {/* cloudflare tunnels */}
      <div>
        <SectionHeader
          label="Cloudflare tunnels"
          count={`${tunnelsHealthy} / ${tunnels.length} healthy`}
          right={<CloudflareRefreshButton serverId={activeServerId} />}
        />
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2">
            {tunnels.map((t, i) => {
              const col = i % 2;
              const rowIdx = Math.floor(i / 2);
              const publicURL = `https://${t.hostname}`;
              const upstreamURL = browserReachableServiceURL(t.service);
              return (
                <div
                  key={t.id}
                  className={cn(
                    'group flex items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-muted/60',
                    rowIdx > 0 && 'border-t',
                    col === 1 && 'border-l',
                  )}
                >
                  <StatusDot status={t.status} pulse={isPositiveStatus(t.status)} />
                  <a
                    href={safeHref(publicURL)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex-1 min-w-0 truncate text-xs font-medium hover:underline"
                    title={publicURL}
                  >
                    {publicURL}
                  </a>
                  {upstreamURL ? (
                    <a
                      href={upstreamURL}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-mono text-[10px] text-muted-foreground truncate min-w-0 max-w-[45%] hover:underline hover:text-foreground"
                      title={`upstream · ${t.service}`}
                    >
                      {t.service}
                    </a>
                  ) : (
                    <span
                      className="font-mono text-[10px] text-muted-foreground truncate min-w-0 max-w-[45%]"
                      title={`upstream (not browser-reachable) · ${t.service}`}
                    >
                      {t.service}
                    </span>
                  )}
                  <div className="font-mono text-[10px] text-muted-foreground tabular-nums w-12 text-right">
                    {t.latencyMs ? t.latencyMs + 'ms' : '—'}
                  </div>
                  <button
                    type="button"
                    onClick={() => onTunnelClick(t)}
                    onMouseEnter={(e) => tt.show('Details', e)}
                    onMouseLeave={tt.hide}
                    className="text-muted-foreground/60 hover:text-foreground transition-colors p-0.5 -m-0.5"
                    aria-label={`Details for ${t.hostname}`}
                  >
                    <ChevronRightIcon size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* containers + services */}
      <div className="grid grid-cols-2 gap-6">
        <div>
          <SectionHeader
            label="Docker containers"
            count={`${containersRunning} / ${containers.length} up`}
            right={
              <Button variant="link" size="xs" className="h-auto p-0">
                View all <ChevronRightIcon size={12} />
              </Button>
            }
          />
          <Card className="overflow-hidden">
            {containersTop.map((c, i) => {
              const url = firstContainerPortURL(c.ports, serverHost);
              const matched = tunnelsForContainer(c, tunnels);
              const tunnel = matched[0];
              return (
                <div
                  key={c.name}
                  className={cn(
                    'grid grid-cols-[16px_1fr_52px_60px_72px_72px] items-center gap-3 px-4 py-2.5',
                    i > 0 && 'border-t',
                  )}
                >
                  <StatusDot status={c.status} pulse={isPositiveStatus(c.status)} />
                  <div className="min-w-0">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 max-w-full text-xs font-medium hover:underline"
                        title={url}
                      >
                        <span className="truncate">{c.name}</span>
                        <ExternalLinkIcon
                          size={10}
                          className="shrink-0 text-muted-foreground/70"
                        />
                      </a>
                    ) : (
                      <div className="text-xs font-medium truncate text-muted-foreground/90">
                        {c.name}
                      </div>
                    )}
                    {tunnel ? (
                      <a
                        href={safeHref(`https://${tunnel.hostname}`)}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 max-w-full text-[10px] font-mono truncate hover:underline hover:text-foreground text-muted-foreground/80"
                        title={`Tunnel · ${tunnel.hostname}${matched.length > 1 ? ` (+${matched.length - 1} more)` : ''}`}
                      >
                        <span className="truncate">{tunnel.hostname}</span>
                        <ExternalLinkIcon
                          size={9}
                          className="shrink-0 text-muted-foreground/60"
                        />
                      </a>
                    ) : (
                      <div className="text-[10px] text-muted-foreground/80 font-mono truncate">
                        {c.image}
                      </div>
                    )}
                  </div>
                  <div className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {c.cpu != null ? c.cpu.toFixed(1) + '%' : '—'}
                  </div>
                  <div className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {formatMem(c.mem)}
                  </div>
                  <div className="text-right font-mono text-[10px] tabular-nums leading-tight" title="block I/O · read / write">
                    <div className="text-foreground/75">↓ {c.blkReadBps != null ? formatBps(c.blkReadBps) : '—'}</div>
                    <div className="text-muted-foreground/80">↑ {c.blkWriteBps != null ? formatBps(c.blkWriteBps) : '—'}</div>
                  </div>
                  <div className="text-right font-mono text-[10px] tabular-nums leading-tight" title="network · rx / tx">
                    <div className="text-foreground/75">↓ {c.netRxBps != null ? formatBps(c.netRxBps) : '—'}</div>
                    <div className="text-muted-foreground/80">↑ {c.netTxBps != null ? formatBps(c.netTxBps) : '—'}</div>
                  </div>
                </div>
              );
            })}
          </Card>
        </div>

        <div>
          <SectionHeader
            label="Native services (systemd)"
            count={servicesActive + ' active'}
          />
          <Card className="overflow-hidden">
            {servicesTop.map((s, i) => {
              const dismissed = s.status === 'failed' && (isDismissed?.(s.name) ?? false);
              return (
              <div
                key={s.name}
                className={cn(
                  'grid grid-cols-[16px_1fr_56px_56px] items-center gap-3 px-4 py-2.5',
                  i > 0 && 'border-t',
                )}
              >
                <span className={cn(dismissed && 'opacity-40')}>
                  <StatusDot status={s.status} pulse={isPositiveStatus(s.status)} />
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <span className={cn('truncate', dismissed && 'text-muted-foreground')}>{s.name}</span>
                    {dismissed && (
                      <>
                        <span className="shrink-0 rounded border px-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                          dismissed
                        </span>
                        {onRestore && (
                          <button
                            type="button"
                            onClick={() => onRestore(s.name)}
                            title="Show this failure in the alert banner again"
                            className="shrink-0 font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            restore
                          </button>
                        )}
                      </>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground/80 truncate">{s.description}</div>
                </div>
                <div className="text-right font-mono text-[10px] text-muted-foreground">
                  {s.pid ? '#' + s.pid : '—'}
                </div>
                <div className="text-right font-mono text-[10px] text-muted-foreground">
                  {s.memMb ? s.memMb.toFixed(0) + 'M' : '—'}
                </div>
              </div>
              );
            })}
          </Card>
        </div>
      </div>

      {/* Top processes — full width so the Glances-style columns
          (VIRT/RES/state/nice/TIME+/I/O) all fit without crowding. */}
      <div>
        <SectionHeader
          label="Top processes"
          count={
            <span className="flex items-baseline gap-2">
              <span>{processes.length} shown</span>
              {procStates.total > 0 && (
                <span className="text-muted-foreground/60">
                  · {procStates.total} tasks · {procStates.threads} threads
                </span>
              )}
            </span>
          }
          right={
            procStates.total > 0 ? (
              <div className="flex items-baseline gap-3 font-mono text-[10px] uppercase tracking-wider">
                <span><span className="text-emerald-500">{procStates.running}</span> <span className="text-muted-foreground/60">running</span></span>
                <span><span className="text-foreground/85">{procStates.sleeping}</span> <span className="text-muted-foreground/60">sleep</span></span>
                {procStates.diskWait > 0 && (
                  <span><span className="text-warn">{procStates.diskWait}</span> <span className="text-muted-foreground/60">d-wait</span></span>
                )}
                {procStates.stopped > 0 && (
                  <span><span className="text-warn">{procStates.stopped}</span> <span className="text-muted-foreground/60">stop</span></span>
                )}
                {procStates.zombie > 0 && (
                  <span><span className="text-destructive">{procStates.zombie}</span> <span className="text-muted-foreground/60">zombie</span></span>
                )}
              </div>
            ) : null
          }
        />
        <Card className="overflow-hidden">
          {/* Header row — column captions in the same grid the rows use,
              so columns line up perfectly even with tabular-nums widths. */}
          <div className="grid grid-cols-[1fr_44px_44px_44px_64px_64px_64px_88px_28px_36px] items-center gap-3 px-4 py-1.5 border-b bg-muted/30 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
            <div>command</div>
            <div className="text-right">cpu%</div>
            <div className="text-right">mem%</div>
            <div className="text-right">virt</div>
            <div className="text-right">res</div>
            <div className="text-right">time+</div>
            <div className="text-right">r/s</div>
            <div className="text-right">w/s</div>
            <div className="text-center">s</div>
            <div className="text-right">ni</div>
          </div>
          {processes.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground">Sampling…</div>
          ) : (
            processes.map((p) => {
              // memMb fraction — the snapshot doesn't include a per-process
              // mem% precomputed, so we approximate via h.mem.total which is
              // already in GB; (memMb/1024) / totalGB * 100.
              const memPct = h.mem.total > 0 ? (p.memMb / 1024 / h.mem.total) * 100 : 0;
              const sMeta = processStateMeta(p.state);
              return (
                <div
                  key={p.pid}
                  onMouseEnter={(e) => tt.show(p.cmd || p.name, e)}
                  onMouseLeave={tt.hide}
                  className="grid grid-cols-[1fr_44px_44px_44px_64px_64px_64px_88px_28px_36px] items-center gap-3 px-4 py-1.5 border-t hover:bg-muted/30"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{p.name}</div>
                    <div className="text-[10px] text-muted-foreground/80 font-mono truncate">
                      {p.user} · {p.threads}t · #{p.pid}
                    </div>
                  </div>
                  <div className="text-right font-mono text-[11px] tabular-nums" style={{ color: heatColor(p.cpu / 100) }}>
                    {p.cpu.toFixed(1)}
                  </div>
                  <div className="text-right font-mono text-[11px] tabular-nums" style={{ color: heatColor(memPct / 100) }}>
                    {memPct < 0.1 ? '0.0' : memPct.toFixed(1)}
                  </div>
                  <div className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                    {p.virtMb >= 1024 ? (p.virtMb / 1024).toFixed(1) + 'G' : Math.round(p.virtMb) + 'M'}
                  </div>
                  <div className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {p.memMb >= 1024 ? (p.memMb / 1024).toFixed(1) + 'G' : Math.round(p.memMb) + 'M'}
                  </div>
                  <div className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                    {formatProcTime(p.timeSec)}
                  </div>
                  <div className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                    {p.ioReadBps != null ? formatBps(p.ioReadBps) : '—'}
                  </div>
                  <div className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                    {p.ioWriteBps != null ? formatBps(p.ioWriteBps) : '—'}
                  </div>
                  <div className={cn('text-center font-mono text-[10px] font-semibold', sMeta.className)}>
                    {sMeta.label}
                  </div>
                  <div className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                    {p.nice}
                  </div>
                </div>
              );
            })
          )}
        </Card>
      </div>

      {/* pressure + journal */}
      <div className="grid grid-cols-2 gap-6">
        <div>
          <SectionHeader
            label="Pressure (PSI)"
            count={pressure?.available ? 'avg10s' : 'unavailable'}
          />
          <Card className="p-4">
            {pressure?.available ? (
              <div className="space-y-3">
                {[
                  ['CPU', pressure.cpu.avg10],
                  ['Memory', pressure.memSome.avg10],
                  ['I/O', pressure.ioSome.avg10],
                ].map(([label, v]) => {
                  const value = v as number;
                  const color = heatColor(Math.min(1, value / 20));
                  return (
                    <div key={label as string}>
                      <div className="flex items-baseline justify-between">
                        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          {label as string}
                        </div>
                        <div className="font-mono text-xs font-semibold tabular-nums" style={{ color }}>
                          {value.toFixed(2)}%
                        </div>
                      </div>
                      <div className="h-[3px] rounded-full bg-muted overflow-hidden mt-1">
                        <div
                          className="h-full"
                          style={{ width: Math.min(100, value * 5) + '%', background: color }}
                        />
                      </div>
                    </div>
                  );
                })}
                <div className="font-mono text-[10px] text-muted-foreground/70 pt-1">
                  % of last 10s the system was stalled
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">PSI not exposed by kernel.</div>
            )}
          </Card>
        </div>

        <div>
          <SectionHeader
            label="Recent log warnings"
            count={journal.length}
            right={
              <span className="font-mono text-[11px] text-muted-foreground">
                journalctl -p warn
              </span>
            }
          />
          <Card className="overflow-hidden max-h-[360px] overflow-y-auto">
            {journal.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">Nothing recent. Looking good.</div>
            ) : (
              journal.map((e, i) => {
                const sev = journalSeverity(e.priority);
                return (
                  <div
                    key={i}
                    className={cn(
                      'px-4 py-2 space-y-0.5',
                      i > 0 && 'border-t',
                    )}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className={cn('font-mono text-[10px] uppercase tracking-wider', sev.className)}>
                        {sev.label}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground/70 truncate flex-1">
                        {e.unit || '(no unit)'}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground/60">
                        {e.timestamp.slice(11, 19)}
                      </span>
                    </div>
                    <div className="text-[11px] text-foreground/90 break-words">{e.message}</div>
                  </div>
                );
              })
            )}
          </Card>
        </div>
      </div>

      {/* Threshold alerts — the bottom strip of Glances. Shows currently
          open windows first (still above warn/crit), then recently
          resolved ones for context. Quiet by design — empty means every
          monitored metric is below its alert line. */}
      <div>
        <SectionHeader
          label="Alerts"
          count={
            alertsOpen.length === 0 && alertsResolved.length === 0
              ? 'all clear'
              : `${alertsOpen.length} open · ${alertsResolved.length} recent`
          }
          right={
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
              warn ≥ 70% · crit ≥ 90%
            </span>
          }
        />
        <Card className="overflow-hidden">
          {alerts.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground">
              No thresholds crossed. System is within configured limits.
            </div>
          ) : (
            alerts.map((a, i) => {
              const colorClass = a.severity === 'critical' ? 'text-destructive' : 'text-warn';
              const open = !a.endedAt;
              return (
                <div
                  key={a.id}
                  className={cn(
                    'grid grid-cols-[80px_1fr_140px_120px] items-center gap-3 px-4 py-2',
                    i > 0 && 'border-t',
                    open && 'bg-destructive/[0.03]',
                  )}
                >
                  <div className={cn('font-mono text-[10px] uppercase tracking-wider font-semibold', colorClass)}>
                    {a.severity}
                    {open && <span className="ml-1 text-muted-foreground/60">·live</span>}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{a.label}</div>
                    <div className="font-mono text-[10px] text-muted-foreground/80 truncate">{a.metric}</div>
                  </div>
                  <div className="text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                    <span title={`began ${a.beganAt}`}>{a.beganAt.slice(11, 19)}</span>
                    {' → '}
                    {open ? (
                      <span className={colorClass}>open</span>
                    ) : (
                      <span title={`ended ${a.endedAt}`}>{(a.endedAt ?? '').slice(11, 19)}</span>
                    )}
                  </div>
                  <div className="text-right font-mono text-[10px] tabular-nums">
                    <span className={colorClass}>peak {a.peak.toFixed(1)}{a.unit}</span>
                    <span className="text-muted-foreground/60"> · thresh {a.threshold.toFixed(1)}{a.unit}</span>
                  </div>
                </div>
              );
            })
          )}
        </Card>
      </div>
    </div>
  );
};
