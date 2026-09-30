import * as React from 'react';
import { clipboardStore, type FsClipboard } from '../logic/clipboard';

export function useClipboard(): { current: FsClipboard | null; set: (c: FsClipboard | null) => void } {
  const current = React.useSyncExternalStore(clipboardStore.subscribe, clipboardStore.get, clipboardStore.get);
  return { current, set: clipboardStore.set };
}
