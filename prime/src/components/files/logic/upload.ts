import { joinPath } from '../fsPath';

export interface UploadFile {
  relDir: string;
  file: File;
}

export interface UploadPlan {
  dirs: string[];
  files: UploadFile[];
}

// planUploadTree turns relative paths from a folder drop or a
// <input webkitdirectory> into the directories to create (parents first)
// and the files to upload into each.
export function planUploadTree(
  items: readonly { relPath: string; file: File }[],
  emptyDirs: readonly string[] = [],
): UploadPlan {
  const dirs = new Set<string>();
  const addWithAncestors = (rel: string) => {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  };
  const files = items.map(({ relPath, file }) => {
    const i = relPath.lastIndexOf('/');
    const relDir = i < 0 ? '' : relPath.slice(0, i);
    if (relDir) addWithAncestors(relDir);
    return { relDir, file };
  });
  for (const d of emptyDirs) addWithAncestors(d);
  const depth = (s: string) => s.split('/').length;
  return {
    dirs: [...dirs].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)),
    files,
  };
}

export function joinRel(base: string, rel: string): string {
  return rel === '' ? base : rel.split('/').reduce(joinPath, base);
}
