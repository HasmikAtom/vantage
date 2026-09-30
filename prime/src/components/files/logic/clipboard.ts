import { baseName, copyName, isSameOrDescendant, joinPath, parentOf } from '../fsPath';

// Vantage-internal clipboard for Cut / Copy / Paste. Not the OS clipboard:
// it holds host paths on a specific server and lives for the page session.

export interface ClipItem {
  path: string;
  isDir: boolean;
  size: number;
}

export interface FsClipboard {
  serverId: string;
  items: ClipItem[];
  mode: 'copy' | 'cut';
}

export interface LocalOp {
  from: string;
  to: string;
  isDir: boolean;
  mode: 'copy' | 'move';
}

export interface Refused {
  path: string;
  reason: string;
}

export type PastePlan =
  | { kind: 'local'; ops: LocalOp[]; refused: Refused[] }
  | { kind: 'transfer'; files: ClipItem[]; refused: Refused[] };

// planPaste decides what a paste into targetDir does. takenNames are the
// names already present in targetDir (used for "name (copy)").
export function planPaste(
  clip: FsClipboard,
  serverId: string,
  targetDir: string,
  takenNames: ReadonlySet<string>,
): PastePlan {
  const refused: Refused[] = [];
  if (clip.serverId !== serverId) {
    const files: ClipItem[] = [];
    for (const it of clip.items) {
      if (it.isDir) refused.push({ path: it.path, reason: 'folders cannot be sent between servers yet' });
      else files.push(it);
    }
    return { kind: 'transfer', files, refused };
  }

  const taken = new Set(takenNames);
  const ops: LocalOp[] = [];
  const mode = clip.mode === 'cut' ? 'move' : 'copy';
  for (const it of clip.items) {
    if (it.isDir && isSameOrDescendant(it.path, targetDir)) {
      refused.push({ path: it.path, reason: 'cannot paste a folder into itself' });
      continue;
    }
    if (parentOf(it.path) === targetDir) {
      if (mode === 'move') {
        refused.push({ path: it.path, reason: 'already in this folder' });
        continue;
      }
      const name = copyName(baseName(it.path), it.isDir, taken);
      taken.add(name);
      ops.push({ from: it.path, to: joinPath(targetDir, name), isDir: it.isDir, mode });
      continue;
    }
    ops.push({ from: it.path, to: joinPath(targetDir, baseName(it.path)), isDir: it.isDir, mode });
  }
  return { kind: 'local', ops, refused };
}

type Listener = () => void;
let current: FsClipboard | null = null;
const listeners = new Set<Listener>();

export const clipboardStore = {
  get(): FsClipboard | null {
    return current;
  },
  set(c: FsClipboard | null): void {
    current = c;
    listeners.forEach((l) => l());
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
