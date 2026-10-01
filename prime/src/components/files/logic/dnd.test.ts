import { describe, expect, it } from 'vitest';
import { canDropAcross, canDropInto, crossDropMode, dropMode } from './dnd';

describe('dropMode', () => {
  it('moves by default and copies with Ctrl or Cmd', () => {
    expect(dropMode({ ctrlKey: false, metaKey: false })).toBe('move');
    expect(dropMode({ ctrlKey: true, metaKey: false })).toBe('copy');
    expect(dropMode({ ctrlKey: false, metaKey: true })).toBe('copy');
  });
});

describe('canDropInto', () => {
  it('accepts a sibling folder', () => {
    expect(canDropInto(['/a/x.txt', '/a/y'], '/a/z')).toBe(true);
  });
  it('refuses a folder into itself or its descendant', () => {
    expect(canDropInto(['/a/y'], '/a/y')).toBe(false);
    expect(canDropInto(['/a/y'], '/a/y/deep')).toBe(false);
  });
  it('refuses dropping into the folder the items already live in', () => {
    expect(canDropInto(['/a/x.txt'], '/a')).toBe(false);
  });
  it('refuses when any source is invalid and when nothing is dragged', () => {
    expect(canDropInto(['/b/ok', '/a/y'], '/a/y/deep')).toBe(false);
    expect(canDropInto([], '/a')).toBe(false);
  });
  it('does not confuse name prefixes with descendants', () => {
    expect(canDropInto(['/a/y'], '/a/yz')).toBe(true);
  });
});

describe('crossDropMode', () => {
  const ev = (o: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
    ctrlKey: false, metaKey: false, shiftKey: false, ...o,
  });
  it('same server: move by default, Ctrl/Cmd copies', () => {
    expect(crossDropMode(ev(), true)).toBe('move');
    expect(crossDropMode(ev({ ctrlKey: true }), true)).toBe('copy');
  });
  it('different servers: copy by default, Shift moves', () => {
    expect(crossDropMode(ev(), false)).toBe('copy');
    expect(crossDropMode(ev({ ctrlKey: true }), false)).toBe('copy');
    expect(crossDropMode(ev({ shiftKey: true }), false)).toBe('move');
  });
});

describe('canDropAcross', () => {
  it('applies the same-server rules on one server', () => {
    expect(canDropAcross('a', ['/x/f'], 'a', '/x')).toBe(false);
    expect(canDropAcross('a', ['/x/d'], 'a', '/x/d/sub')).toBe(false);
    expect(canDropAcross('a', ['/x/f'], 'a', '/y')).toBe(true);
  });
  it('allows any folder on another server, even with the same path', () => {
    expect(canDropAcross('a', ['/x/f'], 'b', '/x')).toBe(true);
    expect(canDropAcross('a', ['/x/d'], 'b', '/x/d')).toBe(true);
  });
  it('refuses an empty drag', () => {
    expect(canDropAcross('a', [], 'b', '/x')).toBe(false);
  });
});
