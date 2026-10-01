// Texts for the explorer's hint line, empty states, drop labels and the
// keyboard shortcut sheet. Viewers never see hints for things they can't do.

export function hintFor(h: { selectedCount: number; split: boolean; canControl: boolean; pane?: 'left' | 'right' }): string {
  const parts: string[] = [];
  if (!h.canControl) {
    parts.push('Double-click to open', 'Right-click for actions', 'Ctrl+C copy');
  } else if (h.selectedCount === 0) {
    parts.push('Double-click to open', 'Right-click for actions', 'Drag files here to upload');
  } else {
    parts.push('Del trash', 'F2 rename', 'Ctrl+C/X/V', 'drag onto a folder to move');
  }
  if (h.split) {
    parts.push('Tab switch pane');
    const arrow = h.pane === 'right' ? '←' : '→';
    if (h.canControl) parts.push(`F5 copy ${arrow}`, `F6 move ${arrow}`);
  }
  parts.push('? shortcuts');
  return parts.join(' · ');
}

export function emptyText(h: { query: string; canControl: boolean }): string {
  const q = h.query.trim();
  if (q !== '') return `No names match '${q}' — Esc to clear`;
  return h.canControl ? 'This folder is empty — drop files here or use Upload' : 'This folder is empty';
}

export function dropLabel(h: { mode: 'copy' | 'move' | 'upload'; count: number; target: string }): string {
  const verb = h.mode === 'copy' ? 'Copy' : h.mode === 'move' ? 'Move' : 'Upload';
  return `${verb} ${h.count} ${h.count === 1 ? 'item' : 'items'} to ${h.target}`;
}

export interface ShortcutRow {
  keys: string;
  action: string;
  operator?: boolean;
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    rows: [
      { keys: 'Enter / double-click', action: 'Open folder or file' },
      { keys: 'Backspace', action: 'Parent folder' },
      { keys: 'Alt+← / Alt+→', action: 'Back / forward' },
      { keys: 'Ctrl+L', action: 'Type a path' },
      { keys: 'F5', action: 'Refresh (single pane)' },
      { keys: 'Ctrl+Shift+R', action: 'Refresh (split view)' },
    ],
  },
  {
    title: 'Selection',
    rows: [
      { keys: 'Click / Ctrl+click / Shift+click', action: 'Select one / toggle / range' },
      { keys: '↑ ↓ Home End', action: 'Move focus (Shift extends)' },
      { keys: 'Ctrl+A', action: 'Select all' },
      { keys: 'Esc', action: 'Clear selection' },
      { keys: 'Type letters', action: 'Jump to a name' },
    ],
  },
  {
    title: 'File actions',
    rows: [
      { keys: 'Ctrl+C', action: 'Copy' },
      { keys: 'Ctrl+X', action: 'Cut', operator: true },
      { keys: 'Ctrl+V', action: 'Paste', operator: true },
      { keys: 'Del', action: 'Move to trash', operator: true },
      { keys: 'F2', action: 'Rename', operator: true },
      { keys: 'Ctrl+Shift+N', action: 'New folder', operator: true },
      { keys: 'Shift+F10 / Menu', action: 'Context menu' },
      { keys: '?', action: 'This sheet' },
    ],
  },
  {
    title: 'Split view',
    rows: [
      { keys: 'Ctrl+\\', action: 'Split view on / off' },
      { keys: 'Tab', action: 'Switch pane' },
      { keys: 'F5', action: 'Copy selection to the other pane', operator: true },
      { keys: 'F6', action: 'Move selection to the other pane', operator: true },
      { keys: 'Drag across', action: 'Move (same server) / copy (other server)', operator: true },
    ],
  },
];
