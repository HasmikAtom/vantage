import { describe, expect, it } from 'vitest';
import { applySizeEvent, formatDirSize, initialSizes, onStreamError, settleSizes } from './sizes';

describe('size state', () => {
  it('starts pending when supported and none when not', () => {
    expect([...initialSizes(['/a'], true).values()]).toEqual([{ state: 'pending' }]);
    expect([...initialSizes(['/a'], false).values()]).toEqual([{ state: 'none' }]);
  });

  it('applies events and settles the rest to none on done', () => {
    let m = initialSizes(['/a', '/b'], true);
    m = applySizeEvent(m, { path: '/a', bytes: 2048, files: 3, partial: false });
    m = settleSizes(m);
    expect(m.get('/a')).toEqual({ state: 'done', bytes: 2048, partial: false });
    expect(m.get('/b')).toEqual({ state: 'none' });
  });

  it('ignores events for folders not in the listing', () => {
    const m = applySizeEvent(initialSizes(['/a'], true), { path: '/zzz', bytes: 1, files: 1, partial: false });
    expect(m.has('/zzz')).toBe(false);
  });

  it('an error before any event marks the server unsupported and clears spinners', () => {
    const r = onStreamError(initialSizes(['/a', '/b'], true), false);
    expect(r.unsupported).toBe(true);
    expect([...r.sizes.values()]).toEqual([{ state: 'none' }, { state: 'none' }]);
  });

  it('an error after some events keeps results and does not mark unsupported', () => {
    const m = applySizeEvent(initialSizes(['/a', '/b'], true), { path: '/a', bytes: 1, files: 1, partial: false });
    const r = onStreamError(m, true);
    expect(r.unsupported).toBe(false);
    expect(r.sizes.get('/a')).toEqual({ state: 'done', bytes: 1, partial: false });
    expect(r.sizes.get('/b')).toEqual({ state: 'none' });
  });

  it('formats', () => {
    expect(formatDirSize({ state: 'done', bytes: 1536, partial: false })).toBe('1.5 KB');
    expect(formatDirSize({ state: 'done', bytes: 1536, partial: true })).toBe('≥ 1.5 KB');
    expect(formatDirSize({ state: 'none' })).toBe('—');
    expect(formatDirSize(undefined)).toBe('—');
    expect(formatDirSize({ state: 'pending' })).toBe('');
  });
});

describe('folder sizes still being counted', () => {
  it('keeps a running total as it grows, then the final size', () => {
    let m = initialSizes(['/big'], true);
    m = applySizeEvent(m, { path: '/big', bytes: 1000, files: 10, partial: true, running: true });
    expect(m.get('/big')).toEqual({ state: 'done', bytes: 1000, partial: true, running: true });
    m = applySizeEvent(m, { path: '/big', bytes: 5000, files: 50, partial: false });
    expect(m.get('/big')).toEqual({ state: 'done', bytes: 5000, partial: false });
  });
  it('shows a running total as "at least, still counting"', () => {
    expect(formatDirSize({ state: 'done', bytes: 1536, partial: true, running: true })).toBe('≥ 1.5 KB…');
    expect(formatDirSize({ state: 'done', bytes: 1536, partial: true })).toBe('≥ 1.5 KB');
  });
  it('keeps the last running total as a lower bound if the stream ends mid-count', () => {
    let m = initialSizes(['/big'], true);
    m = applySizeEvent(m, { path: '/big', bytes: 1000, files: 10, partial: true, running: true });
    expect(settleSizes(m).get('/big')).toEqual({ state: 'done', bytes: 1000, partial: true });
    expect(onStreamError(m, true).sizes.get('/big')).toEqual({ state: 'done', bytes: 1000, partial: true });
  });
});
