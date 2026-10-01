import type { FsEntry } from '@/types';
import { baseName, joinPath } from '../fsPath';

// Plans a copy/move of files and folders from one server to another. The
// browser lists each source folder (breadth-first, so parents come before
// children), the destination folders are recreated, and every file becomes
// one gate transfer. Symlinks and special files are not transferable and
// are reported as skipped.

export const CROSS_CONFIRM_FILES = 1000;
export const CROSS_MAX_FILES = 20000;

export interface CrossSource {
  path: string;
  isDir: boolean;
  size: number;
  // Entry type when known; links and special files are not transferable.
  type?: FsEntry['type'];
}

export interface CrossTop {
  path: string;
  name: string;
  isDir: boolean;
  dirs: string[];
}

export interface CrossFile {
  top: string;
  srcPath: string;
  rel: string;
  size: number;
}

export interface CrossPlan {
  tops: CrossTop[];
  files: CrossFile[];
  totalBytes: number;
  skipped: string[];
}

export class TooManyFilesError extends Error {
  constructor(max: number) {
    super(`Too many files to copy across servers in one go (limit ${max.toLocaleString('en-US')})`);
    this.name = 'TooManyFilesError';
  }
}

export type Lister = (path: string) => Promise<FsEntry[]>;

export async function planCrossTransfer(
  sources: readonly CrossSource[],
  list: Lister,
  max = CROSS_MAX_FILES,
  onDir?: (scanned: number) => void,
): Promise<CrossPlan> {
  let scanned = 0;
  const plan: CrossPlan = { tops: [], files: [], totalBytes: 0, skipped: [] };
  const addFile = (f: CrossFile) => {
    if (plan.files.length >= max) throw new TooManyFilesError(max);
    plan.files.push(f);
    plan.totalBytes += f.size;
  };

  for (const s of sources) {
    const name = baseName(s.path);
    if (!s.isDir && s.type !== undefined && s.type !== 'file') {
      plan.skipped.push(s.path);
      continue;
    }
    if (!s.isDir) {
      plan.tops.push({ path: s.path, name, isDir: false, dirs: [] });
      addFile({ top: s.path, srcPath: s.path, rel: '', size: s.size });
      continue;
    }
    const top: CrossTop = { path: s.path, name, isDir: true, dirs: [] };
    plan.tops.push(top);
    const queue: string[] = [''];
    while (queue.length > 0) {
      const rel = queue.shift()!;
      const entries = await list(rel ? joinPath(s.path, rel) : s.path);
      onDir?.(++scanned);
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.type === 'dir') {
          top.dirs.push(childRel);
          queue.push(childRel);
        } else if (e.type === 'file') {
          addFile({ top: s.path, srcPath: e.path, rel: childRel, size: e.size });
        } else {
          plan.skipped.push(e.path);
        }
      }
    }
  }
  return plan;
}

// For a move: the top-level sources that may now be deleted at the source —
// every file under them completed and nothing under them was skipped.
export function topsToDelete(
  plan: CrossPlan,
  done: ReadonlySet<string>,
  kept: ReadonlySet<string>,
): string[] {
  return plan.tops
    .filter((t) => !kept.has(t.path))
    .filter((t) => plan.files.every((f) => f.top !== t.path || done.has(f.srcPath)))
    .filter((t) => !plan.skipped.some((p) => p === t.path || p.startsWith(t.path + '/')))
    .map((t) => t.path);
}
