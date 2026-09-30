import { describe, expect, it } from 'vitest';
import { canDropInto, dropMode } from './dnd';

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
