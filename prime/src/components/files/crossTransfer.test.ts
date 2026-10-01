import { describe, expect, it } from 'vitest';
import type { FsEntry, FsEntryType } from '@/types';
import { BulkRun } from './logic/bulk';
import type { RunBulk } from './hooks/useBulkRunner';
import { runCrossTransfer, type CrossApi, type CrossDeps } from './crossTransfer';

const E = (path: string, type: FsEntry['type'] = 'file', size = 1): FsEntry => ({
  name: path.slice(path.lastIndexOf('/') + 1), path, type, size,
  mode: 0o644, modeStr: '', owner: '', group: '', uid: 0, gid: 0, mtime: 0,
});

const tree: Record<string, FsEntry[]> = {
  '/src/logs': [E('/src/logs/a.log', 'file', 10), E('/src/logs/old', 'dir')],
  '/src/logs/old': [E('/src/logs/old/b.log', 'file', 5)],
  '/src/withlink': [E('/src/withlink/a', 'file'), E('/src/withlink/l', 'symlink')],
  '/src/many': Array.from({ length: 1001 }, (_, i) => E(`/src/many/f${i}`)),
};

const runBulk: RunBulk = (_title, items, op, opts) =>
  new BulkRun(items, op, { onConflict: () => Promise.reject(new Error('unexpected')), onUpdate: () => {} }, opts?.concurrency ?? 4).start();

function setup(opts: { existing?: Record<string, FsEntryType>; failSrc?: string; over?: Partial<CrossDeps> } = {}) {
  const calls = {
    mkdir: [] as string[],
    transfers: [] as { srcPath: string; dstPath: string; overwrite: boolean }[],
    trash: [] as string[],
    errors: [] as string[],
    touched: [] as string[],
  };
  let n = 0;
  const api: CrossApi = {
    list: async (_s, p) => {
      const l = tree[p];
      if (!l) throw new Error(`no such dir ${p}`);
      return l;
    },
    existing: async () => new Map(Object.entries(opts.existing ?? {})),
    mkdir: async (_s, p) => { calls.mkdir.push(p); },
    startTransfer: async (req) => {
      calls.transfers.push({ srcPath: req.srcPath, dstPath: req.dstPath, overwrite: req.overwrite });
      return `t${n++}|${req.srcPath}`;
    },
    awaitTransfer: async (id) => {
      if (opts.failSrc && id.endsWith(`|${opts.failSrc}`)) throw new Error('disk full');
    },
    cancelTransfer: async () => {},
    trash: async (_s, p) => { calls.trash.push(p); },
  };
  const d: CrossDeps = {
    api,
    runBulk,
    askConflict: async () => ({ choice: 'skip', applyToAll: false }),
    confirm: () => true,
    onError: (m) => calls.errors.push(m),
    afterMutation: async (sid, dirs) => { calls.touched.push(`${sid}:${dirs.join(',')}`); },
    ...opts.over,
  };
  return { d, calls };
}

const logs = { path: '/src/logs', isDir: true, size: 0 };
const A = 'srv-a';
const B = 'srv-b';

describe('runCrossTransfer', () => {
  it('copies a folder tree: folders first, then one transfer per file, nothing deleted', async () => {
    const { d, calls } = setup();
    await runCrossTransfer(d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'copy');
    expect(calls.mkdir).toEqual(['/dst/logs', '/dst/logs/old']);
    expect(calls.transfers).toEqual([
      { srcPath: '/src/logs/a.log', dstPath: '/dst/logs/a.log', overwrite: false },
      { srcPath: '/src/logs/old/b.log', dstPath: '/dst/logs/old/b.log', overwrite: false },
    ]);
    expect(calls.trash).toEqual([]);
    expect(calls.touched).toContain(`${B}:/dst`);
  });

  it('move deletes the source only when every file arrived', async () => {
    const ok = setup();
    await runCrossTransfer(ok.d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'move');
    expect(ok.calls.trash).toEqual(['/src/logs']);

    const failing = setup({ failSrc: '/src/logs/old/b.log' });
    await runCrossTransfer(failing.d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'move');
    expect(failing.calls.trash).toEqual([]);
    expect(failing.calls.errors.join(' ')).toMatch(/kept at the source/);
  });

  it('move keeps a folder that contains something that cannot be transferred', async () => {
    const { d, calls } = setup();
    await runCrossTransfer(d, { serverId: A, items: [{ path: '/src/withlink', isDir: true, size: 0 }] }, { serverId: B, dir: '/dst' }, 'move');
    expect(calls.trash).toEqual([]);
    expect(calls.errors.join(' ')).toMatch(/skipped/);
  });

  it('Keep both renames the top-level folder on the destination', async () => {
    const { d, calls } = setup({
      existing: { logs: 'dir' },
      over: { askConflict: async () => ({ choice: 'keepBoth', applyToAll: false }) },
    });
    await runCrossTransfer(d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'copy');
    expect(calls.mkdir[0]).toBe('/dst/logs (copy)');
    expect(calls.transfers[0]?.dstPath).toBe('/dst/logs (copy)/a.log');
  });

  it('Replace is refused for folders and overwrites for files', async () => {
    const folder = setup({
      existing: { logs: 'dir' },
      over: { askConflict: async () => ({ choice: 'replace', applyToAll: false }) },
    });
    await runCrossTransfer(folder.d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'copy');
    expect(folder.calls.transfers).toEqual([]);
    expect(folder.calls.errors.join(' ')).toMatch(/folders can't be replaced/);

    const file = setup({
      existing: { 'f.txt': 'file' },
      over: { askConflict: async () => ({ choice: 'replace', applyToAll: false }) },
    });
    await runCrossTransfer(file.d, { serverId: A, items: [{ path: '/src/f.txt', isDir: false, size: 3 }] }, { serverId: B, dir: '/dst' }, 'copy');
    expect(file.calls.transfers).toEqual([{ srcPath: '/src/f.txt', dstPath: '/dst/f.txt', overwrite: true }]);
  });

  it('Skip leaves that item alone', async () => {
    const { d, calls } = setup({ existing: { logs: 'dir' } });
    await runCrossTransfer(d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'move');
    expect(calls.mkdir).toEqual([]);
    expect(calls.transfers).toEqual([]);
    expect(calls.trash).toEqual([]);
  });

  it('asks before copying more than 1,000 files and stops on No', async () => {
    let asked = '';
    const { d, calls } = setup({ over: { confirm: (m) => { asked = m; return false; } } });
    await runCrossTransfer(d, { serverId: A, items: [{ path: '/src/many', isDir: true, size: 0 }] }, { serverId: B, dir: '/dst' }, 'copy');
    expect(asked).toMatch(/1,001 files/);
    expect(calls.mkdir).toEqual([]);
    expect(calls.transfers).toEqual([]);
  });

  it('reports a source that cannot be read', async () => {
    const { d, calls } = setup();
    await runCrossTransfer(d, { serverId: A, items: [{ path: '/nope', isDir: true, size: 0 }] }, { serverId: B, dir: '/dst' }, 'copy');
    expect(calls.errors[0]).toMatch(/Could not read/);
  });
});
