import { formatBytes } from '../fsPath';

// Folder-size state for one listing, driven by the outpost's
// GET /fs/sizes SSE stream. 'pending' renders a spinner, 'none' a dash.

export type SizeInfo =
  | { state: 'pending' }
  | { state: 'done'; bytes: number; partial: boolean }
  | { state: 'none' };

export type SizeMap = ReadonlyMap<string, SizeInfo>;

export interface SizeEvent {
  path: string;
  bytes: number;
  files: number;
  partial: boolean;
}

export function initialSizes(dirPaths: readonly string[], supported: boolean): Map<string, SizeInfo> {
  const state: SizeInfo = supported ? { state: 'pending' } : { state: 'none' };
  return new Map(dirPaths.map((p) => [p, state]));
}

export function applySizeEvent(m: SizeMap, ev: SizeEvent): Map<string, SizeInfo> {
  const next = new Map(m);
  if (next.has(ev.path)) next.set(ev.path, { state: 'done', bytes: ev.bytes, partial: ev.partial });
  return next;
}

export function settleSizes(m: SizeMap): Map<string, SizeInfo> {
  const next = new Map(m);
  for (const [k, v] of next) if (v.state === 'pending') next.set(k, { state: 'none' });
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
  return (info.partial ? '≥ ' : '') + formatBytes(info.bytes);
}
