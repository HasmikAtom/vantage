import * as React from 'react';
import type { Container, DashboardSnapshot, DockerDFCategory } from '@/types';
import { cn, containerPortURL, firstContainerPortURL, formatBytesAbs, formatMem, isPositiveStatus, safeHref, tunnelsForContainer } from '@/lib/utils';
import { deriveStackYAML } from '@/api';
import { Badge, Button, Card, Input } from '../ui/primitives';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { StatusDot } from '../ui/status-dot';
import { ExternalLinkIcon, FileTextIcon, InfoIcon, PlayIcon, RefreshIcon, SearchIcon, StopIcon, TrashIcon } from '../ui/icons';
import { SectionHeader } from '../SectionHeader';
import { useCan } from '@/auth';
import { listStacks, restartContainer, startContainer, stopContainer } from '@/api';
import type { StackSummary } from '@/types';
import type { FloatingTooltip } from '@/hooks/useTooltip';
import { ContainerInspectDialog } from '../ContainerInspectDialog';
import { RemoveContainerDialog } from '../RemoveContainerDialog';
import { CreateContainerDialog } from '../CreateContainerDialog';
import {
  CreateStackDialog,
  EditStackDialog,
  RemoveStackDialog,
} from '../StackDialogs';
import { LogsDialog } from '../LogsDialog';
import { ReclaimDialog, type ReclaimKind } from '../ReclaimDialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { pruneBuildCache } from '@/api';
import { ChevronDownIcon, ChevronRightIcon } from '../ui/icons';

export interface ContainersTabProps {
  snapshot: DashboardSnapshot;
  tt: FloatingTooltip;
  serverId: string;
  // serverHost is the hostname portion of the active server's registered
  // URL. Used to build "open in browser" links for published container
  // ports so we don't accidentally point at the dashboard's own domain
  // (e.g. a Cloudflare tunnel) which can't route those ports.
  serverHost: string;
}

// `running` is the only Docker state where stop/restart are meaningful;
// anything else (exited/created/dead/restarting/paused) gets start enabled
// instead. We treat the explicit string set rather than relying on
// isPositiveStatus so a transitional "restarting" state isn't surprisingly
// startable.
function canStart(c: Container): boolean {
  return c.status !== 'running';
}
function canStopOrRestart(c: Container): boolean {
  return c.status === 'running';
}

// renderGroupedRows splits the container list into per-stack sections,
// preceded by a small header row, with a "Standalone" group at the end
// for non-compose containers. Each group's rows reuse the same renderer
// the flat view does, but ask it to hide the Stack column since the
// section header already conveys that information.
//
// Header rows span the full table width (the Stack column is hidden in
// grouped mode, so 9 columns instead of 10). Returns a single flat
// array of <TableRow>s — caller drops it into the existing <TableBody>.
function renderGroupedRows(
  rows: Container[],
  renderRow: (c: Container, opts?: { hideStack?: boolean }) => React.ReactElement,
): React.ReactNode {
  const groups = new Map<string, Container[]>();
  const standalone: Container[] = [];
  for (const c of rows) {
    if (c.stack) {
      const arr = groups.get(c.stack) ?? [];
      arr.push(c);
      groups.set(c.stack, arr);
    } else {
      standalone.push(c);
    }
  }
  const stackNames = Array.from(groups.keys()).sort();

  const colSpan = 9; // 10 columns minus the hidden Stack column
  const out: React.ReactElement[] = [];
  for (const name of stackNames) {
    out.push(
      <TableRow key={`__group_${name}`} className="bg-muted/30">
        <TableCell
          colSpan={colSpan}
          className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground py-1 px-3"
        >
          {name}{' '}
          <span className="text-muted-foreground/60 normal-case tracking-normal">
            · {groups.get(name)!.length}
          </span>
        </TableCell>
      </TableRow>,
    );
    for (const c of groups.get(name)!) {
      out.push(renderRow(c, { hideStack: true }));
    }
  }
  if (standalone.length > 0) {
    out.push(
      <TableRow key="__group_standalone" className="bg-muted/30">
        <TableCell
          colSpan={colSpan}
          className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground py-1 px-3"
        >
          Standalone{' '}
          <span className="text-muted-foreground/60 normal-case tracking-normal">
            · {standalone.length}
          </span>
        </TableCell>
      </TableRow>,
    );
    for (const c of standalone) {
      out.push(renderRow(c, { hideStack: true }));
    }
  }
  return out;
}

