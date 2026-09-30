// Keyboard map for the explorer. Mutating shortcuts return null without
// the operator role so a viewer's Delete/F2/Ctrl+X/V do nothing, matching
// the disabled menu items.

export type Shortcut =
  | 'open' | 'up' | 'trash' | 'rename' | 'selectAll' | 'escape' | 'copy' | 'cut'
  | 'paste' | 'newFolder' | 'editAddress' | 'refresh' | 'menu'
  | 'prev' | 'next' | 'first' | 'last';

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MUTATING: ReadonlySet<Shortcut> = new Set(['trash', 'rename', 'cut', 'paste', 'newFolder']);

export function shortcutFor(e: KeyInput, canControl: boolean): Shortcut | null {
  if (e.altKey) return null;
  let s: Shortcut | null = null;
  if (e.ctrlKey || e.metaKey) {
    const key = e.key.toLowerCase();
    if (e.shiftKey) {
      if (key === 'n') s = 'newFolder';
    } else if (key === 'a') s = 'selectAll';
    else if (key === 'c') s = 'copy';
    else if (key === 'x') s = 'cut';
    else if (key === 'v') s = 'paste';
    else if (key === 'l') s = 'editAddress';
  } else {
    switch (e.key) {
      case 'Enter': s = 'open'; break;
      case 'Backspace': s = 'up'; break;
      case 'Delete': s = 'trash'; break;
      case 'F2': s = 'rename'; break;
      case 'Escape': s = 'escape'; break;
      case 'F5': s = 'refresh'; break;
      case 'ContextMenu': s = 'menu'; break;
      case 'F10': s = e.shiftKey ? 'menu' : null; break;
      case 'ArrowUp': s = 'prev'; break;
      case 'ArrowDown': s = 'next'; break;
      case 'Home': s = 'first'; break;
      case 'End': s = 'last'; break;
    }
  }
  if (s && MUTATING.has(s) && !canControl) return null;
  return s;
}

export function typeAheadChar(e: KeyInput): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  return e.key.length === 1 && e.key !== ' ' ? e.key.toLowerCase() : null;
}
