import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api', () => ({
  fsCopy: vi.fn(async () => {}),
  fsDelete: vi.fn(async () => {}),
  fsDownloadURL: vi.fn(),
  fsMkdir: vi.fn(async () => {}),
  fsMove: vi.fn(async () => {}),
  fsRename: vi.fn(async () => {}),
  fsUpload: vi.fn(async () => {}),
  fsWrite: vi.fn(async () => {}),
}));
vi.mock('./hooks/useDirListing', () => ({
  fetchListing: vi.fn(async () => ({ entries: [] })),
}));

import { createFileActions } from './useFileActions';
import { clipboardStore, type FsClipboard } from './logic/clipboard';
import type { RunBulk } from './hooks/useBulkRunner';
import type { ItemState } from './logic/bulk';

const cut: FsClipboard = {
  serverId: 's1',
  mode: 'cut',
  items: [
    { path: '/a/one.txt', isDir: false, size: 3, type: 'file' },
    { path: '/a/two.txt', isDir: false, size: 3, type: 'file' },
  ],
};

function actions(statusFor: (id: string) => ItemState['status']) {
  const runBulk: RunBulk = async (_title, items, _op, opts) => {
    const states = items.map((item): ItemState => ({ item, status: statusFor(item.id), error: null }));
    // Like the real runner: a refused run (all cancelled) never settles.
    if (!states.every((st) => st.status === 'cancelled')) await opts?.onSettled?.(states);
    return states;
  };
  return createFileActions({ serverId: 's1', runBulk, afterMutation: async () => {}, onError: () => {} });
}

describe('paste of a cut', () => {
  beforeEach(() => clipboardStore.set(cut));

  it('keeps the clipboard when the run was refused (another operation running)', async () => {
    await actions(() => 'cancelled').paste(cut, '/b');
    expect(clipboardStore.get()).toEqual(cut);
  });

  it('drops only the items that moved', async () => {
    await actions((id) => (id === '/a/one.txt' ? 'done' : 'failed')).paste(cut, '/b');
    expect(clipboardStore.get()?.items.map((i) => i.path)).toEqual(['/a/two.txt']);
  });

  it('drops items that a "Retry failed" pass moves', async () => {
    // The retry runs through the bulk runner, not paste(), so the clipboard
    // update has to happen in onSettled, which runs after every pass.
    let settled: ((states: ItemState[]) => void | Promise<void>) | undefined;
    const runBulk: RunBulk = async (_t, items, _op, opts) => {
      settled = opts?.onSettled;
      const states = items.map((item): ItemState => ({ item, status: item.id === '/a/one.txt' ? 'done' : 'failed', error: null }));
      await opts?.onSettled?.(states);
      return states;
    };
    const a = createFileActions({ serverId: 's1', runBulk, afterMutation: async () => {}, onError: () => {} });
    await a.paste(cut, '/b');
    expect(clipboardStore.get()?.items.map((i) => i.path)).toEqual(['/a/two.txt']);
    await settled!([{ item: { id: '/a/two.txt', label: 'two.txt' }, status: 'done', error: null }]);
    expect(clipboardStore.get()).toBeNull();
  });

  it('clears the clipboard when everything moved', async () => {
    await actions(() => 'done').paste(cut, '/b');
    expect(clipboardStore.get()).toBeNull();
  });
});

describe('bulk actions report a crash instead of rejecting', () => {
  it('trash, transfer, paste and upload turn a thrown error into onError', async () => {
    const errors: string[] = [];
    const a = createFileActions({
      serverId: 's1',
      runBulk: async () => { throw new Error('runner blew up'); },
      afterMutation: async () => {},
      onError: (m) => errors.push(m),
    });
    const entry = { name: 'x', path: '/a/x', type: 'file' as const, size: 1, mode: 0o644, mtime: '' };
    await expect(a.trash([entry as never])).resolves.toBeUndefined();
    await expect(a.transfer([{ path: '/a/x', isDir: false }], '/b', 'copy')).resolves.toBeUndefined();
    await expect(a.paste(cut, '/b')).resolves.toBeUndefined();
    await expect(a.upload({ dirs: [], files: [{ relDir: '', file: new File(['1'], 'f') }] } as never, '/b')).resolves.toBeUndefined();
    expect(errors).toEqual(Array(4).fill('runner blew up'));
  });
});
