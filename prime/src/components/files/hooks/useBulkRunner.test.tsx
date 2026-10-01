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
