import { describe, expect, it } from 'vitest';
import { addPin, defaultPins, movePin, pinLabel, removePin, renamePin } from './pins';

const P = (...paths: string[]) => paths.map((path) => ({ path, label: null }));

describe('pin list edits', () => {
  it('has the documented defaults', () => {
    expect(defaultPins().map((p) => p.path)).toEqual(['/', '/home', '/etc', '/var/log', '/opt']);
  });
  it('adds at the end without duplicates and caps at 50', () => {
    expect(addPin(P('/a'), '/b')).toEqual(P('/a', '/b'));
    expect(addPin(P('/a'), '/a')).toEqual(P('/a'));
    const full = P(...Array.from({ length: 50 }, (_, i) => `/p${i}`));
    expect(addPin(full, '/new')).toBe(full);
  });
  it('removes, moves within bounds, and renames', () => {
    expect(removePin(P('/a', '/b'), '/a')).toEqual(P('/b'));
    expect(movePin(P('/a', '/b', '/c'), '/c', -1)).toEqual(P('/a', '/c', '/b'));
    expect(movePin(P('/a', '/b'), '/a', -1)).toEqual(P('/a', '/b'));
    expect(renamePin(P('/a'), '/a', '  Alpha ')).toEqual([{ path: '/a', label: 'Alpha' }]);
    expect(renamePin([{ path: '/a', label: 'x' }], '/a', '  ')).toEqual(P('/a'));
  });
  it('labels fall back to the folder name', () => {
    expect(pinLabel({ path: '/var/log', label: null })).toBe('log');
    expect(pinLabel({ path: '/', label: null })).toBe('/');
    expect(pinLabel({ path: '/x', label: 'Mine' })).toBe('Mine');
  });
});
