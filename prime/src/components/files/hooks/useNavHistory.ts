import * as React from 'react';
import { ROOT } from '../fsPath';
import {
  canBack,
  canForward,
  hashFor,
  navInit,
  navOnEnable,
  navPop,
  navPush,
  pathFromHash,
  type NavModel,
} from '../logic/history';
import type { PaneNav } from '../logic/paneHistory';

function stateIdx(state: unknown): unknown {
  return state && typeof state === 'object' ? (state as { filesIdx?: unknown }).filesIdx : undefined;
}

// useNavHistory makes every folder change a browser history entry
// (#files:<path>, state {filesIdx}). ←/→ call history.back/forward only
// within entries this tab created, so they never leave the dashboard.
//
// enabled=false (split view) parks it: no stamping, no pushes, no popstate
// handling — split view keeps its own in-memory histories and writes the
// URL itself. reset() moves to a path without creating an entry; when the
// hook is re-enabled it stamps the current entry with that path.
export function useNavHistory(opts: { enabled?: boolean; initialPath?: string } = {}): PaneNav {
  const enabled = opts.enabled ?? true;
  const [path, setPath] = React.useState<string>(
    () => opts.initialPath ?? pathFromHash(window.location.hash) ?? ROOT,
  );
  const pathRef = React.useRef(path);
  const model = React.useRef<NavModel>(navInit(stateIdx(window.history.state)));
  const [, rerender] = React.useReducer((x: number) => x + 1, 0);

  React.useEffect(() => {
    if (!enabled) return;
    // Re-sync with the entry the browser is really on (Back/Forward may
    // have moved it while split view had history handling switched off).
    model.current = navOnEnable(window.history.state);
    // Stamp the entry we are on so popstate can recognise it.
    window.history.replaceState({ filesIdx: model.current.idx }, '', hashFor(pathRef.current));
    const onPop = (e: PopStateEvent) => {
      const p = pathFromHash(window.location.hash);
      if (p === null) return;
      model.current = navPop(model.current, stateIdx(e.state));
      pathRef.current = p;
      setPath(p);
      rerender();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [enabled]);

  const go = React.useCallback(
    (next: string) => {
      if (next === pathRef.current) return;
      if (enabled) {
        model.current = navPush(model.current);
        window.history.pushState({ filesIdx: model.current.idx }, '', hashFor(next));
      }
      pathRef.current = next;
      setPath(next);
      rerender();
    },
    [enabled],
  );

  const reset = React.useCallback((next: string) => {
    pathRef.current = next;
    setPath(next);
  }, []);

  const back = React.useCallback(() => {
    if (enabled && canBack(model.current)) window.history.back();
  }, [enabled]);
  const forward = React.useCallback(() => {
    if (enabled && canForward(model.current)) window.history.forward();
  }, [enabled]);

  return {
    path,
    go,
    back,
    forward,
    reset,
    canBack: enabled && canBack(model.current),
    canForward: enabled && canForward(model.current),
  };
}
