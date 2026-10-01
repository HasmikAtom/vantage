// @vitest-environment jsdom
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStoredFlag } from './useStoredFlag';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(key: string) {
  const api: { value: boolean; set: (v: boolean) => void } = { value: false, set: () => {} };
  function Probe() {
    const [value, set] = useStoredFlag(key);
    api.value = value;
    api.set = set;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  return { api, unmount: () => act(() => root.unmount()) };
}

describe('useStoredFlag', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('is off by default, and remembers being switched on', () => {
    const first = mount('k');
    expect(first.api.value).toBe(false);
    act(() => first.api.set(true));
    expect(first.api.value).toBe(true);
    first.unmount();
    const again = mount('k');
    expect(again.api.value).toBe(true);
    act(() => again.api.set(false));
    again.unmount();
    expect(mount('k').api.value).toBe(false);
  });

  it('still works when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { api, unmount } = mount('k');
    expect(api.value).toBe(false);
    act(() => api.set(true));
    expect(api.value).toBe(true);
    unmount();
  });
});
