import * as React from 'react';
import { restoreSplitHash, splitHashFor } from '../logic/splitHash';

// Keeps the URL in step with split view: both panes are written into the
// hash (replaceState, no history entries), and when browser Back/Forward
// lands on an older Files entry the split hash is put back on it — the
// panes themselves don't follow browser history in split view.
export function useSplitUrl(split: boolean, left: string, rightServer: string, right: string): void {
  React.useEffect(() => {
    if (!split) return;
    window.history.replaceState(window.history.state, '', splitHashFor(left, rightServer, right));
  }, [split, left, rightServer, right]);

  React.useEffect(() => {
    if (!split) return;
    const onPop = () => {
      const h = restoreSplitHash(window.location.hash, left, rightServer, right);
      if (h) window.history.replaceState(window.history.state, '', h);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [split, left, rightServer, right]);
}
