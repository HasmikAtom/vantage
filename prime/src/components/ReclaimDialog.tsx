import * as React from 'react';
import {
  applyReclaimContainers,
  applyReclaimImages,
  applyReclaimVolumes,
  listReclaimableContainers,
  listReclaimableImages,
  listReclaimableVolumes,
} from '@/api';
import type {
  ReclaimableContainer,
  ReclaimableImage,
  ReclaimableVolume,
  ReclaimResult,
} from '@/types';
import { formatBytesAbs } from '@/lib/utils';
import { Button } from './ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

export type ReclaimKind = 'images' | 'containers' | 'volumes';

export interface ReclaimDialogProps {
  serverId: string;
  kind: ReclaimKind | null;
  onClose: () => void;
  onApplied?: () => void;
}

// Row shape after the per-kind list is normalized so the table render
// code doesn't care which category it's showing.
interface Row {
  id: string;            // image id, container id, volume name
  primary: string;       // tag, container name, volume name
  secondary?: string;    // image (for containers), state (for containers)
  sizeBytes: number;
  age: string;           // pre-formatted human-readable age, or "—"
}

/**
 * Per-card "Reclaim…" dialog. Handles images, containers, and volumes —
 * each with the same checkbox-list UX but different defaults and warning
 * tone. Build cache is NOT routed through here (it has no per-item list;
 * see ConfirmDialog usage in ContainersTab for that path).
 *
 * Defaults:
 *   images / containers — all checked (the typical case is "yes, junk it")
 *   volumes             — all UNCHECKED + warning banner (real data risk)
 *
 * The list is re-fetched on every open so the user sees the current
 * reclaimable set, not a 15s-stale snapshot.
 *
 * Results: when apply finishes, the modal body is replaced with a result
 * summary (ok/skipped/error per item) until the user dismisses. Skipped
 * usually means "in use" or "already gone" — both expected outcomes given
 * the time gap between list and apply.
 */
