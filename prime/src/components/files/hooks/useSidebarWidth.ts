import * as React from 'react';
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  parseSidebarWidth,
} from '../logic/sidebarWidth';

const KEY_STEP = 16;

function load(): number {
  try {
    return parseSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

function save(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // Private mode / blocked storage: the width just isn't remembered.
  }
}

// useSidebarWidth makes the Files sidebar resizable: drag the handle, use
// ←/→ on it, or double-click to reset. containerRef is the card holding the
// sidebar and the panes; its width caps the sidebar so the panes keep room.
export function useSidebarWidth(
  containerRef: React.RefObject<HTMLElement>,
  split: boolean,
): {
  width: number;
  dragging: boolean;
  handleProps: React.HTMLAttributes<HTMLDivElement> & { role: 'separator' };
} {
  // chosen is what the user set (and what's saved); width is what fits now.
  const [chosen, setChosen] = React.useState(load);
  const [room, setRoom] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const stopDrag = React.useRef<(() => void) | null>(null);

  // Measure the card on mount, when split view toggles, and on window
  // resize, so a wide sidebar never squeezes the panes. 0 (not laid out
  // yet, or jsdom) means only the 160–480 px range applies.
  React.useLayoutEffect(() => {
    const measure = () => setRoom(containerRef.current?.getBoundingClientRect().width ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [containerRef, split]);

  const clamp = React.useCallback(
    (w: number) => clampSidebarWidth(w, room || Infinity, split),
    [room, split],
  );
  const width = clamp(chosen);

  React.useEffect(() => () => stopDrag.current?.(), []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    setDragging(true);
    const move = (ev: PointerEvent | MouseEvent) => {
      last = clamp(startW + ev.clientX - startX);
      setChosen(last);
    };
    const up = () => {
      stop();
      save(last);
    };
    const stop = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
      stopDrag.current = null;
      setDragging(false);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    // Keep the resize cursor and stop text selection while the pointer is
    // over the list instead of the handle.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    stopDrag.current = stop;
  };

  const set = (w: number) => {
    const next = clamp(w);
    setChosen(next);
    save(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    set(width + (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP));
  };

  return {
    width,
    dragging,
    handleProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize sidebar',
      'aria-valuenow': width,
      'aria-valuemin': SIDEBAR_MIN,
      'aria-valuemax': SIDEBAR_MAX,
      tabIndex: 0,
      title: 'Drag to resize · double-click to reset',
      onPointerDown,
      onKeyDown,
      onDoubleClick: () => set(SIDEBAR_DEFAULT),
    },
  };
}
