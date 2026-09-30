import * as React from 'react';
import { fsSizesURL } from '@/api';
import {
  applySizeEvent,
  initialSizes,
  onStreamError,
  settleSizes,
  type SizeEvent,
  type SizeMap,
} from '../logic/sizes';

// Servers whose outpost has no /fs/sizes (older version): remembered for
// the page session so we stop opening streams that fail.
const unsupportedServers = new Set<string>();

export function useDirSizes(
  serverId: string,
  path: string,
  dirPaths: readonly string[],
  reloadKey: number,
): SizeMap {
  const dirsKey = dirPaths.join('\u0000');
  const [sizes, setSizes] = React.useState<SizeMap>(() => new Map());

  React.useEffect(() => {
    const dirs = dirsKey === '' ? [] : dirsKey.split('\u0000');
    const supported = !unsupportedServers.has(serverId);
    setSizes(initialSizes(dirs, supported));
    if (!supported || dirs.length === 0) return;

    const es = new EventSource(fsSizesURL(serverId, path), { withCredentials: true });
    let receivedAny = false;
    es.onmessage = (ev: MessageEvent<string>) => {
      receivedAny = true;
      try {
        const data = JSON.parse(ev.data) as SizeEvent;
        setSizes((m) => applySizeEvent(m, data));
      } catch {
        // ignore a malformed event; the folder falls back to "—" on done
      }
    };
    es.addEventListener('done', () => {
      es.close();
      setSizes((m) => settleSizes(m));
    });
    es.onerror = () => {
      // Close instead of letting EventSource auto-reconnect forever.
      es.close();
      if (!receivedAny) unsupportedServers.add(serverId);
      setSizes((m) => onStreamError(m, receivedAny).sizes);
    };
    return () => es.close();
  }, [serverId, path, dirsKey, reloadKey]);

  return sizes;
}
