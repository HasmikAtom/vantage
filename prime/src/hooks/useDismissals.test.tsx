// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import type { Service } from '@/types';
import type { Dismissal } from '@/lib/dismissals';
import { useDismissals, type DismissalApi } from './useDismissals';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const svc = (name: string, status: string, failedSince?: number): Service => ({
  name, status, enabled: true, pid: null, memMb: 0, user: 'root', description: '',
  ...(failedSince !== undefined ? { failedSince } : {}),
});
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function mount(api: DismissalApi, services: Service[]) {
  const out: { r: ReturnType<typeof useDismissals> | null } = { r: null };
  function Probe({ svcs }: { svcs: Service[] }) {
    out.r = useDismissals('srv-1', svcs, api);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe svcs={services} />));
  return { out, rerender: (svcs: Service[]) => act(() => root.render(<Probe svcs={svcs} />)), unmount: () => act(() => root.unmount()) };
}

function fakeApi(initial: Dismissal[]) {
  const saved: Dismissal[][] = [];
  const api: DismissalApi = {
    fetch: async () => initial,
    save: async (_id, d) => { saved.push(d); return d; },
  };
  return { api, saved };
}

describe('useDismissals', () => {
  it('loads, dismisses (saving the failure time) and restores', async () => {
    const { api, saved } = fakeApi([]);
    const services = [svc('cloud-init.service', 'failed', 100), svc('nginx.service', 'failed', 200)];
    const { out, unmount } = mount(api, services);
    await flush();
    expect(out.r!.supported).toBe(true);
    expect(out.r!.alert.map((s) => s.name)).toEqual(['cloud-init.service', 'nginx.service']);
    await act(async () => { out.r!.dismiss(services[0]!); });
    expect(out.r!.alert.map((s) => s.name)).toEqual(['nginx.service']);
    expect(out.r!.isDismissed('cloud-init.service')).toBe(true);
    expect(saved.at(-1)).toEqual([{ unit: 'cloud-init.service', failedSince: 100 }]);
    await act(async () => { out.r!.restore('cloud-init.service'); });
    expect(out.r!.alert).toHaveLength(2);
    expect(saved.at(-1)).toEqual([]);
    unmount();
  });

  it('drops a dismissal in gate once the unit recovers', async () => {
    const { api, saved } = fakeApi([{ unit: 'cloud-init.service', failedSince: 100 }]);
    const { rerender, unmount } = mount(api, [svc('cloud-init.service', 'failed', 100)]);
    await flush();
    expect(saved).toHaveLength(0);
    rerender([svc('cloud-init.service', 'active')]);
    await flush();
    expect(saved.at(-1)).toEqual([]);
    unmount();
  });

  it('turns the feature off (no dismiss) when gate has no dismissals endpoint', async () => {
    const api: DismissalApi = { fetch: async () => { throw new Error('404'); }, save: async (_i, d) => d };
    const { out, unmount } = mount(api, [svc('a.service', 'failed', 1)]);
    await flush();
    expect(out.r!.supported).toBe(false);
    expect(out.r!.alert.map((s) => s.name)).toEqual(['a.service']);
    unmount();
  });
});
