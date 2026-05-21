import * as React from 'react';
import type { DashboardSnapshot, FirewallRule, FirewallStatus, Tunnel } from '@/types';
import { formatBytes, isPositiveStatus, portBadgeVariant } from '@/lib/utils';
import { Badge, Button, Card, Input } from '../ui/primitives';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { StatusDot } from '../ui/status-dot';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ContainerIcon,
  LoopbackIcon,
  NetworkIcon as LanIcon,
  ShieldCheckIcon,
  TrashIcon,
  type IconProps,
} from '../ui/icons';
import type { ComponentType } from 'react';
import { SectionHeader } from '../SectionHeader';
import { CloudflareRefreshButton } from '../CloudflareRefreshButton';
import { useCan } from '@/auth';
import { addFirewallRule, deleteFirewallRule, fetchFirewall } from '@/api';
import type { FloatingTooltip } from '@/hooks/useTooltip';

export interface NetworkTabProps {
  snapshot: DashboardSnapshot;
  tt: FloatingTooltip;
  onTunnelClick: (tunnel: Tunnel) => void;
  activeServerId: string;
}

const exposureIcons: Record<string, ComponentType<IconProps>> = {
  docker: ContainerIcon,
  lan: LanIcon,
  loopback: LoopbackIcon,
};

