import { describe, expect, it } from 'vitest';
import { clipboardStore, planPaste, type FsClipboard } from './clipboard';

const clip = (mode: 'copy' | 'cut', serverId = 's1'): FsClipboard => ({
  serverId,
  mode,
  items: [
    { path: '/src/a.txt', isDir: false, size: 10 },
    { path: '/src/dir', isDir: true, size: 0 },
  ],
});

describe('planPaste (same server)', () => {
  it('copies into another folder keeping names', () => {
    const p = planPaste(clip('copy'), 's1', '/dst', new Set());
    expect(p).toEqual({
      kind: 'local',
      refused: [],
      ops: [
        { from: '/src/a.txt', to: '/dst/a.txt', isDir: false, mode: 'copy' },
        { from: '/src/dir', to: '/dst/dir', isDir: true, mode: 'copy' },
      ],
    });
  });

  it('cut becomes move', () => {
    const p = planPaste(clip('cut'), 's1', '/dst', new Set());
    expect(p.kind === 'local' && p.ops.every((o) => o.mode === 'move')).toBe(true);
  });

  it('copy into the source folder gets copy names that do not collide', () => {
    const p = planPaste(clip('copy'), 's1', '/src', new Set(['a.txt', 'dir', 'a (copy).txt']));
    expect(p.kind === 'local' && p.ops.map((o) => o.to)).toEqual(['/src/a (copy 2).txt', '/src/dir (copy)']);
  });

  it('cut into the same folder is refused as a no-op', () => {
    const p = planPaste(clip('cut'), 's1', '/src', new Set());
    expect(p.kind === 'local' && p.ops).toEqual([]);
    expect(p.refused.map((r) => r.path)).toEqual(['/src/a.txt', '/src/dir']);
  });

  it('refuses pasting a folder into itself or a descendant', () => {
    const p = planPaste(clip('cut'), 's1', '/src/dir/inner', new Set());
    expect(p.kind === 'local' && p.ops.map((o) => o.from)).toEqual(['/src/a.txt']);
    expect(p.refused).toEqual([{ path: '/src/dir', reason: 'cannot paste a folder into itself' }]);
  });
});

describe('planPaste (other server)', () => {
  it('sends files through a transfer and refuses folders', () => {
    const p = planPaste(clip('copy', 'other'), 's1', '/dst', new Set());
    expect(p.kind).toBe('transfer');
    expect(p.kind === 'transfer' && p.files.map((f) => f.path)).toEqual(['/src/a.txt']);
    expect(p.refused).toEqual([{ path: '/src/dir', reason: 'folders cannot be sent between servers yet' }]);
  });
});

describe('clipboardStore', () => {
  it('notifies subscribers and unsubscribes', () => {
    let calls = 0;
    const off = clipboardStore.subscribe(() => calls++);
    clipboardStore.set(clip('copy'));
    expect(clipboardStore.get()?.mode).toBe('copy');
    off();
    clipboardStore.set(null);
    expect(calls).toBe(1);
    expect(clipboardStore.get()).toBe(null);
  });
});
