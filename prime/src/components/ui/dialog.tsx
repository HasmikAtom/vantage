import * as React from 'react';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Dialog — accessible modal primitive.
//
// Wiring between <Dialog>, <DialogContent>, and <DialogTitle> happens through
// `DialogContext`. The Dialog generates a stable titleId via React.useId() and
// passes it to DialogContent (which sets `aria-labelledby={titleId}` on the
// dialog panel) and to DialogTitle (which sets `id={titleId}` on the heading).
// That way the title<->panel ARIA linkage is automatic — consumers only need
// to drop a <DialogTitle> somewhere inside.
// ---------------------------------------------------------------------------

interface DialogContextValue {
  titleId: string;
  onOpenChange: (open: boolean) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export const Dialog = ({ open, onOpenChange, children }: DialogProps) => {
  const titleId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <DialogContext.Provider value={{ titleId, onOpenChange }}>
      <div
        onClick={() => onOpenChange(false)}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
        style={{ animation: 'vantage-fadein .12s ease-out' }}
      >
        {React.Children.map(children, (child) => {
          if (!React.isValidElement(child)) return child;
          // Compose, don't clobber: preserve any onClick the consumer attached
          // to the child while still preventing backdrop-close when the click
          // originates inside the panel.
          const typed = child as React.ReactElement<{ onClick?: React.MouseEventHandler }>;
          const childOnClick = typed.props.onClick;
          return React.cloneElement(typed, {
            onClick: (e: React.MouseEvent) => {
              e.stopPropagation();
              childOnClick?.(e);
            },
          });
        })}
      </div>
    </DialogContext.Provider>
  );
};

// Focusable selector used by both initial-focus and the Tab trap. Mirrors the
// well-known "tabbable" list; we explicitly exclude tabindex=-1 so programmatic
// containers don't get treated as user-focusable.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  // Allow consumers to override the generated title-id linkage (e.g. when
  // the title lives outside the panel). Optional; the context default is used
  // when omitted.
  titleId?: string;
}

export const DialogContent = ({
  className,
  children,
  titleId: titleIdProp,
  ...props
}: DialogContentProps) => {
  const ctx = React.useContext(DialogContext);
  const titleId = titleIdProp ?? ctx?.titleId;
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Focus trap + save/restore previously-focused element.
  React.useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the panel on next frame so children have mounted and
    // any autoFocus inputs have rendered. We prefer the first focusable
    // element; if none exists we focus the panel itself (tabIndex=-1).
    const raf = requestAnimationFrame(() => {
      // If something inside the panel already grabbed focus (e.g. an input
      // with autoFocus), leave it alone — don't steal it.
      if (panel.contains(document.activeElement)) return;
      const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      const target = focusable[0] ?? panel;
      target.focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      // Defer restore by a tick — restoring during React's commit phase can
      // race with portals/animations and end up focusing <body>.
      setTimeout(() => {
        previouslyFocused?.focus?.();
      }, 0);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((el) => el.offsetParent !== null || el === panel);
    if (focusable.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const handleCloseClick = () => {
    ctx?.onOpenChange(false);
  };

  return (
    <div
      {...props}
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cn(
        'relative w-full max-w-lg max-h-[90vh] overflow-auto rounded-xl border bg-popover text-popover-foreground shadow-2xl focus:outline-none',
        className,
      )}
      style={{ animation: 'vantage-fadein .18s ease-out' }}
    >
      {ctx ? (
        <button
          type="button"
          aria-label="Close dialog"
          onClick={handleCloseClick}
          className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      ) : null}
      {children}
    </div>
  );
};

export const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 px-6 pt-6 pb-3', className)} {...props} />
);

export const DialogTitle = ({
  className,
  id: idProp,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) => {
  const ctx = React.useContext(DialogContext);
  const id = idProp ?? ctx?.titleId;
  return (
    <h3
      id={id}
      className={cn('text-lg font-semibold leading-tight', className)}
      {...props}
    />
  );
};

export const DialogDescription = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p
    className={cn(
      'text-xs uppercase tracking-wider text-muted-foreground font-mono',
      className,
    )}
    {...props}
  />
);

export const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex items-center justify-end gap-2 border-t px-6 py-3', className)}
    {...props}
  />
);
