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
    { path: '/a/one.txt', type: 'file' },
    { path: '/a/two.txt', type: 'file' },
  ],
};

function actions(statusFor: (id: string) => ItemState['status']) {
  const runBulk: RunBulk = async (_title, items) =>
    items.map((item): ItemState => ({ item, status: statusFor(item.id), error: null }));
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

  it('clears the clipboard when everything moved', async () => {
    await actions(() => 'done').paste(cut, '/b');
    expect(clipboardStore.get()).toBeNull();
  });
});
