// @vitest-environment jsdom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSidebarWidth } from './useSidebarWidth';
import { SIDEBAR_DEFAULT, SIDEBAR_WIDTH_KEY } from '../logic/sidebarWidth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const api: { width: number } = { width: 0 };
  function Probe() {
    const ref = React.useRef<HTMLDivElement>(null);
    const { width, handleProps } = useSidebarWidth(ref, false);
    api.width = width;
    return (
      <div ref={ref}>
        <div data-testid="handle" {...handleProps} />
      </div>
    );
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Probe />));
  const handle = host.querySelector('[data-testid="handle"]') as HTMLElement;
  return { api, handle, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

const pointer = (type: string, clientX: number) =>
  new MouseEvent(type, { clientX, bubbles: true, button: 0 });

describe('useSidebarWidth', () => {
  afterEach(() => localStorage.clear());

  it('starts at the default and follows a drag, then remembers it', () => {
    const { api, handle, unmount } = mount();
    expect(api.width).toBe(SIDEBAR_DEFAULT);
    act(() => { handle.dispatchEvent(pointer('pointerdown', 500)); });
    act(() => { document.dispatchEvent(pointer('pointermove', 600)); });
    expect(api.width).toBe(SIDEBAR_DEFAULT + 100);
    act(() => { document.dispatchEvent(pointer('pointerup', 600)); });
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_DEFAULT + 100));
    // Moving after release does nothing.
    act(() => { document.dispatchEvent(pointer('pointermove', 900)); });
    expect(api.width).toBe(SIDEBAR_DEFAULT + 100);
    unmount();
  });

  it('restores a saved width', () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '300');
    const { api, unmount } = mount();
    expect(api.width).toBe(300);
    unmount();
  });

  it('resizes with the arrow keys and resets on double-click', () => {
    const { api, handle, unmount } = mount();
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(api.width).toBe(SIDEBAR_DEFAULT + 16);
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(api.width).toBe(SIDEBAR_DEFAULT - 16);
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_DEFAULT - 16));
    act(() => { handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(api.width).toBe(SIDEBAR_DEFAULT);
    unmount();
  });

  it('keeps arrow keys on the handle away from the file list', () => {
    const { handle, unmount } = mount();
    let reached = false;
    const onKey = () => { reached = true; };
    window.addEventListener('keydown', onKey);
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    window.removeEventListener('keydown', onKey);
    expect(reached).toBe(false);
    unmount();
  });
});

describe('useSidebarWidth — split view cap', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('caps the width while split needs room and gives it back afterwards', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, '480');
    const api: { width: number } = { width: 0 };
    function Probe({ split }: { split: boolean }) {
      const ref = React.useRef<HTMLDivElement>(null);
      api.width = useSidebarWidth(ref, split).width;
      return <div ref={ref} />;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Probe split={false} />));
    expect(api.width).toBe(480);
    act(() => root.render(<Probe split />));
    expect(api.width).toBe(360);
    act(() => root.render(<Probe split={false} />));
    expect(api.width).toBe(480);
    expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('480');
    act(() => root.unmount());
  });
});
