import * as React from 'react';
import type { Service } from '@/types';
import { fetchDismissals, saveDismissals } from '@/api';
import {
  addDismissal,
  pruneDismissals,
  removeDismissal,
  splitFailed,
  type Dismissal,
} from '@/lib/dismissals';

export interface DismissalApi {
  fetch(serverId: string): Promise<Dismissal[]>;
  save(serverId: string, dismissals: Dismissal[]): Promise<Dismissal[]>;
}

const defaultApi: DismissalApi = { fetch: fetchDismissals, save: saveDismissals };

// useDismissals loads the user's dismissed failed services for a server
// from gate, splits current failures into ones to alert on and dismissed
// ones, and keeps gate tidy: a dismissal is dropped (and saved) once its
// unit recovers or fails again. A gate without the endpoint turns the
// feature off rather than erroring.
export function useDismissals(
  serverId: string,
  services: readonly Service[],
  api: DismissalApi = defaultApi,
): {
  supported: boolean;
  alert: Service[];
  dismissed: Service[];
  isDismissed(unit: string): boolean;
  dismiss(s: Service): void;
  restore(unit: string): void;
} {
  const [state, setState] = React.useState<{ serverId: string; list: Dismissal[] } | null>(null);
  const [supported, setSupported] = React.useState(true);
  const apiRef = React.useRef(api);
  apiRef.current = api;

  React.useEffect(() => {
    let live = true;
    setState(null);
    if (!serverId) return;
    apiRef.current.fetch(serverId).then(
      (list) => {
        if (!live) return;
        setSupported(true);
        setState({ serverId, list });
      },
      () => {
        if (live) setSupported(false);
      },
    );
    return () => {
      live = false;
    };
  }, [serverId]);

  const list = state?.serverId === serverId ? state.list : null;

  const commit = React.useCallback(
    (next: Dismissal[]) => {
      setState({ serverId, list: next });
      apiRef.current.save(serverId, next).catch(() => {
        // Not saved: it still applies in this session and is retried on the
        // next change.
      });
    },
    [serverId],
  );

  // Expire dismissals whose unit recovered or failed again.
  React.useEffect(() => {
    if (!list) return;
    const pruned = pruneDismissals(list, services);
    if (pruned !== list) commit(pruned);
  }, [list, services, commit]);

  const split = React.useMemo(() => splitFailed(services, list ?? []), [services, list]);
  const dismissedNames = React.useMemo(() => new Set(split.dismissed.map((s) => s.name)), [split]);

  return {
    supported: supported && list !== null,
    alert: split.alert,
    dismissed: split.dismissed,
    isDismissed: (unit) => dismissedNames.has(unit),
    dismiss: (s) => {
      if (list) commit(addDismissal(list, s));
    },
    restore: (unit) => {
      if (list) commit(removeDismissal(list, unit));
    },
  };
}
