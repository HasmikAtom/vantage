import * as React from 'react';
import {
  PANE_RATIO_DEFAULT,
  PANE_RATIO_KEY,
  clampPaneRatio,
  parsePaneRatio,
  ratioFromPointer,
} from '../logic/paneRatio';

const KEY_STEP = 0.02;

function load(): number {
  try {
    return parsePaneRatio(localStorage.getItem(PANE_RATIO_KEY));
  } catch {
    return PANE_RATIO_DEFAULT;
  }
}

function save(ratio: number): void {
  try {
    localStorage.setItem(PANE_RATIO_KEY, String(ratio));
  } catch {
    // Private mode / blocked storage: the split just isn't remembered.
  }
}

// usePaneRatio makes the split-view divider draggable: the left pane's share
// of containerRef's width. Drag it, use ←/→ on it, or double-click for 50/50.
export function usePaneRatio(
  containerRef: React.RefObject<HTMLElement>,
  // Re-measure when the panes area appears (split view switched on).
  active = true,
): {
  ratio: number;
  dragging: boolean;
  handleProps: React.HTMLAttributes<HTMLDivElement> & { role: 'separator' };
} {
  // chosen is what the user set (and what's saved); ratio is what fits now.
  const [chosen, setChosen] = React.useState(load);
  const [width, setWidth] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const stopDrag = React.useRef<(() => void) | null>(null);

  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [containerRef, active]);

  React.useEffect(() => () => stopDrag.current?.(), []);

  const ratio = clampPaneRatio(chosen, width);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let last = ratio;
    setDragging(true);
    const move = (ev: PointerEvent | MouseEvent) => {
      const r = containerRef.current?.getBoundingClientRect();
      if (!r) return;
      last = clampPaneRatio(ratioFromPointer(ev.clientX, r.left, r.width), r.width);
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
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    stopDrag.current = stop;
  };

  const set = (r: number) => {
    const next = clampPaneRatio(r, width);
    setChosen(next);
    save(next);
  };

  return {
    ratio,
    dragging,
    handleProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize panes',
      'aria-valuenow': Math.round(ratio * 100),
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      tabIndex: 0,
      title: 'Drag to resize · double-click for 50/50',
      onPointerDown,
      onKeyDown: (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        set(ratio + (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP));
      },
      onDoubleClick: () => set(PANE_RATIO_DEFAULT),
    },
  };
}
