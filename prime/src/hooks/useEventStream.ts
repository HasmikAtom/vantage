import * as React from 'react';

export interface EventStreamState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/**
 * Subscribes to a Server-Sent Events stream and parses each `message` event
 * body as JSON-of-type-T.
 *
 * The browser's EventSource handles auto-reconnect natively, including
 * sending Last-Event-ID on retry — the outpost uses that to skip the
 * initial snapshot resend if the client is already current.
 *
 * Lifecycle:
 *   - `url=null` keeps the hook mounted without opening a connection (e.g.
 *     when there's no active server selected yet).
 *   - On `key` change (e.g. active server switch) we close the current
 *     EventSource and open a fresh one — and reset state synchronously so
 *     the UI doesn't briefly show the previous key's data under the new key.
 *   - On tab hide we close the connection and on show we reopen.
 *     Backgrounded tabs don't burn a connection or receive pushes.
 */
export function useEventStream<T>(
  url: string | null,
  key: string | number,
): EventStreamState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<Error | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Synchronous reset on key change — avoids a one-frame flash of the
  // previous key's data under the new key.
  const prevKeyRef = React.useRef(key);
  if (prevKeyRef.current !== key) {
    prevKeyRef.current = key;
    setData(null);
    setError(null);
    setLoading(true);
  }

  React.useEffect(() => {
    if (!url) return;

    let cancelled = false;
    let es: EventSource | null = null;

    const open = () => {
      if (cancelled) return;
      const next = new EventSource(url, { withCredentials: true });
      es = next;
      next.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const parsed = JSON.parse(ev.data) as T;
          setData(parsed);
          setError(null);
          setLoading(false);
        } catch (e) {
          setError(e instanceof Error ? e : new Error(String(e)));
        }
      };
      next.onerror = () => {
        if (cancelled) return;
        // EventSource is in one of three states after onerror:
        //   CONNECTING (0): the browser is retrying — don't disturb the UI.
        //   OPEN (1):       transient hiccup, ignore.
        //   CLOSED (2):     terminal (server returned 4xx, or auth failed).
        //                   Surface to the UI so the user sees something.
        if (next.readyState === EventSource.CLOSED) {
          setError(new Error('stream closed'));
        }
      };
    };

    const onVisibility = () => {
      if (document.hidden) {
        es?.close();
        es = null;
      } else if (es === null) {
        open();
      }
    };

    if (!document.hidden) open();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      es?.close();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [url, key]);

  return { data, error, loading };
}
