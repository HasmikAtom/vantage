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