export const ReclaimDialog = ({ serverId, kind, onClose, onApplied }: ReclaimDialogProps) => {
  const [rows, setRows] = React.useState<Row[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [loaded, setLoaded] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ReclaimResult | null>(null);

  React.useEffect(() => {
    if (!kind) return;
    setLoaded(false);
    setRows([]);
    setSelected(new Set());
    setError(null);
    setResult(null);
    setPending(false);
    const ctrl = new AbortController();
    fetchList(serverId, kind, ctrl.signal)
      .then((next) => {
        if (ctrl.signal.aborted) return;
        setRows(next);
        // Volumes default unchecked; the rest default all-checked.
        if (kind !== 'volumes') {
          setSelected(new Set(next.map((r) => r.id)));
        }
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      });
    return () => ctrl.abort();
  }, [serverId, kind]);

  if (!kind) return null;

  const config = KIND_CONFIG[kind];
  const totalSelectedBytes = rows
    .filter((r) => selected.has(r.id))
    .reduce((s, r) => s + r.sizeBytes, 0);

  const toggleAll = (allOn: boolean) => {
    setSelected(allOn ? new Set(rows.map((r) => r.id)) : new Set());
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleApply = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setPending(true);
    setError(null);
    try {
      const apply =
        kind === 'images'
          ? applyReclaimImages
          : kind === 'containers'
            ? applyReclaimContainers
            : applyReclaimVolumes;
      const res = await apply(serverId, ids);
      setResult(res);
      onApplied?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogDescription>{config.description}</DialogDescription>
          <DialogTitle>{config.title}</DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-4 space-y-3">
          {kind === 'volumes' && !result && (
            <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              <span className="font-semibold">Volumes may contain data.</span>{' '}
              Removal is irreversible. Each volume below is currently unreferenced
              by any container — check anything you're sure is junk, leave the
              rest unchecked.
            </div>
          )}

          {!loaded && !error && (
            <div className="font-mono text-xs text-muted-foreground py-4">Loading…</div>
          )}

          {loaded && !result && rows.length === 0 && (
            <div className="text-xs text-muted-foreground italic py-4">
              Nothing reclaimable in this category right now.
            </div>
          )}

          {loaded && !result && rows.length > 0 && (
            <>
              <div className="flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                <label className="cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.size === rows.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selected.size > 0 && selected.size < rows.length;
                    }}
                    onChange={(e) => toggleAll(e.target.checked)}
                    className="mr-2"
                  />
                  {selected.size} / {rows.length} selected
                </label>
                <span>
                  freeing {formatBytesAbs(totalSelectedBytes)}
                </span>
              </div>

              <div className="rounded-md border max-h-[55vh] overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr className="text-left text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                      <th className="w-[36px] py-2 pl-3"></th>
                      <th className="py-2 pr-3">{config.columns.primary}</th>
                      {config.columns.secondary && (
                        <th className="py-2 pr-3">{config.columns.secondary}</th>
                      )}
                      <th className="py-2 pr-3 text-right">Size</th>
                      <th className="py-2 pr-3">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.id}
                        className="border-t hover:bg-muted/40 cursor-pointer"
                        onClick={() => toggleOne(r.id)}
                      >
                        <td className="py-1.5 pl-3">
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() => toggleOne(r.id)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </td>
                        <td className="py-1.5 pr-3 font-mono truncate max-w-[280px]">
                          {r.primary}
                        </td>
                        {config.columns.secondary && (
                          <td className="py-1.5 pr-3 font-mono text-muted-foreground truncate max-w-[200px]">
                            {r.secondary || '—'}
                          </td>
                        )}
                        <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                          {formatBytesAbs(r.sizeBytes)}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-muted-foreground">
                          {r.age}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {result && <ResultView result={result} rows={rows} />}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-6 py-3">
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button
              variant="destructive"
              disabled={pending || selected.size === 0}
              onClick={() => void handleApply()}
            >
              {pending
                ? 'Removing…'
                : `Reclaim ${selected.size} item${selected.size === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

// Per-row primary/secondary projections so the table renderer stays generic.
async function fetchList(
  serverId: string,
  kind: ReclaimKind,
  signal?: AbortSignal,
): Promise<Row[]> {
  switch (kind) {
    case 'images': {
      const data = await listReclaimableImages(serverId, signal);
      return data.map(imageToRow);
    }
    case 'containers': {
      const data = await listReclaimableContainers(serverId, signal);
      return data.map(containerToRow);
    }
    case 'volumes': {
      const data = await listReclaimableVolumes(serverId, signal);
      return data.map(volumeToRow);
    }
  }
}

function imageToRow(i: ReclaimableImage): Row {
  return {
    id: i.id,
    primary: i.repoTag,
    sizeBytes: i.sizeBytes,
    age: ageOf(i.createdAt),
  };
}

function containerToRow(c: ReclaimableContainer): Row {
  return {
    id: c.id,
    primary: c.name || c.id.slice(0, 12),
    secondary: `${c.image} · ${c.state}`,
    sizeBytes: c.sizeBytes,
    age: ageOf(c.createdAt),
  };
}

function volumeToRow(v: ReclaimableVolume): Row {
  return {
    id: v.name,
    primary: v.name,
    sizeBytes: v.sizeBytes,
    age: v.createdAt ? ageOf(v.createdAt) : '—',
  };
}

// Short human-readable age. Backend ships ISO-8601; we render "3d", "5h",
// "12m", "just now" — enough granularity for "is this fresh or stale?"
// without taking up a wide column.
function ageOf(iso: string): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!then) return '—';
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

interface KindConfig {
  title: string;
  description: string;
  columns: { primary: string; secondary?: string };
}

const KIND_CONFIG: Record<ReclaimKind, KindConfig> = {
  images: {
    title: 'Reclaim images',
    description: 'Unused images',
    columns: { primary: 'Tag' },
  },
  containers: {
    title: 'Reclaim stopped containers',
    description: 'Non-running containers',
    columns: { primary: 'Name', secondary: 'Image · State' },
  },
  volumes: {
    title: 'Reclaim volumes',
    description: 'Unreferenced volumes — may contain data',
    columns: { primary: 'Volume name' },
  },
};

function ResultView({ result, rows }: { result: ReclaimResult; rows: Row[] }) {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const items = result.items ?? [];
  return (
    <div className="space-y-2">
      <div className="text-xs font-mono">
        <span className="text-primary">{result.successCount} removed</span>
        {result.skippedCount > 0 && (
          <span className="text-warn"> · {result.skippedCount} skipped</span>
        )}
        {result.errorCount > 0 && (
          <span className="text-destructive"> · {result.errorCount} failed</span>
        )}
      </div>
      {items.length > 0 && (
        <div className="rounded-md border max-h-[40vh] overflow-auto text-xs">
          {items.map((it) => {
            const row = byId.get(it.id);
            const label = row?.primary ?? it.id.slice(0, 12);
            const tone =
              it.status === 'ok'
                ? 'text-primary'
                : it.status === 'skipped'
                  ? 'text-warn'
                  : 'text-destructive';
            return (
              <div
                key={it.id}
                className="flex items-center gap-2 border-t first:border-t-0 px-3 py-1.5 font-mono"
              >
                <span className={`text-[10px] uppercase tracking-wider ${tone}`}>
                  {it.status}
                </span>
                <span className="truncate">{label}</span>
                {it.error && (
                  <span className="ml-auto text-muted-foreground truncate">
                    {it.error}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