function DFTile({
  label,
  cat,
  onReclaim,
}: {
  label: string;
  cat: DockerDFCategory;
  // When provided AND there's anything to reclaim, renders a small action
  // button under the reclaimable line. Caller controls what happens (open
  // the dialog for items, or the confirm modal for build cache).
  onReclaim?: () => void;
}) {
  const reclaimPct = cat.sizeBytes > 0 ? (cat.reclaimBytes / cat.sizeBytes) * 100 : 0;
  const hasReclaimable = cat.reclaimBytes > 0;
  return (
    <Card className="p-3 space-y-1.5">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="font-mono text-[10px] text-muted-foreground">
          {cat.active}/{cat.count} active
        </div>
      </div>
      <div className="font-serif text-xl font-medium leading-none tabular-nums">
        {formatBytesAbs(cat.sizeBytes)}
      </div>
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] text-muted-foreground">
          reclaimable {formatBytesAbs(cat.reclaimBytes)}
        </div>
        {reclaimPct > 0 && (
          <div className="font-mono text-[10px] text-warn">
            {reclaimPct.toFixed(0)}%
          </div>
        )}
      </div>
      {onReclaim && hasReclaimable && (
        <button
          type="button"
          onClick={onReclaim}
          className="w-full text-[10px] font-mono uppercase tracking-wider text-warn/80 hover:text-warn hover:bg-warn/10 rounded-sm py-1 transition-colors"
        >
          Reclaim…
        </button>
      )}
    </Card>
  );
}

