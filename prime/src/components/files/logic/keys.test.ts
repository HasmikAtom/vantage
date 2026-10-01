import { describe, expect, it } from 'vitest';
import { shortcutFor, typeAheadChar, type KeyInput } from './keys';

const k = (key: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods,
});

describe('shortcutFor (operator)', () => {
  it.each([
    [k('Enter'), 'open'],
    [k('Backspace'), 'up'],
    [k('Delete'), 'trash'],
    [k('F2'), 'rename'],
    [k('a', { ctrlKey: true }), 'selectAll'],
    [k('A', { metaKey: true }), 'selectAll'],
    [k('Escape'), 'escape'],
    [k('c', { ctrlKey: true }), 'copy'],
    [k('x', { ctrlKey: true }), 'cut'],
    [k('v', { ctrlKey: true }), 'paste'],
    [k('N', { ctrlKey: true, shiftKey: true }), 'newFolder'],
    [k('l', { ctrlKey: true }), 'editAddress'],
    [k('F5'), 'refresh'],
    [k('F10', { shiftKey: true }), 'menu'],
    [k('ContextMenu'), 'menu'],
    [k('ArrowUp'), 'prev'],
    [k('ArrowDown', { shiftKey: true }), 'next'],
    [k('Home'), 'first'],
    [k('End'), 'last'],
  ] as const)('%o → %s', (input, want) => {
    expect(shortcutFor(input, true)).toBe(want);
  });

  it('ignores unrelated keys and Alt combos', () => {
    expect(shortcutFor(k('F10'), true)).toBe(null);
    expect(shortcutFor(k('n', { ctrlKey: true }), true)).toBe(null);
    expect(shortcutFor(k('ArrowLeft', { altKey: true }), true)).toBe(null);
  });
});

describe('shortcutFor (viewer)', () => {
  it('blocks every mutating shortcut', () => {
    for (const input of [
      k('Delete'),
      k('F2'),
      k('x', { ctrlKey: true }),
      k('v', { ctrlKey: true }),
      k('N', { ctrlKey: true, shiftKey: true }),
    ]) {
      expect(shortcutFor(input, false)).toBe(null);
    }
  });

  it('keeps read-only shortcuts', () => {
    expect(shortcutFor(k('Enter'), false)).toBe('open');
    expect(shortcutFor(k('c', { ctrlKey: true }), false)).toBe('copy');
    expect(shortcutFor(k('a', { ctrlKey: true }), false)).toBe('selectAll');
  });
});

describe('typeAheadChar', () => {
  it('returns printable single characters only', () => {
    expect(typeAheadChar(k('H'))).toBe('h');
    expect(typeAheadChar(k(' '))).toBe(null);
    expect(typeAheadChar(k('Enter'))).toBe(null);
    expect(typeAheadChar(k('a', { ctrlKey: true }))).toBe(null);
  });
});

describe('shortcutFor (split mode)', () => {
  it.each([
    [k('F5'), 'copyOther'],
    [k('F6'), 'moveOther'],
    [k('R', { ctrlKey: true, shiftKey: true }), 'refresh'],
    [k('Tab'), 'switchPane'],
    [k('Tab', { shiftKey: true }), 'switchPane'],
    [k('ArrowLeft', { altKey: true }), 'paneBack'],
    [k('ArrowRight', { altKey: true }), 'paneForward'],
    [k('\\', { ctrlKey: true }), 'toggleSplit'],
    [k('?', { shiftKey: true }), 'help'],
  ] as const)('%o → %s', (input, want) => {
    expect(shortcutFor(input, true, true)).toBe(want);
  });

  it('viewer: F5 refreshes (never reloads the page) and F6 does nothing', () => {
    expect(shortcutFor(k('F5'), false, true)).toBe('refresh');
    expect(shortcutFor(k('F6'), false, true)).toBe('noop');
  });
});

describe('shortcutFor (single pane keeps v1.2.0 behaviour)', () => {
  it('F5 refreshes, F6 is swallowed, Tab/Alt+arrows are left to the browser, Ctrl+\\ and ? still work', () => {
    expect(shortcutFor(k('F5'), true)).toBe('refresh');
    expect(shortcutFor(k('F6'), true)).toBe('noop');
    expect(shortcutFor(k('Tab'), true)).toBe(null);
    expect(shortcutFor(k('ArrowLeft', { altKey: true }), true)).toBe(null);
    expect(shortcutFor(k('R', { ctrlKey: true, shiftKey: true }), true)).toBe(null);
    expect(shortcutFor(k('\\', { ctrlKey: true }), true)).toBe('toggleSplit');
    expect(shortcutFor(k('?', { shiftKey: true }), true)).toBe('help');
  });
});

describe('shortcutFor — focus and F6', () => {
  it('Tab switches panes only when the pane itself has focus', () => {
    expect(shortcutFor(k('Tab'), true, true, true)).toBe('switchPane');
    expect(shortcutFor(k('Tab'), true, true, false)).toBe(null);
  });

  it('F6 is always swallowed so the browser never jumps to its address bar', () => {
    expect(shortcutFor(k('F6'), true, false)).toBe('noop');
    expect(shortcutFor(k('F6'), false, true)).toBe('noop');
    expect(shortcutFor(k('F6'), true, true)).toBe('moveOther');
  });
});
