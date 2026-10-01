// @vitest-environment jsdom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaneRatio } from './usePaneRatio';
import { PANE_RATIO_KEY } from '../logic/paneRatio';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const api: { ratio: number } = { ratio: 0 };
  function Probe() {
    const ref = React.useRef<HTMLDivElement>(null);
    const { ratio, handleProps } = usePaneRatio(ref);
    api.ratio = ratio;
    return (
      <div ref={ref}>
        <div data-testid="divider" {...handleProps} />
      </div>
    );
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Probe />));
  const handle = host.querySelector('[data-testid="divider"]') as HTMLElement;
  return { api, handle, unmount: () => { act(() => root.unmount()); host.remove(); } };
}
const pointer = (type: string, clientX: number) => new MouseEvent(type, { clientX, bubbles: true, button: 0 });
const key = (k: string) => new KeyboardEvent('keydown', { key: k, bubbles: true });

describe('usePaneRatio', () => {
  // The panes area: 1000 px wide starting at x=100.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 1000 } as DOMRect);
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starts even, follows a drag and remembers it', () => {
    const { api, handle, unmount } = mount();
    expect(api.ratio).toBe(0.5);
    act(() => { handle.dispatchEvent(pointer('pointerdown', 600)); });
    act(() => { document.dispatchEvent(pointer('pointermove', 500)); });
    expect(api.ratio).toBe(0.4);
    act(() => { document.dispatchEvent(pointer('pointerup', 500)); });
    expect(localStorage.getItem(PANE_RATIO_KEY)).toBe('0.4');
    act(() => { document.dispatchEvent(pointer('pointermove', 900)); });
    expect(api.ratio).toBe(0.4);
    unmount();
  });

  it('keeps each pane at least 360 px while dragging', () => {
    const { api, handle, unmount } = mount();
    act(() => { handle.dispatchEvent(pointer('pointerdown', 600)); });
    act(() => { document.dispatchEvent(pointer('pointermove', 120)); });
    expect(api.ratio).toBe(0.36);
    act(() => { document.dispatchEvent(pointer('pointerup', 120)); });
    unmount();
  });

  it('moves with the arrow keys and resets on double-click', () => {
    localStorage.setItem(PANE_RATIO_KEY, '0.4');
    const { api, handle, unmount } = mount();
    expect(api.ratio).toBe(0.4);
    act(() => { handle.dispatchEvent(key('ArrowRight')); });
    expect(api.ratio).toBe(0.42);
    act(() => { handle.dispatchEvent(key('ArrowLeft')); });
    act(() => { handle.dispatchEvent(key('ArrowLeft')); });
    expect(api.ratio).toBe(0.38);
    act(() => { handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(api.ratio).toBe(0.5);
    expect(localStorage.getItem(PANE_RATIO_KEY)).toBe('0.5');
    unmount();
  });
});
