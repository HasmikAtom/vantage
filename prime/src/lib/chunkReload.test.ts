import { describe, expect, it, vi } from 'vitest';
import { installChunkReload, shouldReloadForChunkError } from './chunkReload';

describe('shouldReloadForChunkError', () => {
  it('reloads when it has not just done so', () => {
    expect(shouldReloadForChunkError(null, 100_000)).toBe(true);
    expect(shouldReloadForChunkError(50_000, 100_000)).toBe(true);
  });
  it('does not reload again within 10 s, so a broken build cannot loop', () => {
    expect(shouldReloadForChunkError(95_000, 100_000)).toBe(false);
  });
});

function fakeWindow() {
  const listeners: Record<string, (e: Event) => void> = {};
  const store = new Map<string, string>();
  const reload = vi.fn();
  return {
    listeners,
    store,
    reload,
    win: {
      addEventListener: (type: string, fn: (e: Event) => void) => { listeners[type] = fn; },
      location: { reload },
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
    },
  };
}

describe('installChunkReload', () => {
  it('reloads once on a failed chunk and swallows the error', () => {
    const f = fakeWindow();
    installChunkReload(f.win as never, () => 100_000);
    const ev = new Event('vite:preloadError', { cancelable: true });
    f.listeners['vite:preloadError']!(ev);
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });
  it('lets the error through (to the error screen) if it already reloaded just now', () => {
    const f = fakeWindow();
    f.store.set('vantage.chunkReloadAt', '95000');
    installChunkReload(f.win as never, () => 100_000);
    const ev = new Event('vite:preloadError', { cancelable: true });
    f.listeners['vite:preloadError']!(ev);
    expect(f.reload).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
  it('still reloads when session storage is blocked', () => {
    const f = fakeWindow();
    f.win.sessionStorage.getItem = () => { throw new Error('blocked'); };
    f.win.sessionStorage.setItem = () => { throw new Error('blocked'); };
    installChunkReload(f.win as never, () => 100_000);
    f.listeners['vite:preloadError']!(new Event('vite:preloadError', { cancelable: true }));
    expect(f.reload).toHaveBeenCalledTimes(1);
  });
});
