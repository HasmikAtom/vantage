import { isSameOrDescendant, parentOf } from '../fsPath';

// MIME type for drags that start inside the explorer. The payload is
// JSON {serverId, paths}; OS file drops carry 'Files' instead.
export const VANTAGE_DND_TYPE = 'application/x-vantage-paths';

export function dropMode(e: { ctrlKey: boolean; metaKey: boolean }): 'copy' | 'move' {
  return e.ctrlKey || e.metaKey ? 'copy' : 'move';
}

// canDropInto refuses drops that would be a no-op (items already live in
// targetDir) or destructive (a folder into itself or its descendant).
export function canDropInto(sources: readonly string[], targetDir: string): boolean {
  if (sources.length === 0) return false;
  return sources.every((s) => !isSameOrDescendant(s, targetDir) && parentOf(s) !== targetDir);
}

// Between servers a plain drag copies (like dragging between drives in
// Windows); Shift makes it a move. On one server the existing rule holds.
export function crossDropMode(
  e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  sameServer: boolean,
): 'copy' | 'move' {
  if (sameServer) return dropMode(e);
  return e.shiftKey ? 'move' : 'copy';
}

export function canDropAcross(
  sourceServer: string,
  sources: readonly string[],
  targetServer: string,
  targetDir: string,
): boolean {
  if (sources.length === 0) return false;
  return sourceServer === targetServer ? canDropInto(sources, targetDir) : true;
}
