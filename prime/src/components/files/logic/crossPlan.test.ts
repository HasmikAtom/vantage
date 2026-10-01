import { describe, expect, it } from 'vitest';
import type { FsEntry } from '@/types';
import { TooManyFilesError, planCrossTransfer, topsToDelete, type Lister } from './crossPlan';

const E = (path: string, type: FsEntry['type'] = 'file', size = 1): FsEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1), path, type, size,
  mode: 0o644, modeStr: '', owner: '', group: '', uid: 0, gid: 0, mtime: 0,
});

const tree: Record<string, FsEntry[]> = {
  '/src/logs': [E('/src/logs/a.log', 'file', 10), E('/src/logs/old', 'dir'), E('/src/logs/link', 'symlink')],
  '/src/logs/old': [E('/src/logs/old/b.log', 'file', 5), E('/src/logs/old/deep', 'dir')],
  '/src/logs/old/deep': [],
};
const list: Lister = async (p) => {
  const l = tree[p];
  if (!l) throw new Error(`no such dir ${p}`);
  return l;
};

describe('planCrossTransfer', () => {
  it('walks folders breadth-first, collecting files and folders and skipping links', async () => {
    const plan = await planCrossTransfer([{ path: '/src/logs', isDir: true, size: 0 }], list);
    expect(plan.tops).toEqual([{ path: '/src/logs', name: 'logs', isDir: true, dirs: ['old', 'old/deep'] }]);
    expect(plan.files).toEqual([
      { top: '/src/logs', srcPath: '/src/logs/a.log', rel: 'a.log', size: 10 },
      { top: '/src/logs', srcPath: '/src/logs/old/b.log', rel: 'old/b.log', size: 5 },
    ]);
    expect(plan.totalBytes).toBe(15);
    expect(plan.skipped).toEqual(['/src/logs/link']);
  });

  it('takes a top-level file as one item', async () => {
    const plan = await planCrossTransfer([{ path: '/src/f.txt', isDir: false, size: 3 }], list);
    expect(plan.tops).toEqual([{ path: '/src/f.txt', name: 'f.txt', isDir: false, dirs: [] }]);
    expect(plan.files).toEqual([{ top: '/src/f.txt', srcPath: '/src/f.txt', rel: '', size: 3 }]);
  });

  it('stops with TooManyFilesError past the cap', async () => {
    await expect(planCrossTransfer([{ path: '/src/logs', isDir: true, size: 0 }], list, 1)).rejects.toBeInstanceOf(TooManyFilesError);
  });

  it('propagates listing errors', async () => {
    await expect(planCrossTransfer([{ path: '/nope', isDir: true, size: 0 }], list)).rejects.toThrow('no such dir /nope');
  });
});

describe('topsToDelete', () => {
  it('deletes a top only when all its files completed and nothing inside was skipped', async () => {
    const plan = await planCrossTransfer(
      [
        { path: '/src/logs', isDir: true, size: 0 },
        { path: '/src/logs/old', isDir: true, size: 0 },
        { path: '/src/f.txt', isDir: false, size: 3 },
      ],
      list,
    );
    const allDone = new Set(plan.files.map((f) => f.srcPath));
    // logs has a skipped symlink → kept; old fully done → deleted; f.txt done → deleted
    expect(topsToDelete(plan, allDone, new Set())).toEqual(['/src/logs/old', '/src/f.txt']);
    // a failed file keeps its top
    const oneFailed = new Set([...allDone].filter((p) => p !== '/src/logs/old/b.log'));
    expect(topsToDelete(plan, oneFailed, new Set())).toEqual(['/src/f.txt']);
    // a top the user skipped is kept
    expect(topsToDelete(plan, allDone, new Set(['/src/f.txt']))).toEqual(['/src/logs/old']);
  });
});
