import { describe, expect, it } from 'vitest';
import type { FsEntry, FsEntryType } from '@/types';
import { BulkRun, failedItems } from './logic/bulk';
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

const noConflict = { onConflict: () => Promise.reject(new Error('unexpected')), onUpdate: () => {} };

// Like useBulkRunner: run, then let the caller finish (onSettled).
const runBulk: RunBulk = async (_title, items, op, opts) => {
  const states = await new BulkRun(items, op, noConflict, opts?.concurrency ?? 4).start();
  await opts?.onSettled?.(states);
  return states;
};

// Same, but the user presses "Retry failed" once after the first pass.
const runBulkWithRetry: RunBulk = async (title, items, op, opts) => {
  const first = await runBulk(title, items, op, opts);
  const failed = failedItems(first);
  if (failed.length > 0) await runBulk(title, failed, op, opts);
  return first;
};

function setup(opts: { existing?: Record<string, FsEntryType>; failSrc?: string; failOnce?: string; over?: Partial<CrossDeps> } = {}) {
  const failedOnce = new Set<string>();
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
      if (opts.failOnce && id.endsWith(`|${opts.failOnce}`) && !failedOnce.has(opts.failOnce)) {
        failedOnce.add(opts.failOnce);
        throw new Error('network blip');
      }
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

describe('runCrossTransfer — review fixes', () => {
  const two = [
    { path: '/src/f.txt', isDir: false, size: 3 },
    { path: '/src/g.txt', isDir: false, size: 1 },
  ];

  it('"Cancel all" in the conflict prompt stops the whole run', async () => {
    const { d, calls } = setup({
      existing: { 'f.txt': 'file' },
      over: { askConflict: async () => ({ choice: 'skip', applyToAll: true, cancelled: true }) },
    });
    await runCrossTransfer(d, { serverId: A, items: two }, { serverId: B, dir: '/dst' }, 'move');
    expect(calls.transfers).toEqual([]);
    expect(calls.trash).toEqual([]);
    expect(calls.mkdir).toEqual([]);
  });

  it('a successful retry completes the move', async () => {
    const { d, calls } = setup({ failOnce: '/src/logs/old/b.log', over: { runBulk: runBulkWithRetry } });
    await runCrossTransfer(d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'move');
    expect(calls.trash).toEqual(['/src/logs']);
  });

  it('reports every problem of a run in one message', async () => {
    const { d, calls } = setup();
    await runCrossTransfer(d, { serverId: A, items: [{ path: '/src/withlink', isDir: true, size: 0 }] }, { serverId: B, dir: '/dst' }, 'move');
    expect(calls.errors).toHaveLength(1);
    expect(calls.errors[0]).toMatch(/skipped/);
    expect(calls.errors[0]).toMatch(/kept at the source/);
  });

  it('refuses to start while another cross-server run is still going', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const slow = setup();
    slow.d.api.awaitTransfer = () => hold;
    const first = runCrossTransfer(slow.d, { serverId: A, items: [two[0]!] }, { serverId: B, dir: '/dst' }, 'copy');
    await new Promise((r) => setTimeout(r, 10));
    const second = setup();
    await runCrossTransfer(second.d, { serverId: A, items: [two[1]!] }, { serverId: B, dir: '/dst' }, 'copy');
    expect(second.calls.transfers).toEqual([]);
    expect(second.calls.errors[0]).toMatch(/already running/);
    release();
    await first;
  });

  it('shows scan progress while walking folders, then clears it', async () => {
    const statuses: (string | null)[] = [];
    const { d } = setup({ over: { onStatus: (s) => statuses.push(s) } });
    await runCrossTransfer(d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'copy');
    expect(statuses[0]).toMatch(/Scanning/);
    expect(statuses.some((s) => s !== null && /2 folders/.test(s))).toBe(true);
    expect(statuses[statuses.length - 1]).toBe(null);
  });
});

describe('runCrossTransfer — minor fixes', () => {
  it('names the destination in the large-copy prompt', async () => {
    let asked = '';
    const { d } = setup({ over: { confirm: (m) => { asked = m; return false; } } });
    await runCrossTransfer(d, { serverId: A, items: [{ path: '/src/many', isDir: true, size: 0 }] }, { serverId: B, dir: '/dst', label: 'dev-b:/dst' }, 'copy');
    expect(asked).toBe('Copy 1,001 files (1001 B) to dev-b:/dst?');
  });

  it('returns the sources that were actually moved', async () => {
    const { d } = setup({ failSrc: '/src/logs/old/b.log' });
    const moved = await runCrossTransfer(
      d,
      { serverId: A, items: [logs, { path: '/src/f.txt', isDir: false, size: 3, type: 'file' }] },
      { serverId: B, dir: '/dst' },
      'move',
    );
    expect(moved).toEqual(['/src/f.txt']);
  });

  it('stops with a message when the destination folder cannot be read', async () => {
    const { d, calls } = setup();
    d.api.existing = async () => { throw new Error('permission denied'); };
    await runCrossTransfer(d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'copy');
    expect(calls.transfers).toEqual([]);
    expect(calls.mkdir).toEqual([]);
    expect(calls.errors[0]).toMatch(/Could not read the destination folder: permission denied/);
  });

  it('Cancel during the copy cancels running transfers and keeps the sources', async () => {
    const cancelled: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const cancellingRunBulk: RunBulk = async (_title, items, op, opts) => {
      const run = new BulkRun(items, op, noConflict, opts?.concurrency ?? 4);
      const done = run.start();
      await new Promise((r) => setTimeout(r, 10));
      run.cancel();
      opts?.onCancel?.();
      release();
      const states = await done;
      await opts?.onSettled?.(states);
      return states;
    };
    const { d, calls } = setup({ over: { runBulk: cancellingRunBulk } });
    d.api.awaitTransfer = async () => {
      await hold;
      throw new Error('cancelled');
    };
    d.api.cancelTransfer = async (id) => { cancelled.push(id); };
    await runCrossTransfer(d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'move');
    expect(cancelled.length).toBeGreaterThan(0);
    expect(calls.trash).toEqual([]);
  });

  it('a folder that cannot be created part-way keeps its source on a move', async () => {
    const { d, calls } = setup();
    d.api.mkdir = async (_s, p) => {
      if (p === '/dst/logs/old') throw new Error('no space');
      calls.mkdir.push(p);
    };
    await runCrossTransfer(d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'move');
    expect(calls.transfers).toEqual([]);
    expect(calls.trash).toEqual([]);
    expect(calls.errors[0]).toMatch(/Could not create logs on the destination: no space/);
  });
});

describe('runCrossTransfer — retry messages', () => {
  it('a retry that completes the move replaces the earlier "kept" message', async () => {
    const { d, calls } = setup({ failOnce: '/src/logs/old/b.log', over: { runBulk: runBulkWithRetry } });
    await runCrossTransfer(d, { serverId: A, items: [logs] }, { serverId: B, dir: '/dst' }, 'move');
    expect(calls.errors[0]).toMatch(/kept at the source/);
    expect(calls.errors[calls.errors.length - 1]).toMatch(/All items moved/);
  });

  it('reports skipped links once, not on every pass', async () => {
    const { d, calls } = setup({ failOnce: '/src/withlink/a', over: { runBulk: runBulkWithRetry } });
    await runCrossTransfer(d, { serverId: A, items: [{ path: '/src/withlink', isDir: true, size: 0 }] }, { serverId: B, dir: '/dst' }, 'copy');
    expect(calls.errors.filter((e) => /skipped/.test(e))).toHaveLength(1);
  });
});