export const ContainersTab = ({ snapshot, tt, serverId, serverHost }: ContainersTabProps) => {
  const [query, setQuery] = React.useState('');
  const containers = snapshot.containers ?? [];
  const tunnels = snapshot.tunnels ?? [];
  const canControl = useCan('operator');
  // Per-container in-flight action. Used to disable buttons and show a
  // pending state until the SSE stream's next snapshot reflects the new
  // container state (within ~1s thanks to the backend's fast-poke).
  const [pending, setPending] = React.useState<Record<string, 'start' | 'stop' | 'restart'>>({});
  const [inspectId, setInspectId] = React.useState<string | null>(null);
  const [logsTarget, setLogsTarget] = React.useState<{ id: string; name: string } | null>(null);
  const [removeTarget, setRemoveTarget] = React.useState<Container | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  // Table view mode: flat is the existing one-row-per-container table;
  // grouped renders a section header per stack with member rows nested
  // beneath, plus a "Standalone" group for non-compose containers.
  const [viewMode, setViewMode] = React.useState<'flat' | 'grouped'>('flat');
  // Which stack rows in the Stacks section are expanded to show their
  // member containers. Multiple may be open at once.
  const [expandedStacks, setExpandedStacks] = React.useState<Set<string>>(new Set());
  const toggleStackExpansion = (name: string) => {
    setExpandedStacks((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Stack list + dialog state. Loaded on mount and refetched after every
  // create/edit/remove so the section stays in sync with the on-disk view
  // (the SSE stream only carries container snapshots, not stack files).
  const [stacks, setStacks] = React.useState<StackSummary[]>([]);
  const [stacksOpen, setStacksOpen] = React.useState(false);
  const [createStackOpen, setCreateStackOpen] = React.useState(false);
  // Prefill values for the create dialog when triggered from the
  // "Recreate as managed" flow on a discovered stack. Cleared when the
  // dialog closes so a subsequent vanilla "+ New stack" gets the
  // default example.
  const [createStackPrefill, setCreateStackPrefill] = React.useState<{
    name: string;
    yaml: string;
    sourceName: string; // original discovered stack name (for the notice)
  } | null>(null);

  const handleRecreate = React.useCallback(
    async (s: StackSummary) => {
      try {
        const yaml = await deriveStackYAML(serverId, s.name);
        setCreateStackPrefill({
          name: `${s.name}-managed`,
          yaml,
          sourceName: s.name,
        });
        setCreateStackOpen(true);
      } catch (err) {
        console.error(`recreate ${s.name} failed:`, err);
      }
    },
    [serverId],
  );

  // Reclaim dialogs. Three of the four cards open the per-item ReclaimDialog
  // (images/containers/volumes). Build cache routes through a plain
  // destructive confirm because there are no human-meaningful items to pick.
  const [reclaimKind, setReclaimKind] = React.useState<ReclaimKind | null>(null);
  const [confirmBuildCacheOpen, setConfirmBuildCacheOpen] = React.useState(false);
  const [buildCachePending, setBuildCachePending] = React.useState(false);
  const [editStack, setEditStack] = React.useState<string | null>(null);
  const [removeStack, setRemoveStack] = React.useState<StackSummary | null>(null);

  const refreshStacks = React.useCallback(() => {
    if (!serverId) return;
    listStacks(serverId)
      .then(setStacks)
      .catch(() => {
        // Soft failure — empty stack list isn't an error worth interrupting
        // the dashboard for. Real errors land in the dialog actions instead.
      });
  }, [serverId]);

  React.useEffect(() => {
    refreshStacks();
  }, [refreshStacks]);

  const runAction = React.useCallback(
    async (id: string, action: 'start' | 'stop' | 'restart') => {
      setPending((p) => ({ ...p, [id]: action }));
      try {
        if (action === 'start') await startContainer(serverId, id);
        else if (action === 'stop') await stopContainer(serverId, id);
        else await restartContainer(serverId, id);
      } catch (err) {
        console.error(`container ${action} failed:`, err);
        // Soft surface: leave pending false but flag once via console. A
        // proper toast system is a future UI phase.
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
      }
    },
    [serverId],
  );
  const filtered = containers.filter((c) =>
    c.name.toLowerCase().includes(query.toLowerCase()),
  );
  const df = snapshot.dockerDf;

  // Container row rendering is shared between three contexts:
  //   1. the flat Containers table at the bottom of the tab
  //   2. the per-stack expansion under each row in the Stacks section
  //   3. the grouped-by-stack view in the Containers table
  //
  // Defining it inside the component keeps it closed over the live
  // pending/runAction/setRemoveTarget state without prop-drilling.
  // hideStack omits the Stack column for the grouped view (the section
  // header already says which stack the rows belong to).
  const renderContainerRow = (c: Container, opts: { hideStack?: boolean } = {}) => {
    const nameURL = firstContainerPortURL(c.ports, serverHost);
    const matchedTunnels = tunnelsForContainer(c, tunnels);
    return (
      <TableRow
        key={c.id || c.name}
        onMouseEnter={(e) =>
          tt.show(
            `${c.name} · ${c.status} · ${c.ports.length} port${c.ports.length === 1 ? '' : 's'}`,
            e,
          )
        }
        onMouseLeave={tt.hide}
      >
        <TableCell className="pr-0">
          <StatusDot status={c.status} pulse={isPositiveStatus(c.status)} />
        </TableCell>
        <TableCell className="font-medium text-xs">
          {nameURL ? (
            <a
              href={nameURL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 hover:underline"
              title={nameURL}
            >
              {c.name}
              <ExternalLinkIcon size={10} className="text-muted-foreground/70" />
            </a>
          ) : (
            <span className="text-muted-foreground/80">{c.name}</span>
          )}
        </TableCell>
        {!opts.hideStack && (
          <TableCell className="font-mono text-[11px] text-muted-foreground">
            {c.stack ? (
              <Badge variant="muted" className="rounded-sm">{c.stack}</Badge>
            ) : (
              <span className="text-muted-foreground/40">—</span>
            )}
          </TableCell>
        )}
        <TableCell className="font-mono text-[11px] text-muted-foreground truncate max-w-[180px]">
          {c.image}
        </TableCell>
        <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">
          {c.cpu != null ? c.cpu.toFixed(1) + '%' : '—'}
        </TableCell>
        <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">
          {formatMem(c.mem)}
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1">
            {c.ports.length === 0 ? (
              <span className="text-muted-foreground/60 text-xs">—</span>
            ) : (
              c.ports.map((p) => {
                const portURL = containerPortURL(p, serverHost);
                return portURL ? (
                  <a key={p} href={portURL} target="_blank" rel="noreferrer noopener" title={portURL}>
                    <Badge variant="muted" className="rounded-sm hover:bg-foreground/10 cursor-pointer">
                      {p}
                    </Badge>
                  </a>
                ) : (
                  <Badge key={p} variant="muted" className="rounded-sm" title="not published to host">
                    {p}
                  </Badge>
                );
              })
            )}
          </div>
        </TableCell>
        <TableCell>
          <div className="flex flex-col gap-0.5 max-w-[220px]">
            {matchedTunnels.length === 0 ? (
              <span className="text-muted-foreground/60 text-xs">—</span>
            ) : (
              matchedTunnels.map((t) => (
                <a
                  key={t.id}
                  href={safeHref(`https://${t.hostname}`)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-[11px] font-mono text-primary/90 hover:text-primary underline decoration-dotted decoration-primary/40 hover:decoration-solid hover:decoration-primary underline-offset-2 truncate"
                  title={`https://${t.hostname}`}
                >
                  <span className="truncate">{t.hostname}</span>
                  <ExternalLinkIcon size={9} className="shrink-0 text-primary/70" />
                </a>
              ))
            )}
          </div>
        </TableCell>
        <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
          {c.uptime}
        </TableCell>
        <TableCell className="text-right">
          <div className="inline-flex gap-1 justify-end">
            {canControl && (
              <>
                <Button size="iconSm" variant="ghost" onClick={() => setInspectId(c.id)} title="Inspect" className="[&_svg]:hover:stroke-[2.75]">
                  <InfoIcon size={12} />
                </Button>
                <Button size="iconSm" variant="ghost" onClick={() => setLogsTarget({ id: c.id, name: c.name })} title="Logs" className="[&_svg]:hover:stroke-[2.75]">
                  <FileTextIcon size={12} />
                </Button>
              </>
            )}
            <Button
              size="iconSm"
              variant="ghost"
              disabled={!canControl || !canStart(c) || pending[c.id] !== undefined}
              onClick={() => void runAction(c.id, 'start')}
              title={!canControl ? 'Operator role required' : canStart(c) ? 'Start' : 'Already running'}
              className="text-primary hover:text-primary hover:bg-primary/10 [&_svg]:hover:stroke-[2.75]"
            >
              <PlayIcon size={12} />
            </Button>
            <Button
              size="iconSm"
              variant="ghost"
              disabled={!canControl || !canStopOrRestart(c) || pending[c.id] !== undefined}
              onClick={() => void runAction(c.id, 'restart')}
              title={!canControl ? 'Operator role required' : canStopOrRestart(c) ? 'Restart' : 'Not running'}
              className="text-warn/80 hover:text-warn/80 hover:bg-warn/10 [&_svg]:hover:stroke-[2.75]"
            >
              <RefreshIcon size={12} />
            </Button>
            <Button
              size="iconSm"
              variant="ghost"
              disabled={!canControl || !canStopOrRestart(c) || pending[c.id] !== undefined}
              onClick={() => void runAction(c.id, 'stop')}
              title={!canControl ? 'Operator role required' : canStopOrRestart(c) ? 'Stop' : 'Already stopped'}
              className="text-warn hover:text-warn hover:bg-warn/10 [&_svg]:hover:stroke-[2.75]"
            >
              <StopIcon size={12} />
            </Button>
            {canControl && (
              <Button
                size="iconSm"
                variant="ghost"
                disabled={pending[c.id] !== undefined}
                onClick={() => setRemoveTarget(c)}
                title="Remove"
                className="text-destructive hover:text-destructive hover:bg-destructive/10 [&_svg]:hover:stroke-[2.75]"
              >
                <TrashIcon size={12} />
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <SectionHeader
          label="Docker disk usage"
          count={
            df ? formatBytesAbs(
              df.images.sizeBytes + df.containers.sizeBytes + df.volumes.sizeBytes + df.buildCache.sizeBytes,
            ) + ' total'
            : '—'
          }
        />
        <div className="grid grid-cols-4 gap-3">
          {df && (
            <>
              {/* Only thread the onReclaim prop when the user actually has
                  control — exactOptionalPropertyTypes rejects passing
                  `undefined` to an optional callback prop. */}
              <DFTile
                label="Images"
                cat={df.images}
                {...(canControl && { onReclaim: () => setReclaimKind('images') })}
              />
              <DFTile
                label="Containers (rw layer)"
                cat={df.containers}
                {...(canControl && { onReclaim: () => setReclaimKind('containers') })}
              />
              <DFTile
                label="Volumes"
                cat={df.volumes}
                {...(canControl && { onReclaim: () => setReclaimKind('volumes') })}
              />
              <DFTile
                label="Build cache"
                cat={df.buildCache}
                {...(canControl && { onReclaim: () => setConfirmBuildCacheOpen(true) })}
              />
            </>
          )}
        </div>
      </div>

      {/* Stacks sub-section. Collapsible so it stays out of the way when
          the user only cares about individual containers. List items show
          name + container count + last update; edit/remove gated on
          operator+. */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            onClick={() => setStacksOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            {stacksOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            Stacks · {stacks.length}
          </button>
          {canControl && (
            <Button size="xs" variant="outline" onClick={() => setCreateStackOpen(true)}>
              + new stack
            </Button>
          )}
        </div>
        {stacksOpen && (
          <Card className="overflow-hidden">
            {stacks.length === 0 ? (
              <div className="px-4 py-3 text-[11px] text-muted-foreground italic">
                No stacks yet. Click <span className="font-mono">+ new stack</span> to deploy one
                from a compose file.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stack</TableHead>
                    <TableHead className="text-right">Containers</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right w-[100px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stacks.map((s) => {
                    // Only managed stacks (we own the YAML on disk) can be
                    // edited or removed through the UI. Discovered stacks
                    // get a small "discovered" badge + a host-path hint so
                    // the user knows where to find them outside Vantage.
                    const isManaged = s.kind === 'managed';
                    const isExpanded = expandedStacks.has(s.name);
                    const members = containers.filter((c) => c.stack === s.name);
                    return (
                      <React.Fragment key={s.name}>
                      <TableRow>
                        <TableCell className="font-mono text-xs">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => toggleStackExpansion(s.name)}
                              className="text-muted-foreground hover:text-foreground"
                              title={isExpanded ? 'Collapse' : 'Expand'}
                              disabled={s.containerCount === 0}
                            >
                              {isExpanded
                                ? <ChevronDownIcon size={12} />
                                : <ChevronRightIcon size={12} />}
                            </button>
                            <span>{s.name}</span>
                            <Badge
                              variant={isManaged ? 'muted' : 'outline'}
                              className="rounded-sm text-[9px] uppercase tracking-wider"
                              title={
                                isManaged
                                  ? 'Deployed via Vantage'
                                  : `Discovered: compose file on host at ${s.workingDir || 'unknown path'}`
                              }
                            >
                              {s.kind}
                            </Badge>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                          {s.containerCount}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">
                          {isManaged
                            ? new Date(s.updatedAt).toLocaleString()
                            : s.workingDir || '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex gap-1 justify-end">
                            {canControl && (
                              <>
                                {/* Edit: managed stacks always (file lives in our /data/stacks),
                                    discovered stacks only when the on-disk file still exists. */}
                                {(isManaged || s.hasFile) && (
                                  <Button
                                    size="iconSm"
                                    variant="ghost"
                                    onClick={() => setEditStack(s.name)}
                                    title="Edit YAML & re-apply"
                                    className="text-warn/80 hover:text-warn/80 hover:bg-warn/10 [&_svg]:hover:stroke-[2.75]"
                                  >
                                    <RefreshIcon size={12} />
                                  </Button>
                                )}
                                {/* Recreate as managed: only shown for discovered stacks.
                                    Useful both for "file is gone, restore from inspect" and
                                    "adopt this into Vantage-managed". */}
                                {!isManaged && (
                                  <Button
                                    size="iconSm"
                                    variant="ghost"
                                    onClick={() => void handleRecreate(s)}
                                    title={
                                      s.hasFile
                                        ? 'Recreate as a managed stack (snapshot YAML from inspect)'
                                        : 'Compose file is missing — recreate a fresh managed stack from container inspect'
                                    }
                                    className="text-primary hover:text-primary hover:bg-primary/10 [&_svg]:hover:stroke-[2.75]"
                                  >
                                    <PlayIcon size={12} />
                                  </Button>
                                )}
                                {/* Remove still managed-only — destructive on a discovered
                                    stack is deferred to v2 (the conservative D-call). */}
                                {isManaged && (
                                  <Button
                                    size="iconSm"
                                    variant="ghost"
                                    onClick={() => setRemoveStack(s)}
                                    title="Remove stack"
                                    className="text-destructive hover:text-destructive hover:bg-destructive/10 [&_svg]:hover:stroke-[2.75]"
                                  >
                                    <TrashIcon size={12} />
                                  </Button>
                                )}
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {isExpanded && members.length > 0 && (
                        <TableRow>
                          {/* Full-width nested table inside an expansion
                              row. colSpan covers the 4 stack-row columns. */}
                          <TableCell colSpan={4} className="bg-muted/30 p-0">
                            <div className="border-l-2 border-warn/40 ml-3 my-1 mr-1">
                              <Table>
                                <TableBody>
                                  {members.map((c) =>
                                    renderContainerRow(c, { hideStack: true }),
                                  )}
                                </TableBody>
                              </Table>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Card>
        )}
      </div>
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter containers…"
            className="pl-9"
          />
        </div>
        <Badge variant="muted">
          {filtered.length} / {containers.length}
        </Badge>
        {(['running', 'restarting', 'all'] as const).map((f) => (
          <Badge key={f} variant="outline" className="border-border">
            {f}
          </Badge>
        ))}
        {canControl && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreateOpen(true)}
            title="Pull an image and run a new container"
          >
            + New container
          </Button>
        )}
      </div>
      {/* View-mode toggle for the main containers table. Flat is the
          original one-row-per-container view; Grouped clusters rows
          under per-stack section headers (and a "Standalone" group at
          the end for non-compose containers). */}
      <div className="flex items-center gap-2">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          View
        </div>
        <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
          {(['flat', 'grouped'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              className={cn(
                'px-2 py-0.5 text-[11px] font-mono rounded',
                viewMode === mode
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>
      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-4 pr-0"></TableHead>
              <TableHead>Container</TableHead>
              {viewMode === 'flat' && <TableHead>Stack</TableHead>}
              <TableHead>Image</TableHead>
              <TableHead className="text-right">CPU</TableHead>
              <TableHead className="text-right">Memory</TableHead>
              <TableHead>Ports</TableHead>
              <TableHead>Tunnels</TableHead>
              <TableHead className="text-right">Uptime</TableHead>
              <TableHead className="text-right w-[120px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {viewMode === 'grouped' && renderGroupedRows(filtered, renderContainerRow)}
            {viewMode === 'flat' && filtered.map((c) => renderContainerRow(c))}
          </TableBody>
        </Table>
      </Card>
      <ContainerInspectDialog
        serverId={serverId}
        containerId={inspectId}
        onClose={() => setInspectId(null)}
      />
      <RemoveContainerDialog
        serverId={serverId}
        container={removeTarget}
        onClose={() => setRemoveTarget(null)}
      />
      <CreateContainerDialog
        serverId={serverId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
      <CreateStackDialog
        serverId={serverId}
        open={createStackOpen}
        onClose={() => {
          setCreateStackOpen(false);
          setCreateStackPrefill(null);
        }}
        onCreated={refreshStacks}
        {...(createStackPrefill && {
          initialName: createStackPrefill.name,
          initialYaml: createStackPrefill.yaml,
          notice: (
            <>
              Reverse-engineered from <span className="font-mono">{createStackPrefill.sourceName}</span>
              's container inspect. Image-baked-in env vars and labels likely show
              up here — trim what wasn't yours before deploying. The deployed
              stack will run alongside the original (different name);
              <span className="font-mono"> compose down </span>
              the original from the host shell once you've confirmed the new one works.
            </>
          ),
        })}
      />
      <EditStackDialog
        serverId={serverId}
        stackName={editStack}
        onClose={() => setEditStack(null)}
        onSaved={refreshStacks}
      />
      <RemoveStackDialog
        serverId={serverId}
        stack={removeStack}
        onClose={() => setRemoveStack(null)}
        onRemoved={refreshStacks}
      />
      <LogsDialog
        serverId={serverId}
        target={logsTarget}
        onClose={() => setLogsTarget(null)}
      />
      <ReclaimDialog
        serverId={serverId}
        kind={reclaimKind}
        onClose={() => setReclaimKind(null)}
      />
      <ConfirmDialog
        open={confirmBuildCacheOpen}
        title="Reclaim build cache?"
        destructive
        description={
          <>
            Runs <span className="font-mono">docker build prune</span>. All
            cache layers not currently referenced by an in-flight build will
            be deleted. Your next image build will be slower because deleted
            cache has to be re-fetched/re-computed — no data loss.
          </>
        }
        confirmLabel={buildCachePending ? 'Reclaiming…' : 'Reclaim'}
        onCancel={() => setConfirmBuildCacheOpen(false)}
        onConfirm={async () => {
          setBuildCachePending(true);
          try {
            await pruneBuildCache(serverId);
          } catch (e) {
            console.error('build cache prune failed:', e);
          } finally {
            setBuildCachePending(false);
            setConfirmBuildCacheOpen(false);
          }
        }}
      />
    </div>
  );
};
