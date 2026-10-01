import { describe, expect, it } from 'vitest';
import { MAX_HISTORY, createHistory, historyReducer as r } from './paneHistory';

describe('historyReducer', () => {
  it('go pushes the current path and clears forward', () => {
    let h = createHistory('/a');
    h = r(h, { type: 'go', path: '/b' });
    h = r(h, { type: 'go', path: '/c' });
    expect(h).toEqual({ back: ['/a', '/b'], path: '/c', forward: [] });
  });

  it('back and forward walk the stacks', () => {
    let h = r(r(createHistory('/a'), { type: 'go', path: '/b' }), { type: 'go', path: '/c' });
    h = r(h, { type: 'back' });
    expect(h).toEqual({ back: ['/a'], path: '/b', forward: ['/c'] });
    h = r(h, { type: 'forward' });
    expect(h).toEqual({ back: ['/a', '/b'], path: '/c', forward: [] });
  });

  it('back/forward at the ends and go to the same path are no-ops', () => {
    const h = createHistory('/a');
    expect(r(h, { type: 'back' })).toBe(h);
    expect(r(h, { type: 'forward' })).toBe(h);
    expect(r(h, { type: 'go', path: '/a' })).toBe(h);
  });

  it('going somewhere new after back drops the forward stack', () => {
    let h = r(r(createHistory('/a'), { type: 'go', path: '/b' }), { type: 'back' });
    h = r(h, { type: 'go', path: '/z' });
    expect(h).toEqual({ back: ['/a'], path: '/z', forward: [] });
  });

  it('reset starts over', () => {
    const h = r(r(createHistory('/a'), { type: 'go', path: '/b' }), { type: 'reset', path: '/q' });
    expect(h).toEqual({ back: [], path: '/q', forward: [] });
  });

  it('caps the back stack', () => {
    let h = createHistory('/0');
    for (let i = 1; i <= MAX_HISTORY + 10; i++) h = r(h, { type: 'go', path: `/${i}` });
    expect(h.back.length).toBe(MAX_HISTORY);
    expect(h.back[0]).toBe('/10');
  });
});
