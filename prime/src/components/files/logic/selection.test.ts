import { describe, expect, it } from 'vitest';
import { emptySelection, findTypeAhead, selectionReducer as r, type SelectionState } from './selection';

const order = ['/a', '/b', '/c', '/d', '/e'];
const sel = (s: SelectionState) => [...s.selected].sort();

describe('selectionReducer', () => {
  it('plain click selects one and sets anchor + focus', () => {
    const s = r(emptySelection, { type: 'click', path: '/b', ctrl: false, shift: false, order });
    expect(sel(s)).toEqual(['/b']);
    expect(s.anchor).toBe('/b');
    expect(s.focus).toBe('/b');
  });

  it('ctrl+click toggles', () => {
    let s = r(emptySelection, { type: 'click', path: '/b', ctrl: false, shift: false, order });
    s = r(s, { type: 'click', path: '/d', ctrl: true, shift: false, order });
    expect(sel(s)).toEqual(['/b', '/d']);
    s = r(s, { type: 'click', path: '/b', ctrl: true, shift: false, order });
    expect(sel(s)).toEqual(['/d']);
  });

  it('shift+click selects the range from the anchor, in either direction', () => {
    let s = r(emptySelection, { type: 'click', path: '/b', ctrl: false, shift: false, order });
    s = r(s, { type: 'click', path: '/d', ctrl: false, shift: true, order });
    expect(sel(s)).toEqual(['/b', '/c', '/d']);
    s = r(s, { type: 'click', path: '/a', ctrl: false, shift: true, order });
    expect(sel(s)).toEqual(['/a', '/b']);
    expect(s.anchor).toBe('/b');
  });

  it('ctrl+shift+click adds the range to the existing selection', () => {
    let s = r(emptySelection, { type: 'click', path: '/a', ctrl: false, shift: false, order });
    s = r(s, { type: 'click', path: '/d', ctrl: true, shift: false, order });
    s = r(s, { type: 'click', path: '/e', ctrl: true, shift: true, order });
    expect(sel(s)).toEqual(['/a', '/d', '/e']);
  });

  it('toggle, selectAll, and clear', () => {
    let s = r(emptySelection, { type: 'toggle', path: '/c' });
    expect(sel(s)).toEqual(['/c']);
    s = r(s, { type: 'selectAll', order });
    expect(sel(s)).toEqual(order);
    s = r(s, { type: 'clear' });
    expect(sel(s)).toEqual([]);
  });

  it('arrow moves focus and selection; shift extends from the anchor', () => {
    let s = r(emptySelection, { type: 'move', to: 'next', extend: false, order });
    expect(s.focus).toBe('/a');
    s = r(s, { type: 'move', to: 'next', extend: false, order });
    expect(sel(s)).toEqual(['/b']);
    s = r(s, { type: 'move', to: 'next', extend: true, order });
    s = r(s, { type: 'move', to: 'next', extend: true, order });
    expect(sel(s)).toEqual(['/b', '/c', '/d']);
    s = r(s, { type: 'move', to: 'last', extend: false, order });
    expect(sel(s)).toEqual(['/e']);
    s = r(s, { type: 'move', to: 'next', extend: false, order });
    expect(s.focus).toBe('/e');
    s = r(s, { type: 'move', to: 'first', extend: false, order });
    expect(s.focus).toBe('/a');
    s = r(s, { type: 'move', to: 'prev', extend: false, order });
    expect(s.focus).toBe('/a');
  });

  it('move on an empty list is a no-op', () => {
    expect(r(emptySelection, { type: 'move', to: 'next', extend: false, order: [] })).toBe(emptySelection);
  });

  it('retain drops vanished paths and clears a vanished anchor/focus', () => {
    let s = r(emptySelection, { type: 'click', path: '/b', ctrl: false, shift: false, order });
    s = r(s, { type: 'click', path: '/c', ctrl: true, shift: false, order });
    s = r(s, { type: 'retain', existing: new Set(['/b', '/d']) });
    expect(sel(s)).toEqual(['/b']);
    expect(s.anchor).toBe(null);
    expect(s.focus).toBe(null);
  });

  it('retain returns the same object when nothing vanished', () => {
    const s = r(emptySelection, { type: 'click', path: '/b', ctrl: false, shift: false, order });
    expect(r(s, { type: 'retain', existing: new Set(order) })).toBe(s);
  });
});

describe('findTypeAhead', () => {
  const rows = [
    { path: '/etc', name: 'etc' },
    { path: '/home', name: 'home' },
    { path: '/Hosts', name: 'Hosts' },
  ];
  it('finds the next case-insensitive prefix match after the focus, wrapping', () => {
    expect(findTypeAhead(rows, 'h', null)).toBe('/home');
    expect(findTypeAhead(rows, 'h', '/home')).toBe('/Hosts');
    expect(findTypeAhead(rows, 'h', '/Hosts')).toBe('/home');
    expect(findTypeAhead(rows, 'ho', '/etc')).toBe('/home');
    expect(findTypeAhead(rows, 'zz', null)).toBe(null);
  });
});
