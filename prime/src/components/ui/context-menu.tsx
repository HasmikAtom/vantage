import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

// ContextMenu — a positioned, keyboard-navigable menu rendered in a portal.
// Clamped to the viewport; closes on outside click, scroll, resize, window
// blur, Esc, or after an item runs. Disabled items stay visible and keep
// their tooltip (aria-disabled rather than the disabled attribute, which
// suppresses hover tooltips in some browsers).

export type MenuEntry =
  | {
      kind: 'item';
      label: string;
      onSelect: () => void;
      disabled?: boolean;
      title?: string;
      danger?: boolean;
      shortcut?: string;
      icon?: React.ReactNode;
    }
  | { kind: 'separator' };

export interface ContextMenuProps {
  x: number;
  y: number;
  items: readonly MenuEntry[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState({ left: x, top: y });
  const [active, setActive] = React.useState(-1);

  const enabled = React.useMemo(
    () => items.flatMap((it, i) => (it.kind === 'item' && !it.disabled ? [i] : [])),
    [items],
  );

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
    el.focus();
  }, [x, y]);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  const run = (i: number) => {
    const it = items[i];
    if (!it || it.kind !== 'item' || it.disabled) return;
    onClose();
    it.onSelect();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Portal events bubble through the React tree; keep them away from the
    // explorer's own shortcut handler.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (enabled.length === 0) return;
      const at = enabled.indexOf(active);
      const next =
        e.key === 'ArrowDown'
          ? enabled[(at + 1) % enabled.length]
          : enabled[(at - 1 + enabled.length) % enabled.length];
      setActive(next ?? -1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(active);
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-[210px] rounded-md border bg-popover p-1 text-xs text-popover-foreground shadow-lg outline-none"
    >
      {items.map((it, i) =>
        it.kind === 'separator' ? (
          <div key={i} className="my-1 h-px bg-border" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            aria-disabled={it.disabled || undefined}
            title={it.title}
            onMouseEnter={() => setActive(i)}
            onClick={() => run(i)}
            className={cn(
              'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left',
              it.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted',
              i === active && !it.disabled && 'bg-muted',
              it.danger && !it.disabled && 'text-destructive',
            )}
          >
            <span className="flex w-3.5 shrink-0 justify-center">{it.icon}</span>
            <span className="flex-1">{it.label}</span>
            {it.shortcut && <span className="text-[10px] text-muted-foreground/70">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
