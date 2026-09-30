import type { FsEntryType } from '@/types';
import type { RunOptions } from './bulk';

// The outpost answers 409 for a file landing on an existing file, but a
// plain 400 ("destination is an existing directory") whenever a folder is
// involved, which would fail the item without offering Keep both. Decide
// those cases here from the destination listing instead.
export function preflightConflict(
  sourceIsDir: boolean,
  existing: FsEntryType | undefined,
  opts: RunOptions,
): 'conflict' | 'cannot-replace-folder' | null {
  if (existing === undefined || opts.keepBoth) return null;
  if (!sourceIsDir && existing !== 'dir') return null;
  return opts.overwrite ? 'cannot-replace-folder' : 'conflict';
}
