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
