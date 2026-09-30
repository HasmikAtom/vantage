import * as React from 'react';
import { fetchPins, savePins, type FsPin } from '@/api';
import { defaultPins } from '../logic/pins';

export function usePins(serverId: string): {
  pins: FsPin[];
  save: (next: FsPin[]) => Promise<void>;
  error: string | null;
} {
  const [pins, setPins] = React.useState<FsPin[]>(defaultPins);
  const [error, setError] = React.useState<string | null>(null);
  const pinsRef = React.useRef(pins);
  pinsRef.current = pins;

  React.useEffect(() => {
    let alive = true;
    setPins(defaultPins());
    fetchPins(serverId)
      .then((p) => alive && setPins(p.length ? p : defaultPins()))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [serverId]);

  const save = React.useCallback(
    async (next: FsPin[]) => {
      const prev = pinsRef.current;
      setPins(next.length ? next : defaultPins());
      setError(null);
      try {
        const saved = await savePins(serverId, next);
        setPins(saved.length ? saved : defaultPins());
      } catch (e) {
        setPins(prev);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [serverId],
  );

  return { pins, save, error };
}
