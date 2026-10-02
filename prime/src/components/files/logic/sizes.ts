import { formatBytes } from '../fsPath';

// Folder-size state for one listing, driven by the outpost's
// GET /fs/sizes SSE stream. 'pending' renders a spinner, 'none' a dash.

export type SizeInfo =
  | { state: 'pending' }
  // running: a progress update, the walk is still counting (only set when true).
  | { state: 'done'; bytes: number; partial: boolean; running?: true }
  | { state: 'none' };

export type SizeMap = ReadonlyMap<string, SizeInfo>;

export interface SizeEvent {
  path: string;
  bytes: number;
  files: number;
  partial: boolean;
  // Progress update from a walk that's still going (outposts 1.4.10+).
  running?: boolean;
}

export function initialSizes(dirPaths: readonly string[], supported: boolean): Map<string, SizeInfo> {
  const state: SizeInfo = supported ? { state: 'pending' } : { state: 'none' };
  return new Map(dirPaths.map((p) => [p, state]));
}

export function applySizeEvent(m: SizeMap, ev: SizeEvent): Map<string, SizeInfo> {
  const next = new Map(m);
  if (next.has(ev.path)) {
    next.set(
      ev.path,
      ev.running
        ? { state: 'done', bytes: ev.bytes, partial: true, running: true }
        : { state: 'done', bytes: ev.bytes, partial: ev.partial },
    );
  }
  return next;
}

export function settleSizes(m: SizeMap): Map<string, SizeInfo> {
  const next = new Map(m);
  for (const [k, v] of next) {
    if (v.state === 'pending') next.set(k, { state: 'none' });
    // The stream ended mid-count: the last total is a lower bound.
    else if (v.state === 'done' && v.running) next.set(k, { state: 'done', bytes: v.bytes, partial: true });
  }
  return next;
}

// An error before the first event means the outpost has no /fs/sizes
// (older version) or refuses it; remember that for the session so the
// SPA stops asking.
export function onStreamError(
  m: SizeMap,
  receivedAny: boolean,
): { sizes: Map<string, SizeInfo>; unsupported: boolean } {
  return { sizes: settleSizes(m), unsupported: !receivedAny };
}

export function formatDirSize(info: SizeInfo | undefined): string {
  if (!info || info.state === 'none') return '—';
  if (info.state === 'pending') return '';
  return (info.partial ? '≥ ' : '') + formatBytes(info.bytes) + (info.running ? '…' : '');
}
