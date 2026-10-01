import { describe, expect, it } from 'vitest';
import { SHORTCUT_GROUPS, dropLabel, emptyText, hintFor } from './hints';

describe('hintFor', () => {
  it('nothing selected (operator)', () => {
    expect(hintFor({ selectedCount: 0, split: false, canControl: true })).toBe(
      'Double-click to open · Right-click for actions · Drag files here to upload · ? shortcuts',
    );
  });
  it('with a selection (operator)', () => {
    expect(hintFor({ selectedCount: 2, split: false, canControl: true })).toBe(
      'Del trash · F2 rename · Ctrl+C/X/V · drag onto a folder to move · ? shortcuts',
    );
  });
  it('split adds the pane keys', () => {
    expect(hintFor({ selectedCount: 1, split: true, canControl: true })).toBe(
      'Del trash · F2 rename · Ctrl+C/X/V · drag onto a folder to move · Tab switch pane · F5 copy → · F6 move → · ? shortcuts',
    );
  });
  it('viewer only sees read-only hints', () => {
    expect(hintFor({ selectedCount: 3, split: true, canControl: false })).toBe(
      'Double-click to open · Right-click for actions · Ctrl+C copy · Tab switch pane · ? shortcuts',
    );
  });
});

describe('emptyText', () => {
  it('explains an empty folder, by role', () => {
    expect(emptyText({ query: '', canControl: true })).toBe('This folder is empty — drop files here or use Upload');
    expect(emptyText({ query: '', canControl: false })).toBe('This folder is empty');
  });
  it('explains a filter with no matches', () => {
    expect(emptyText({ query: ' xyz ', canControl: true })).toBe("No names match 'xyz' — Esc to clear");
  });
});

describe('dropLabel', () => {
  it('describes what a drop will do', () => {
    expect(dropLabel({ mode: 'move', count: 3, target: '/backup' })).toBe('Move 3 items to /backup');
    expect(dropLabel({ mode: 'copy', count: 1, target: 'nas:/backup' })).toBe('Copy 1 item to nas:/backup');
    expect(dropLabel({ mode: 'upload', count: 2, target: '/tmp' })).toBe('Upload 2 items to /tmp');
  });
});

describe('SHORTCUT_GROUPS', () => {
  it('has the four groups and marks mutating keys as operator-only', () => {
    expect(SHORTCUT_GROUPS.map((g) => g.title)).toEqual(['Navigation', 'Selection', 'File actions', 'Split view']);
    const del = SHORTCUT_GROUPS.flatMap((g) => g.rows).find((r) => r.keys === 'Del');
    expect(del?.operator).toBe(true);
  });
});

describe('hintFor — arrow direction', () => {
  it('points at the other pane', () => {
    expect(hintFor({ selectedCount: 1, split: true, canControl: true, pane: 'right' })).toContain('F5 copy ← · F6 move ←');
    expect(hintFor({ selectedCount: 1, split: true, canControl: true, pane: 'left' })).toContain('F5 copy → · F6 move →');
  });
});
