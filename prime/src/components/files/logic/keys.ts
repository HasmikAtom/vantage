// Keyboard map for the explorer. Mutating shortcuts return null without
// the operator role so a viewer's Delete/F2/Ctrl+X/V do nothing, matching
// the disabled menu items.

export type Shortcut =
  | 'open' | 'up' | 'trash' | 'rename' | 'selectAll' | 'escape' | 'copy' | 'cut'
  | 'paste' | 'newFolder' | 'editAddress' | 'refresh' | 'menu'
  | 'prev' | 'next' | 'first' | 'last'
  | 'copyOther' | 'moveOther' | 'switchPane' | 'toggleSplit' | 'help'
  | 'paneBack' | 'paneForward'
  // Swallowed key: the explorer does nothing, but the browser must not either.
  | 'noop';

export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MUTATING: ReadonlySet<Shortcut> = new Set([
  'trash', 'rename', 'cut', 'paste', 'newFolder', 'copyOther', 'moveOther',
]);

// split: in split view F5/F6 copy/move to the other pane (Total Commander
// style), Ctrl+Shift+R refreshes, Tab switches pane and Alt+←/→ walk the
// active pane's own history.
// focusOnPane: keyboard focus is on the pane itself rather than one of its
// buttons; Tab only switches panes then, so buttons stay Tab-reachable.
export function shortcutFor(e: KeyInput, canControl: boolean, split = false, focusOnPane = true): Shortcut | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.altKey) {
    if (!split || mod || e.shiftKey) return null;
    if (e.key === 'ArrowLeft') return 'paneBack';
    if (e.key === 'ArrowRight') return 'paneForward';
    return null;
  }
  let s: Shortcut | null = null;
  if (mod) {
    const key = e.key.toLowerCase();
    if (e.shiftKey) {
      if (key === 'n') s = 'newFolder';
      else if (key === 'r' && split) s = 'refresh';
    } else if (key === 'a') s = 'selectAll';
    else if (key === 'c') s = 'copy';
    else if (key === 'x') s = 'cut';
    else if (key === 'v') s = 'paste';
    else if (key === 'l') s = 'editAddress';
    else if (key === '\\') s = 'toggleSplit';
  } else {
    switch (e.key) {
      case 'Enter': s = 'open'; break;
      case 'Backspace': s = 'up'; break;
      case 'Delete': s = 'trash'; break;
      case 'F2': s = 'rename'; break;
      case 'Escape': s = 'escape'; break;
      case 'F5':
        // A viewer's F5 in split mode still refreshes the pane rather than
        // falling through to a full browser reload.
        s = split ? (canControl ? 'copyOther' : 'refresh') : 'refresh';
        break;
      case 'F6': s = split ? 'moveOther' : null; break;
      case 'Tab': s = split && focusOnPane ? 'switchPane' : null; break;
      case '?': s = 'help'; break;
      case 'ContextMenu': s = 'menu'; break;
      case 'F10': s = e.shiftKey ? 'menu' : null; break;
      case 'ArrowUp': s = 'prev'; break;
      case 'ArrowDown': s = 'next'; break;
      case 'Home': s = 'first'; break;
      case 'End': s = 'last'; break;
    }
  }
  if (s && MUTATING.has(s) && !canControl) s = null;
  // F6 always lands somewhere in the browser (address bar); keep it here.
  if (s === null && e.key === 'F6' && !mod) return 'noop';
  return s;
}

export function typeAheadChar(e: KeyInput): string | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  return e.key.length === 1 && e.key !== ' ' ? e.key.toLowerCase() : null;
}
