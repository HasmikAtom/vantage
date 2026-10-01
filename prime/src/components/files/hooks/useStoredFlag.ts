import * as React from 'react';

// A boolean remembered in localStorage under `key` ('1' = on). Blocked
// storage (private mode) still works for the session, just isn't saved.
export function useStoredFlag(key: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = React.useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  const set = React.useCallback(
    (next: boolean) => {
      setOn(next);
      try {
        if (next) localStorage.setItem(key, '1');
        else localStorage.removeItem(key);
      } catch {
        // Not remembered; the toggle still applies now.
      }
    },
    [key],
  );
  return [on, set];
}
