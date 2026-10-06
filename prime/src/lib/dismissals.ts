import type { Service } from '@/types';

// Dismissed failed services (stored per user and server in gate). A
// dismissal hides a known-harmless failure from the alert banner, keyed on
// when the unit failed, so a later failure alerts again.

export interface Dismissal {
  unit: string;
  failedSince: number | null;
}

// Same failure as the one dismissed? Without a time on either side (older
// outposts, or dismissed before times existed) the unit name decides.
function sameFailure(d: Dismissal, s: Service): boolean {
  return d.failedSince === null || s.failedSince === undefined || d.failedSince === s.failedSince;
}

export function splitFailed(
  services: readonly Service[],
  dismissals: readonly Dismissal[],
): { alert: Service[]; dismissed: Service[] } {
  const byUnit = new Map(dismissals.map((d) => [d.unit, d]));
  const alert: Service[] = [];
  const dismissed: Service[] = [];
  for (const s of services) {
    if (s.status !== 'failed') continue;
    const d = byUnit.get(s.name);
    (d && sameFailure(d, s) ? dismissed : alert).push(s);
  }
  return { alert, dismissed };
}

// Drop dismissals whose unit recovered or failed again since. Units not in
// `services` are kept: the data may not be loaded yet, or the outpost
// filters that unit. Returns the same array when nothing changed.
export function pruneDismissals(dismissals: Dismissal[], services: readonly Service[]): Dismissal[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const kept = dismissals.filter((d) => {
    const s = byName.get(d.unit);
    return !s || (s.status === 'failed' && sameFailure(d, s));
  });
  return kept.length === dismissals.length ? dismissals : kept;
}

export function addDismissal(dismissals: readonly Dismissal[], s: Service): Dismissal[] {
  return [...removeDismissal(dismissals, s.name), { unit: s.name, failedSince: s.failedSince ?? null }];
}

export function removeDismissal(dismissals: readonly Dismissal[], unit: string): Dismissal[] {
  return dismissals.filter((d) => d.unit !== unit);
}