export const NetworkTab = ({ snapshot, tt, onTunnelClick, activeServerId }: NetworkTabProps) => {
  const network = snapshot.network ?? { interfaces: [], sparkline: [] };
  const tunnels = snapshot.tunnels ?? [];
  const ports = snapshot.ports ?? [];
  const connections = snapshot.connections ?? [];
  return (
    <div className="space-y-6">
      <div>
        <SectionHeader label="Interfaces" count={network.interfaces.length} />
        <div className="grid grid-cols-4 gap-3">
          {network.interfaces.map((iface) => (
            <Card key={iface.name} className="p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="font-mono text-xs font-semibold">{iface.name}</div>
                <StatusDot status={iface.status} pulse={isPositiveStatus(iface.status)} />
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">{iface.ip}</div>
              <div className="flex items-center justify-between font-mono text-[10px]">
                <span className="text-muted-foreground">
                  ↓ <span className="text-foreground">{formatBytes(iface.rx)}</span>
                </span>
                <span className="text-muted-foreground">
                  ↑ <span className="text-foreground">{formatBytes(iface.tx)}</span>
                </span>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <TunnelSection
        tunnels={tunnels}
        onTunnelClick={onTunnelClick}
        serverId={activeServerId}
      />

      <div>
        <SectionHeader label="Exposed ports" count={ports.length} />
        <div className="grid grid-cols-4 gap-2">
          {ports.map((p) => {
            const pidLabel = p.pid ? `pid ${p.pid}` : '—';
            const processLabel = p.process || 'unknown';
            const showProcessLine = p.process && p.process !== p.service;
            const ExposureIcon = exposureIcons[p.exposed];
            return (
              <div
                key={p.port + p.proto}
                onMouseEnter={(e) =>
                  tt.show(
                    `${p.service || 'unknown'} · ${processLabel} · ${pidLabel}`,
                    e,
                  )
                }
                onMouseLeave={tt.hide}
                className="rounded-md border bg-card px-3 py-2.5 flex items-center justify-between gap-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <div className="font-mono text-sm font-semibold tabular-nums">
                      {p.port}/{p.proto}
                    </div>
                    <div className="text-xs font-medium truncate">
                      {p.service || (
                        <span className="text-muted-foreground/60">unknown</span>
                      )}
                    </div>
                  </div>
                  <div className="text-[10px] text-muted-foreground/80 font-mono truncate mt-0.5">
                    {showProcessLine ? `${processLabel} · ${pidLabel}` : pidLabel}
                  </div>
                </div>
                <Badge variant={portBadgeVariant(p.exposed)} className="gap-1">
                  {ExposureIcon && <ExposureIcon size={10} />}
                  {p.exposed}
                </Badge>
              </div>
            );
          })}
        </div>
      </div>

      <FirewallSection serverId={activeServerId} />

      <div>
        <SectionHeader
          label="Established connections"
          count={`${connections.length} ${connections.length === 100 ? 'shown (capped)' : 'flows'}`}
        />
        <Card className="overflow-hidden max-h-[420px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Remote</TableHead>
                <TableHead>Local port</TableHead>
                <TableHead>Service</TableHead>
                <TableHead className="text-right">Conns</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connections.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-xs text-muted-foreground">
                    No established connections.
                  </TableCell>
                </TableRow>
              ) : (
                connections.map((c) => (
                  <TableRow key={`${c.remoteIp}-${c.localPort}`}>
                    <TableCell className="font-mono text-[11px]">{c.remoteIp}</TableCell>
                    <TableCell className="font-mono text-[11px] tabular-nums">{c.localPort}</TableCell>
                    <TableCell className="text-xs">
                      {c.service || <span className="text-muted-foreground/60">—</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-[11px] tabular-nums">
                      {c.count}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
};

interface TunnelGroup {
  key: string;
  name: string;
  routes: Tunnel[];
}

function groupTunnels(tunnels: Tunnel[]): TunnelGroup[] {
  const map = new Map<string, TunnelGroup>();
  for (const t of tunnels) {
    const key = t.tunnelId ?? t.tunnelName ?? '__default__';
    const name = t.tunnelName ?? 'Cloudflare';
    let g = map.get(key);
    if (!g) {
      g = { key, name, routes: [] };
      map.set(key, g);
    }
    g.routes.push(t);
  }
  return Array.from(map.values());
}

interface TunnelSectionProps {
  tunnels: Tunnel[];
  onTunnelClick: (tunnel: Tunnel) => void;
  serverId: string;
}

function TunnelSection({ tunnels, onTunnelClick, serverId }: TunnelSectionProps) {
  const groups = React.useMemo(() => groupTunnels(tunnels), [tunnels]);
  // Track which groups are collapsed. Default-expanded; user collapses as
  // needed. Single-tunnel case is unchanged in feel.
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div>
      <SectionHeader
        label="Cloudflare tunnels"
        count={
          groups.length > 1
            ? `${groups.length} tunnels · ${tunnels.length} routes`
            : `${tunnels.length} routes`
        }
        right={<CloudflareRefreshButton serverId={serverId} />}
      />
      <div className="space-y-3">
        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key);
          const status = g.routes[0]?.status ?? 'healthy';
          return (
            <Card key={g.key} className="overflow-hidden">
              <button
                type="button"
                onClick={() => toggle(g.key)}
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isCollapsed ? (
                    <ChevronRightIcon size={13} className="text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronDownIcon size={13} className="text-muted-foreground shrink-0" />
                  )}
                  <StatusDot status={status} pulse={isPositiveStatus(status)} />
                  <span className="font-medium text-sm truncate">{g.name}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {g.routes.length} {g.routes.length === 1 ? 'route' : 'routes'}
                  </span>
                </div>
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {status}
                </span>
              </button>
              {!isCollapsed && (
                <div className="border-t">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-4 pr-0"></TableHead>
                        <TableHead>Hostname</TableHead>
                        <TableHead>Service</TableHead>
                        <TableHead className="text-right">Latency</TableHead>
                        <TableHead className="text-right">Req · 24h</TableHead>
                        <TableHead>Origin</TableHead>
                        <TableHead className="w-6"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.routes.map((t) => (
                        <TableRow
                          key={t.id}
                          onClick={() => onTunnelClick(t)}
                          className="cursor-pointer"
                        >
                          <TableCell className="pr-0">
                            <StatusDot status={t.status} pulse={isPositiveStatus(t.status)} />
                          </TableCell>
                          <TableCell className="font-medium text-xs">{t.hostname}</TableCell>
                          <TableCell className="font-mono text-[11px] text-muted-foreground truncate max-w-[240px]">
                            {t.service}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                            {t.latencyMs ? t.latencyMs + 'ms' : '—'}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                            {t.requests24h.toLocaleString()}
                          </TableCell>
                          <TableCell>
                            <Badge variant="muted">{t.origin}</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <ChevronRightIcon size={14} className="text-muted-foreground/60" />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Firewall — host firewall (ufw, etc.) rule management.
//
// The backend abstracts the actual firewall tool away; if nothing supported
// is detected on the host the API returns {available: false} and we render
// a friendly placeholder instead of treating it as an error.
//
// Add/delete are operator-gated. We refetch after every successful mutation
// rather than try to patch local state — the rule list is small and ufw
// canonicalises some inputs (e.g. comments, address forms), so re-reading
// the source of truth guarantees the table reflects what's actually live.
// ---------------------------------------------------------------------------

interface FirewallSectionProps {
  serverId: string;
}

const EMPTY_FIREWALL: FirewallStatus = { available: false, backend: '', active: false, rules: [] };

function FirewallSection({ serverId }: FirewallSectionProps) {
  const canControl = useCan('operator');
  const [status, setStatus] = React.useState<FirewallStatus>(EMPTY_FIREWALL);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await fetchFirewall(serverId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const subtitle =
    loading && status.rules.length === 0
      ? 'loading…'
      : !status.available
        ? 'unsupported on this server'
        : `${status.backend} · ${status.active ? 'active' : 'inactive'}`;

  return (
    <div>
      <SectionHeader label="Firewall" count={subtitle} />
      {error ? (
        <Card className="p-3 text-xs text-destructive">{error}</Card>
      ) : !status.available ? (
        <Card className="p-4 text-xs text-muted-foreground">
          No supported firewall backend was detected on this host. Install <code className="font-mono">ufw</code> and
          ensure <code className="font-mono">systemd-run</code> is available, then reload.
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {canControl && <AddRuleForm onSubmit={async (r) => {
            await addFirewallRule(serverId, r);
            await refresh();
          }} />}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-4 pr-0"></TableHead>
                <TableHead>Port</TableHead>
                <TableHead>Proto</TableHead>
                <TableHead>Dir</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead className="w-12 text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status.rules.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-xs text-muted-foreground">
                    No rules.
                  </TableCell>
                </TableRow>
              ) : (
                status.rules.map((rule, i) => (
                  <FirewallRuleRow
                    key={i}
                    rule={rule}
                    canControl={canControl}
                    onDelete={async () => {
                      await deleteFirewallRule(serverId, rule);
                      await refresh();
                    }}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

interface FirewallRuleRowProps {
  rule: FirewallRule;
  canControl: boolean;
  onDelete: () => Promise<void>;
}

function FirewallRuleRow({ rule, canControl, onDelete }: FirewallRuleRowProps) {
  const [pending, setPending] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const portLabel =
    rule.port === 0 ? 'any' : rule.portEnd && rule.portEnd !== rule.port ? `${rule.port}–${rule.portEnd}` : `${rule.port}`;
  const actionVariant: 'success' | 'danger' | 'muted' =
    rule.action === 'allow' ? 'success' : rule.action === 'deny' || rule.action === 'reject' ? 'danger' : 'muted';
  return (
    <TableRow>
      <TableCell className="pr-0">
        <ShieldCheckIcon size={12} className="text-muted-foreground/70" />
      </TableCell>
      <TableCell className="font-mono text-[11px] tabular-nums">
        <div className="flex items-center gap-1.5">
          <Badge variant={actionVariant} className="rounded-sm uppercase tracking-wider text-[9px]">
            {rule.action}
          </Badge>
          {portLabel}
          {rule.v6 && <span className="text-muted-foreground/60 text-[9px]">v6</span>}
        </div>
      </TableCell>
      <TableCell className="font-mono text-[11px] text-muted-foreground uppercase">
        {rule.proto || 'any'}
      </TableCell>
      <TableCell className="font-mono text-[11px] text-muted-foreground uppercase">
        {rule.direction}
      </TableCell>
      <TableCell className="font-mono text-[11px] text-muted-foreground truncate max-w-[180px]">
        {rule.from || 'any'}
      </TableCell>
      <TableCell className="text-[11px] text-muted-foreground truncate max-w-[180px]">
        {rule.comment || (err ? <span className="text-destructive">{err}</span> : <span className="text-muted-foreground/40">—</span>)}
      </TableCell>
      <TableCell className="text-right">
        <Button
          size="iconSm"
          variant="ghost"
          disabled={!canControl || pending}
          title={!canControl ? 'Operator role required' : 'Delete rule'}
          onClick={async () => {
            setPending(true);
            setErr(null);
            try {
              await onDelete();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(false);
            }
          }}
          className="text-destructive hover:text-destructive hover:bg-destructive/10 [&_svg]:hover:stroke-[2.75]"
        >
          <TrashIcon size={12} />
        </Button>
      </TableCell>
    </TableRow>
  );
}

interface AddRuleFormProps {
  onSubmit: (r: FirewallRule) => Promise<void>;
}

// Minimal add form: port (+ optional range), proto, direction, action, source.
// We accept only the common fields here; advanced shapes (named services,
// per-interface rules, limit/reject) need to be added in the UI before
// they're useful, even if the backend already supports them.
function AddRuleForm({ onSubmit }: AddRuleFormProps) {
  const [port, setPort] = React.useState('');
  const [portEnd, setPortEnd] = React.useState('');
  const [proto, setProto] = React.useState<'tcp' | 'udp' | ''>('tcp');
  const [direction, setDirection] = React.useState<'in' | 'out'>('in');
  const [action, setAction] = React.useState<'allow' | 'deny'>('allow');
  const [from, setFrom] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError('Port must be 1–65535');
      return;
    }
    const portEndNum = portEnd ? Number(portEnd) : 0;
    if (portEnd && (!Number.isInteger(portEndNum) || portEndNum < portNum || portEndNum > 65535)) {
      setError('End port must be ≥ start port and ≤ 65535');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const rule: FirewallRule = {
        port: portNum,
        portEnd: portEndNum,
        proto,
        direction,
        action,
      };
      const trimmedFrom = from.trim();
      if (trimmedFrom) rule.from = trimmedFrom;
      await onSubmit(rule);
      setPort('');
      setPortEnd('');
      setFrom('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2.5"
    >
      <Input
        value={port}
        onChange={(e) => setPort(e.target.value)}
        placeholder="port"
        inputMode="numeric"
        className="w-20 h-8 text-xs"
      />
      <span className="text-muted-foreground/60 text-xs">–</span>
      <Input
        value={portEnd}
        onChange={(e) => setPortEnd(e.target.value)}
        placeholder="end (opt.)"
        inputMode="numeric"
        className="w-20 h-8 text-xs"
      />
      <select
        value={proto}
        onChange={(e) => setProto(e.target.value as 'tcp' | 'udp' | '')}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
      >
        <option value="tcp">tcp</option>
        <option value="udp">udp</option>
        <option value="">any</option>
      </select>
      <select
        value={direction}
        onChange={(e) => setDirection(e.target.value as 'in' | 'out')}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
      >
        <option value="in">in</option>
        <option value="out">out</option>
      </select>
      <select
        value={action}
        onChange={(e) => setAction(e.target.value as 'allow' | 'deny')}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
      >
        <option value="allow">allow</option>
        <option value="deny">deny</option>
      </select>
      <Input
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        placeholder="from (CIDR, optional)"
        className="flex-1 min-w-[160px] h-8 text-xs"
      />
      <Button type="submit" size="sm" disabled={busy || !port}>
        {busy ? 'Adding…' : 'Add rule'}
      </Button>
      {error && <span className="text-destructive text-xs basis-full">{error}</span>}
    </form>
  );
}
