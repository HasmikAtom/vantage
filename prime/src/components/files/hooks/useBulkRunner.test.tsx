// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { useBulkRunner, type AskConflict } from './useBulkRunner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useBulkRunner (jsdom)', () => {
  it('answers a pending conflict prompt with "cancelled" when the explorer unmounts', async () => {
    let ask: AskConflict | null = null;
    function Probe() {
      const r = useBulkRunner(() => {});
      ask = r.askConflict;
      return <>{r.dialogs}</>;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe />));
    let answer: unknown = 'pending';
    act(() => {
      void ask!({ id: 'x', label: 'x' }).then((a) => (answer = a));
    });
    act(() => root.unmount());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(answer).toMatchObject({ cancelled: true });
  });
});

describe('useBulkRunner — one operation at a time', () => {
  function mountRunner() {
    const busyCalls = { n: 0 };
    const api: { r: ReturnType<typeof useBulkRunner> | null } = { r: null };
    function Probe() {
      const r = useBulkRunner(() => {}, () => { busyCalls.n++; });
      api.r = r;
      return <>{r.dialogs}</>;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<Probe />));
    return { api, busyCalls, root, host };
  }
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `i${i}` }));

  it('refuses a second run while one is running, then allows the next one', async () => {
    const { api, busyCalls, root } = mountRunner();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let first!: Promise<unknown>;
    act(() => { first = api.r!.runBulk('first', items(1), () => hold); });
    let second: { status: string }[] = [];
    await act(async () => { second = await api.r!.runBulk('second', items(2), async () => {}); });
    expect(second.map((s) => s.status)).toEqual(['cancelled', 'cancelled']);
    expect(busyCalls.n).toBe(1);
    await act(async () => { release(); await first; });
    let third: { status: string }[] = [];
    await act(async () => { third = await api.r!.runBulk('third', items(1), async () => {}); });
    expect(third.map((s) => s.status)).toEqual(['done']);
    act(() => root.unmount());
  });

  it('stays busy while a finished run with failures still offers Retry, until Close', async () => {
    const { api, busyCalls, root, host } = mountRunner();
    await act(async () => { await api.r!.runBulk('failing', items(1), async () => { throw new Error('boom'); }); });
    let blocked: { status: string }[] = [];
    await act(async () => { blocked = await api.r!.runBulk('next', items(1), async () => {}); });
    expect(blocked[0]?.status).toBe('cancelled');
    expect(busyCalls.n).toBe(1);
    const close = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Close');
    expect(close).toBeTruthy();
    act(() => close!.click());
    let after: { status: string }[] = [];
    await act(async () => { after = await api.r!.runBulk('next', items(1), async () => {}); });
    expect(after[0]?.status).toBe('done');
    act(() => root.unmount());
    host.remove();
  });
});
