import { describe, expect, it } from 'vitest';
import type { Service } from '@/types';
import { addDismissal, pruneDismissals, removeDismissal, splitFailed, type Dismissal } from './dismissals';

const svc = (name: string, status: string, failedSince?: number): Service => ({
  name, status, enabled: true, pid: null, memMb: 0, user: 'root', description: '',
  ...(failedSince !== undefined ? { failedSince } : {}),
});

describe('splitFailed', () => {
  it('separates dismissed failures from the ones to alert on', () => {
    const services = [svc('cloud-init.service', 'failed', 100), svc('nginx.service', 'failed', 200), svc('ssh.service', 'active')];
    const d: Dismissal[] = [{ unit: 'cloud-init.service', failedSince: 100 }];
    const r = splitFailed(services, d);
    expect(r.alert.map((s) => s.name)).toEqual(['nginx.service']);
    expect(r.dismissed.map((s) => s.name)).toEqual(['cloud-init.service']);
  });
  it('alerts again when the unit failed again at a different time', () => {
    const r = splitFailed([svc('cloud-init.service', 'failed', 999)], [{ unit: 'cloud-init.service', failedSince: 100 }]);
    expect(r.alert.map((s) => s.name)).toEqual(['cloud-init.service']);
  });
  it('matches by name when either side has no failure time (older outposts)', () => {
    expect(splitFailed([svc('a.service', 'failed')], [{ unit: 'a.service', failedSince: 5 }]).dismissed).toHaveLength(1);
    expect(splitFailed([svc('a.service', 'failed', 5)], [{ unit: 'a.service', failedSince: null }]).dismissed).toHaveLength(1);
  });
});

describe('pruneDismissals', () => {
  it('ends a dismissal once the unit is healthy again', () => {
    const d: Dismissal[] = [{ unit: 'a.service', failedSince: 1 }];
    expect(pruneDismissals(d, [svc('a.service', 'active')])).toEqual([]);
  });
  it('ends a dismissal when the unit failed again later', () => {
    const d: Dismissal[] = [{ unit: 'a.service', failedSince: 1 }];
    expect(pruneDismissals(d, [svc('a.service', 'failed', 2)])).toEqual([]);
  });
  it('keeps dismissals for units it cannot see (data not loaded, unit filtered out)', () => {
    const d: Dismissal[] = [{ unit: 'a.service', failedSince: 1 }];
    expect(pruneDismissals(d, [])).toBe(d);
    expect(pruneDismissals(d, [svc('b.service', 'active')])).toBe(d);
  });
  it('returns the same list when nothing changes, so callers can skip a save', () => {
    const d: Dismissal[] = [{ unit: 'a.service', failedSince: 1 }];
    expect(pruneDismissals(d, [svc('a.service', 'failed', 1)])).toBe(d);
  });
});

describe('addDismissal / removeDismissal', () => {
  it('records the current failure time, replacing an older entry', () => {
    const d = addDismissal([{ unit: 'a.service', failedSince: 1 }], svc('a.service', 'failed', 7));
    expect(d).toEqual([{ unit: 'a.service', failedSince: 7 }]);
    expect(addDismissal([], svc('b.service', 'failed'))).toEqual([{ unit: 'b.service', failedSince: null }]);
  });
  it('removes by unit', () => {
    expect(removeDismissal([{ unit: 'a.service', failedSince: 1 }, { unit: 'b.service', failedSince: null }], 'a.service')).toEqual([
      { unit: 'b.service', failedSince: null },
    ]);
  });
});
