import * as React from 'react';
import type { DashboardSnapshot, Tunnel } from '@/types';
import { cn, firstContainerPortURL, formatMem, heatColor, isPositiveStatus, journalSeverity, safeHref, tunnelsForContainer } from '@/lib/utils';
import { Button, Card } from '../ui/primitives';
import { StatusDot } from '../ui/status-dot';
import { ChevronRightIcon, CpuIcon, ExternalLinkIcon, HardDriveIcon, ServerIcon, ZapIcon } from '../ui/icons';
import { HeroMetric } from '../HeroMetric';
import { SectionHeader } from '../SectionHeader';
import { SensorTile } from '../SensorTile';
import { GPUDetail } from '../GPUDetail';
import { CPUDetail } from '../CPUDetail';
import { CloudflareRefreshButton } from '../CloudflareRefreshButton';
import type { FloatingTooltip } from '@/hooks/useTooltip';

export interface OverviewTabProps {
  snapshot: DashboardSnapshot;
  tt: FloatingTooltip;
  onTunnelClick: (tunnel: Tunnel) => void;
  activeServerId: string;
  // serverHost is the hostname portion of the active server's registered
  // URL. Used by the container quick-link so we don't point at the
  // dashboard's own domain (see ContainersTab for the same reason).
  serverHost: string;
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

export const OverviewTab = ({ snapshot, tt, onTunnelClick, activeServerId, serverHost }: OverviewTabProps) => {
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
  const pressure = snapshot.pressure;

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
            ? `${h.gpu.powerW ? h.gpu.powerW.toFixed(1) + ' W draw' : '—'} · fan ${h.gpu.fan}%`
            : `${h.gpu.vram.used}/${h.gpu.vram.total} ${h.gpu.vram.unit} VRAM · fan ${h.gpu.fan}%`;
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
                    'grid grid-cols-[16px_1fr_64px_72px] items-center gap-3 px-4 py-2.5',
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
            {servicesTop.map((s, i) => (
              <div
                key={s.name}
                className={cn(
                  'grid grid-cols-[16px_1fr_56px_56px] items-center gap-3 px-4 py-2.5',
                  i > 0 && 'border-t',
                )}
              >
                <StatusDot status={s.status} pulse={isPositiveStatus(s.status)} />
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">{s.name}</div>
                  <div className="text-[10px] text-muted-foreground/80 truncate">{s.description}</div>
                </div>
                <div className="text-right font-mono text-[10px] text-muted-foreground">
                  {s.pid ? '#' + s.pid : '—'}
                </div>
                <div className="text-right font-mono text-[10px] text-muted-foreground">
                  {s.memMb ? s.memMb.toFixed(0) + 'M' : '—'}
                </div>
              </div>
            ))}
          </Card>
        </div>
      </div>

      {/* pressure + top processes + journal */}
      <div className="grid grid-cols-3 gap-6">
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
          <SectionHeader label="Top processes" count={`${processes.length} shown`} />
          <Card className="overflow-hidden">
            {processes.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">Sampling…</div>
            ) : (
              processes.map((p, i) => (
                <div
                  key={p.pid}
                  onMouseEnter={(e) => tt.show(p.cmd || p.name, e)}
                  onMouseLeave={tt.hide}
                  className={cn(
                    'grid grid-cols-[1fr_60px_72px_72px] items-center gap-3 px-4 py-2',
                    i > 0 && 'border-t',
                  )}
                >
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{p.name}</div>
                    <div className="text-[10px] text-muted-foreground/80 font-mono truncate">
                      {p.user} · {p.threads}t · #{p.pid}
                    </div>
                  </div>
                  <div className="text-right font-mono text-[11px] tabular-nums" style={{ color: heatColor(p.cpu / 100) }}>
                    {p.cpu.toFixed(1)}%
                  </div>
                  <div className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                    {p.memMb >= 100 ? p.memMb.toFixed(0) + 'M' : p.memMb.toFixed(1) + 'M'}
                  </div>
                  <div className="text-right font-mono text-[10px] text-muted-foreground">
                    {p.threads}t
                  </div>
                </div>
              ))
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
    </div>
  );
};
