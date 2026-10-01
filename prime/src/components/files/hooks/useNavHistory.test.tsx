// @vitest-environment jsdom
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaneNav } from '../logic/paneHistory';
import { useNavHistory } from './useNavHistory';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Minimal renderHook: mounts a component that publishes the hook result.
function mount(initial: { enabled: boolean; initialPath: string }) {
  const result: { current: PaneNav | null } = { current: null };
  let setOpts: (o: { enabled: boolean; initialPath: string }) => void = () => {};
  function Probe() {
    const [opts, set] = React.useState(initial);
    setOpts = set;
    result.current = useNavHistory(opts);
    return null;
  }
  const el = document.createElement('div');
  const root: Root = createRoot(el);
  act(() => root.render(<Probe />));
  return {
    nav: () => result.current!,
    setEnabled: (enabled: boolean) => act(() => setOpts({ ...initial, enabled })),
    unmount: () => act(() => root.unmount()),
  };
}

// jsdom delivers history traversal (and popstate) asynchronously.
async function browserBack() {
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 20));
  });
}

let h: ReturnType<typeof mount> | null = null;
beforeEach(() => {
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  h?.unmount();
  h = null;
});

describe('useNavHistory (jsdom)', () => {
  it('each folder change is a history entry and browser Back walks them', async () => {
    h = mount({ enabled: true, initialPath: '/' });
    const start = window.history.length;
    act(() => h!.nav().go('/etc'));
    act(() => h!.nav().go('/etc/ssl'));
    expect(window.history.length).toBe(start + 2);
    expect(window.location.hash).toBe('#files:/etc/ssl');
    expect(h.nav().canBack).toBe(true);
    await browserBack();
    expect(h.nav().path).toBe('/etc');
    expect(window.location.hash).toBe('#files:/etc');
  });

  it('switched off (split view) it neither pushes entries nor follows popstate', async () => {
    h = mount({ enabled: true, initialPath: '/' });
    act(() => h!.nav().go('/etc'));
    h.setEnabled(false);
    const len = window.history.length;
    act(() => h!.nav().go('/var'));
    expect(window.history.length).toBe(len);
    expect(h.nav().path).toBe('/var');
    expect(h.nav().canBack).toBe(false);
    await browserBack();
    expect(h.nav().path).toBe('/var');
  });

  it('switched back on, it re-reads where the browser really is', async () => {
    h = mount({ enabled: true, initialPath: '/' });
    act(() => h!.nav().go('/etc'));
    act(() => h!.nav().go('/etc/ssl'));
    h.setEnabled(false);
    await browserBack();
    await browserBack();
    act(() => h!.nav().reset('/etc/ssl'));
    h.setEnabled(true);
    // Back at the first explorer entry: the in-app Back must not leave the app.
    expect(h.nav().canBack).toBe(false);
    expect(window.location.hash).toBe('#files:/etc/ssl');
  });

  it('reset moves without creating an entry', () => {
    h = mount({ enabled: true, initialPath: '/' });
    const len = window.history.length;
    act(() => h!.nav().reset('/opt'));
    expect(h.nav().path).toBe('/opt');
    expect(window.history.length).toBe(len);
  });
});

describe('useNavHistory — entries rewritten by split view', () => {
  it('reads the left path from a split hash instead of treating it as a folder name', async () => {
    h = mount({ enabled: true, initialPath: '/' });
    act(() => h!.nav().go('/etc'));
    act(() => h!.nav().go('/var'));
    // Split view rewrote the /etc entry while it was visited.
    await browserBack();
    window.history.replaceState(window.history.state, '', '#files:/etc|srv-1:/tmp');
    await act(async () => {
      window.history.forward();
      await new Promise((r) => setTimeout(r, 20));
    });
    await browserBack();
    expect(h.nav().path).toBe('/etc');
  });
});
