import { describe, expect, it } from 'vitest';
import { canBack, canForward, hashFor, navInit, navPop, navPush, pathFromHash } from './history';

describe('hash encoding', () => {
  it.each([
    '/',
    '/etc',
    '/tmp/a #1/50%',
    '/home/me/My Documents',
    '/srv/données/日本',
    '/a/b?c=d&e',
  ])('round-trips %s', (p) => {
    expect(pathFromHash(hashFor(p))).toBe(p);
  });

  it('keeps slashes readable', () => {
    expect(hashFor('/var/log')).toBe('#files:/var/log');
    expect(hashFor('/a b')).toBe('#files:/a%20b');
  });

  it('returns null for foreign or malformed hashes', () => {
    expect(pathFromHash('#overview')).toBe(null);
    expect(pathFromHash('#files')).toBe(null);
    expect(pathFromHash('#files:relative')).toBe(null);
    expect(pathFromHash('#files:/bad%E0')).toBe(null);
  });
});

describe('nav model', () => {
  it('starts at the recorded index or 0', () => {
    expect(navInit(undefined)).toEqual({ idx: 0, max: 0 });
    expect(navInit(3)).toEqual({ idx: 3, max: 3 });
    expect(navInit(-1)).toEqual({ idx: 0, max: 0 });
  });

  it('push, back, forward, and push truncates forward history', () => {
    let m = navInit(undefined);
    expect(canBack(m)).toBe(false);
    m = navPush(m); // 1
    m = navPush(m); // 2
    expect(m).toEqual({ idx: 2, max: 2 });
    m = navPop(m, 1);
    expect(canBack(m) && canForward(m)).toBe(true);
    m = navPush(m);
    expect(m).toEqual({ idx: 2, max: 2 });
    expect(canForward(m)).toBe(false);
  });

  it('ignores popstate entries that did not come from the explorer', () => {
    const m = { idx: 2, max: 2 };
    expect(navPop(m, undefined)).toBe(m);
  });
});
