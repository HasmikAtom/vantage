import * as React from 'react';
import ReactDOM from 'react-dom';

interface TipState {
  content: React.ReactNode;
  x: number;
  y: number;
}

/**
 * Stable tooltip handle. Pass this to memoized children — both `show` and
 * `hide` are `useCallback`-stable across renders, so `React.memo` on
 * consumers (SensorTile, UserRow, GroupChip, …) actually skips work on
 * tick re-renders rather than being defeated by a fresh handle object
 * every parent render.
 */
export interface FloatingTooltip {
  show: (content: React.ReactNode, e: React.MouseEvent<HTMLElement>) => void;
  hide: () => void;
}

export interface FloatingTooltipResult {
  tt: FloatingTooltip;
  /**
   * The portal node to render inside the parent's JSX (typically once, at
   * the root of the authenticated tree). Identity changes when the tip
   * shows/hides — but only the single consumer that renders this node sees
   * that churn.
   */
  Portal: React.ReactNode;
}

/**
 * Lazily acquire a single, persistent <div> hosted on document.body for the
 * tooltip portal. createPortal could render directly into document.body, but
 * doing so means every show()/hide() cycle inserts/removes a child of <body>
 * — noisy in devtools and tangles with any code that iterates body's
 * children. One dedicated host node, created once and explicitly removed on
 * unmount, keeps the portal contents isolated.
 */
function useTooltipHost(): HTMLDivElement | null {
  // null on first render so SSR / non-browser bootstraps don't blow up;
  // populated by the mount effect.
  const [host, setHost] = React.useState<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = document.createElement('div');
    el.setAttribute('data-tooltip-host', '');
    document.body.appendChild(el);
    setHost(el);
    return () => {
      el.remove();
    };
  }, []);
  return host;
}

export function useFloatingTooltip(): FloatingTooltipResult {
  const [tip, setTip] = React.useState<TipState | null>(null);
  const host = useTooltipHost();

  // useCallback so `show`/`hide` identities are stable across renders.
  const show = React.useCallback(
    (content: React.ReactNode, e: React.MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setTip({ content, x: r.left + r.width / 2, y: r.top });
    },
    [],
  );
  const hide = React.useCallback(() => setTip(null), []);

  // Memoize the handle on the stable callbacks so its object identity
  // doesn't churn either. This is what callers pass to React.memo'd
  // children as a prop.
  const tt = React.useMemo<FloatingTooltip>(() => ({ show, hide }), [show, hide]);

  const Portal =
    tip && host
      ? ReactDOM.createPortal(
          <div
            style={{
              left: tip.x,
              top: tip.y - 8,
              transform: 'translate(-50%, -100%)',
            }}
            className="pointer-events-none fixed z-[1000] rounded-md border bg-popover px-2 py-1 font-sans text-[11px] text-popover-foreground shadow-md whitespace-nowrap"
          >
            {tip.content}
          </div>,
          host,
        )
      : null;

  return { tt, Portal };
}
