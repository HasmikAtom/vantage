import * as React from 'react';
import { ROOT } from '../fsPath';
import {
  canBack,
  canForward,
  hashFor,
  navInit,
  navPop,
  navPush,
  pathFromHash,
  type NavModel,
} from '../logic/history';

function stateIdx(state: unknown): unknown {
  return state && typeof state === 'object' ? (state as { filesIdx?: unknown }).filesIdx : undefined;
}

// useNavHistory makes every folder change a browser history entry
// (#files:<path>, state {filesIdx}). ←/→ call history.back/forward only
// within entries this tab created, so they never leave the dashboard.
export function useNavHistory() {
  const [path, setPath] = React.useState<string>(() => pathFromHash(window.location.hash) ?? ROOT);
  const pathRef = React.useRef(path);
  const model = React.useRef<NavModel>(navInit(stateIdx(window.history.state)));
  const [, rerender] = React.useReducer((x: number) => x + 1, 0);

  React.useEffect(() => {
    // Stamp the entry we landed on so popstate can recognise it.
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
  }, []);

  const go = React.useCallback((next: string) => {
    if (next === pathRef.current) return;
    model.current = navPush(model.current);
    window.history.pushState({ filesIdx: model.current.idx }, '', hashFor(next));
    pathRef.current = next;
    setPath(next);
    rerender();
  }, []);

  const back = React.useCallback(() => {
    if (canBack(model.current)) window.history.back();
  }, []);
  const forward = React.useCallback(() => {
    if (canForward(model.current)) window.history.forward();
  }, []);

  return {
    path,
    go,
    back,
    forward,
    canBack: canBack(model.current),
    canForward: canForward(model.current),
  };
}
