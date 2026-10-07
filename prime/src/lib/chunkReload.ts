// After a release, a tab opened on the previous build asks for code chunks
// that no longer exist (their names are content hashes). Vite reports that
// as `vite:preloadError`; reloading picks up the new build. A short guard
// stops a genuinely broken build from reloading forever: the second failure
// within 10 s goes through to the error screen instead.

const KEY = 'vantage.chunkReloadAt';
const WINDOW_MS = 10_000;

export function shouldReloadForChunkError(lastReloadAt: number | null, now: number): boolean {
  return lastReloadAt === null || now - lastReloadAt >= WINDOW_MS;
}

interface WindowLike {
  addEventListener(type: string, listener: (e: Event) => void): void;
  location: { reload(): void };
  sessionStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
}

export function installChunkReload(win: WindowLike = window, now: () => number = Date.now): void {
  win.addEventListener('vite:preloadError', (e) => {
    let last: number | null = null;
    try {
      const raw = win.sessionStorage.getItem(KEY);
      last = raw === null ? null : Number(raw);
    } catch {
      // Blocked storage: no guard, but still recover.
    }
    if (!shouldReloadForChunkError(last, now())) return;
    try {
      win.sessionStorage.setItem(KEY, String(now()));
    } catch {
      // As above.
    }
    e.preventDefault();
    win.location.reload();
  });
}
