// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSplitUrl } from './useSplitUrl';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let unmount: () => void = () => {};
function mount(props: { split: boolean; left: string; rightServer: string; right: string }) {
  function Probe() {
    useSplitUrl(props.split, props.left, props.rightServer, props.right);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  unmount = () => act(() => root.unmount());
}

async function back() {
  await act(async () => {
    window.history.back();
    await new Promise((r) => setTimeout(r, 20));
  });
}

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(() => unmount());

describe('useSplitUrl (jsdom)', () => {
  it('writes both panes into the URL without adding history entries', () => {
    const len = window.history.length;
    mount({ split: true, left: '/etc', rightServer: 'srv-b', right: '/var log' });
    expect(window.location.hash).toBe('#files:/etc|srv-b:/var%20log');
    expect(window.history.length).toBe(len);
  });

  it('puts the split back when browser Back lands on an older Files entry', async () => {
    window.history.replaceState(null, '', '#files:/old');
    window.history.pushState(null, '', '#files:/etc');
    mount({ split: true, left: '/etc', rightServer: 'srv-b', right: '/tmp' });
    await back();
    expect(window.location.hash).toBe('#files:/etc|srv-b:/tmp');
  });

  it('leaves another tab\'s URL alone', async () => {
    window.history.replaceState(null, '', '#overview');
    window.history.pushState(null, '', '#files:/etc');
    mount({ split: true, left: '/etc', rightServer: 'srv-b', right: '/tmp' });
    await back();
    expect(window.location.hash).toBe('#overview');
  });

  it('does nothing outside split view', async () => {
    window.history.replaceState(null, '', '#files:/old');
    window.history.pushState(null, '', '#files:/etc');
    mount({ split: false, left: '/etc', rightServer: 'srv-b', right: '/tmp' });
    expect(window.location.hash).toBe('#files:/etc');
    await back();
    expect(window.location.hash).toBe('#files:/old');
  });
});
