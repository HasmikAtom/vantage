import * as React from 'react';
import { createHistory, historyReducer, type PaneNav } from '../logic/paneHistory';

export function useMemoryNav(initialPath: string): PaneNav {
  const [h, dispatch] = React.useReducer(historyReducer, initialPath, createHistory);
  const go = React.useCallback((p: string) => dispatch({ type: 'go', path: p }), []);
  const back = React.useCallback(() => dispatch({ type: 'back' }), []);
  const forward = React.useCallback(() => dispatch({ type: 'forward' }), []);
  const reset = React.useCallback((p: string) => dispatch({ type: 'reset', path: p }), []);
  return {
    path: h.path,
    go,
    back,
    forward,
    reset,
    canBack: h.back.length > 0,
    canForward: h.forward.length > 0,
  };
}
