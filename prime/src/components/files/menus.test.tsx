import { describe, expect, it } from 'vitest';
import type { FsEntry } from '@/types';
import type { MenuEntry } from '@/components/ui/context-menu';
import { backgroundMenu, itemMenu, type MenuCtx } from './menus';

const noop = () => {};
const ctx = (over: Partial<MenuCtx> = {}): MenuCtx => ({
  canControl: true, canAdmin: true, hasClipboard: true, showHidden: false,
  open: noop, edit: noop, download: noop, cut: noop, copy: noop, paste: noop,
  rename: noop, copyTo: noop, moveTo: noop, copyPath: noop, sendTo: noop, perms: noop,
  trash: noop, newItem: noop, uploadFiles: noop, uploadFolder: noop, refresh: noop,
  toggleHidden: noop, openTrashBin: noop,
  ...over,
});

const entry = (name: string, type: FsEntry['type'] = 'file', size = 10): FsEntry => ({
  name, path: '/d/' + name, type, size, mode: 0o644, modeStr: '', owner: 'root', group: 'root', uid: 0, gid: 0, mtime: 0,
});

const labels = (m: MenuEntry[]) => m.flatMap((x) => (x.kind === 'item' ? [x.label] : []));
const find = (m: MenuEntry[], label: string) => {
  const it = m.find((x) => x.kind === 'item' && x.label === label);
  if (!it || it.kind !== 'item') throw new Error(`no ${label}`);
  return it;
};

describe('itemMenu', () => {
  it('offers single-item actions for one file', () => {
    const m = itemMenu([entry('a.txt')], ctx());
    expect(labels(m)).toEqual([
      'Open', 'Edit', 'Download', 'Cut', 'Copy', 'Rename', 'Copy to…', 'Move to…', 'Copy path',
      'Send to another server…', 'Permissions…', 'Move to trash',
    ]);
  });

  it('offers paste-into and pin for a folder when available', () => {
    const m = itemMenu([entry('dir', 'dir')], ctx({ pin: noop }));
    expect(labels(m)).toContain('Paste into folder');
    expect(labels(m)).toContain('Pin to sidebar');
    expect(labels(m)).not.toContain('Send to another server…');
  });

  it('keeps only bulk actions for several items', () => {
    const m = itemMenu([entry('a'), entry('b'), entry('c', 'dir')], ctx());
    expect(labels(m)).toEqual(['Download 2 files', 'Cut', 'Copy', 'Move 3 items to trash']);
  });

  it('hides Edit for files over 1 MiB', () => {
    expect(labels(itemMenu([entry('big.log', 'file', (1 << 20) + 1)], ctx()))).not.toContain('Edit');
  });

  it('disables mutating items for a viewer, with the role hint', () => {
    const m = itemMenu([entry('a.txt')], ctx({ canControl: false, canAdmin: false }));
    for (const label of ['Cut', 'Rename', 'Copy to…', 'Move to…', 'Send to another server…', 'Move to trash']) {
      expect(find(m, label)).toMatchObject({ disabled: true, title: 'Operator role required' });
    }
    expect(find(m, 'Permissions…')).toMatchObject({ disabled: true, title: 'Admin role required' });
    expect(find(m, 'Copy').disabled).toBe(false);
    expect(find(m, 'Download').disabled).toBe(false);
  });
});

describe('backgroundMenu', () => {
  it('disables Paste with an empty clipboard and everything mutating for a viewer', () => {
    expect(find(backgroundMenu('/d', ctx({ hasClipboard: false })), 'Paste').disabled).toBe(true);
    const viewer = backgroundMenu('/d', ctx({ canControl: false }));
    for (const label of ['New folder', 'New file', 'Upload files…', 'Upload folder…', 'Paste']) {
      expect(find(viewer, label).disabled).toBe(true);
    }
    expect(find(viewer, 'Refresh').disabled).toBe(false);
  });

  it('labels the hidden-files toggle by current state', () => {
    expect(labels(backgroundMenu('/d', ctx({ showHidden: true })))).toContain('Hide hidden files');
  });
});

describe('itemMenu in split view', () => {
  it('offers copy/move to the other pane after Paste', () => {
    const m = itemMenu([entry('a.txt'), entry('b.txt')], ctx({ toOther: noop }));
    expect(labels(m)).toEqual([
      'Download 2 files', 'Cut', 'Copy', 'Copy to other pane', 'Move to other pane', 'Move 2 items to trash',
    ]);
    expect(find(m, 'Copy to other pane')).toMatchObject({ shortcut: 'F5', disabled: false });
    expect(find(m, 'Move to other pane')).toMatchObject({ shortcut: 'F6', disabled: false });
  });

  it('disables them for a viewer', () => {
    const m = itemMenu([entry('a.txt')], ctx({ toOther: noop, canControl: false }));
    expect(find(m, 'Copy to other pane')).toMatchObject({ disabled: true, title: 'Operator role required' });
    expect(find(m, 'Move to other pane')).toMatchObject({ disabled: true, title: 'Operator role required' });
  });

  it('are absent outside split view', () => {
    expect(labels(itemMenu([entry('a.txt')], ctx()))).not.toContain('Copy to other pane');
  });
});
