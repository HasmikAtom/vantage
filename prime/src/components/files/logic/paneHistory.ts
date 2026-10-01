// In-memory back/forward history for one explorer pane. Split view uses
// it for both panes (one browser history cannot drive two panes);
// single-pane mode keeps using real browser history (useNavHistory).

export interface PaneNav {
  path: string;
  go(p: string): void;
  back(): void;
  forward(): void;
  reset(p: string): void;
  canBack: boolean;
  canForward: boolean;
}

export interface PaneHistory {
  back: string[];
  path: string;
  forward: string[];
}

export const MAX_HISTORY = 100;

export function createHistory(path: string): PaneHistory {
  return { back: [], path, forward: [] };
}

export type HistoryAction =
  | { type: 'go'; path: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reset'; path: string };

export function historyReducer(h: PaneHistory, a: HistoryAction): PaneHistory {
  switch (a.type) {
    case 'go':
      if (a.path === h.path) return h;
      return { back: [...h.back, h.path].slice(-MAX_HISTORY), path: a.path, forward: [] };
    case 'back': {
      const prev = h.back[h.back.length - 1];
      if (prev === undefined) return h;
      return { back: h.back.slice(0, -1), path: prev, forward: [h.path, ...h.forward] };
    }
    case 'forward': {
      const next = h.forward[0];
      if (next === undefined) return h;
      return { back: [...h.back, h.path], path: next, forward: h.forward.slice(1) };
    }
    case 'reset':
      return createHistory(a.path);
  }
}
