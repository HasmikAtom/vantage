import { describe, expect, it } from 'vitest';
import { childToward, createScrollMemory, edgeScrollDelta } from './scrollMemory';

describe('childToward', () => {
  it('names the folder you came out of when going up', () => {
    expect(childToward('/a/b/c', '/a/b')).toBe('/a/b/c');
    expect(childToward('/a/b/c', '/a')).toBe('/a/b');
    expect(childToward('/a/b', '/')).toBe('/a');
  });
  it('is null when the new folder is not above the old one', () => {
    expect(childToward('/a/b', '/a/b')).toBeNull();
    expect(childToward('/a', '/a/b')).toBeNull();
    expect(childToward('/a/b', '/x')).toBeNull();
    expect(childToward('/ab/c', '/a')).toBeNull();
  });
});

describe('createScrollMemory', () => {
  it('remembers a position per folder', () => {
    const m = createScrollMemory();
    m.set('/a', 120);
    m.set('/b', 40);
    expect(m.get('/a')).toBe(120);
    expect(m.get('/b')).toBe(40);
    expect(m.get('/c')).toBe(0);
  });
  it('forgets the least recently used folder past its limit', () => {
    const m = createScrollMemory(2);
    m.set('/a', 1);
    m.set('/b', 2);
    m.get('/a'); // /a is now the most recent
    m.set('/c', 3);
    expect(m.get('/b')).toBe(0);
    expect(m.get('/a')).toBe(1);
    expect(m.get('/c')).toBe(3);
  });
});

describe('edgeScrollDelta', () => {
  // List from y=100 to y=500; 48 px edge zones; up to 24 px per event.
  it('does not scroll away from the edges', () => {
    expect(edgeScrollDelta(300, 100, 500)).toBe(0);
    expect(edgeScrollDelta(148, 100, 500)).toBe(0);
  });
  it('scrolls up near the top and down near the bottom, faster closer in', () => {
    expect(edgeScrollDelta(100, 100, 500)).toBe(-24);
    expect(edgeScrollDelta(124, 100, 500)).toBe(-12);
    expect(edgeScrollDelta(500, 100, 500)).toBe(24);
    expect(edgeScrollDelta(476, 100, 500)).toBe(12);
  });
  it('does not scroll when the pointer is outside the list', () => {
    expect(edgeScrollDelta(90, 100, 500)).toBe(0);
    expect(edgeScrollDelta(510, 100, 500)).toBe(0);
  });
});
