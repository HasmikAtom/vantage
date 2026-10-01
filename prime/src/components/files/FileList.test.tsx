// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { FsEntry } from '@/types';
import { FileList, type FileListProps } from './FileList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = {
  name: 'notes.txt', path: '/a/notes.txt', type: 'file', size: 10, mtime: '2026-10-01T10:00:00Z',
  mode: 0o644, modeStr: '-rw-r--r--', owner: 'root', group: 'root',
} as unknown as FsEntry;

function render(extra: Partial<FileListProps>) {
  const noop = () => {};
  const props = {
    entries: [entry], showParent: true, selection: { selected: new Set<string>(), anchor: null, focus: null },
    sizes: new Map(), sort: { key: 'name', dir: 'asc' }, cutPaths: new Set<string>(), loading: false, error: null,
    onSort: noop, onRowClick: noop, onRowCheck: noop, onToggleAll: noop, onOpen: noop, onUp: noop,
    onContextMenu: noop, onBackgroundClick: noop, ...extra,
  } as unknown as FileListProps;
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<FileList {...props} />));
  const headers = [...host.querySelectorAll('th')].map((th) => th.textContent?.replace(/[▲▼]/g, '').trim()).filter(Boolean);
  const cells = host.querySelectorAll('tr[data-path] td').length;
  const parentSpan = host.querySelector('tr[data-parent-row] td:last-child')?.getAttribute('colspan');
  act(() => root.unmount());
  return { headers, cells, parentSpan };
}

describe('FileList columns', () => {
  it('shows every column in a full-width pane', () => {
    const r = render({});
    expect(r.headers).toEqual(['Name', 'Size', 'Modified', 'Owner', 'Mode']);
    expect(r.cells).toBe(7);
  });
  it('drops Owner and Mode in a narrow (split) pane, keeping the rows aligned', () => {
    const r = render({ compact: true });
    expect(r.headers).toEqual(['Name', 'Size', 'Modified']);
    expect(r.cells).toBe(5);
    expect(r.parentSpan).toBe('2');
  });
});
