import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button, Input } from '@/components/ui/primitives';
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, MenuIcon, RefreshIcon } from '@/components/ui/icons';
import { ancestorsOf, baseName } from './fsPath';
import type { ElProps } from './FileList';

interface AddressBarProps {
  path: string;
  canBack: boolean;
  canForward: boolean;
  onBack(): void;
  onForward(): void;
  onUp(): void;
  onRefresh(): void;
  onNavigate(path: string): void;
  validate(path: string): Promise<string | null>;
  editSignal: number;
  onToggleSidebar?: () => void;
  // Split view: the pane's server picker, rendered at the start of the bar.
  serverPicker?: React.ReactNode;
  refreshTitle?: string;
  // Toolbar controls sharing this row (they wrap below when the pane is narrow).
  children?: React.ReactNode;
  dropPropsFor?: (dir: string) => ElProps;
  dropTarget?: string | null;
}

function normalise(raw: string): string {
  let p = raw.trim();
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

// Breadcrumbs by default; click empty space in the bar (or Ctrl+L) to type
// a path. Enter validates by listing it; errors show inline.
export function AddressBar(p: AddressBarProps) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(p.path);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const pathRef = React.useRef(p.path);
  pathRef.current = p.path;
  // A path too long for the bar shows its end (where you are), not its start.
  const crumbsRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  });

  const startEdit = React.useCallback(() => {
    setText(pathRef.current);
    setErr(null);
    setEditing(true);
  }, []);

  React.useEffect(() => {
    if (p.editSignal > 0) startEdit();
  }, [p.editSignal, startEdit]);

  const submit = async () => {
    const next = normalise(text);
    setBusy(true);
    const problem = await p.validate(next);
    setBusy(false);
    if (problem) {
      setErr(problem);
      return;
    }
    setEditing(false);
    p.onNavigate(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b bg-muted/30 px-2 py-1">
      {p.serverPicker}
      {p.onToggleSidebar && (
        <Button size="xs" variant="ghost" className="md:hidden" onClick={p.onToggleSidebar} title="Folders">
          <MenuIcon size={12} />
        </Button>
      )}
      <Button size="xs" variant="ghost" disabled={!p.canBack} onClick={p.onBack} title="Back (Alt+←)">
        <ArrowLeftIcon size={12} />
      </Button>
      <Button size="xs" variant="ghost" disabled={!p.canForward} onClick={p.onForward} title="Forward (Alt+→)">
        <ArrowRightIcon size={12} />
      </Button>
      <Button size="xs" variant="ghost" disabled={p.path === '/'} onClick={p.onUp} title="Up (Backspace)">
        <ArrowUpIcon size={12} />
      </Button>
      {/* Path + refresh wrap as one unit, so refresh never ends up alone. */}
      <div className="flex min-w-[10rem] flex-1 basis-40 items-center gap-1">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="relative">
              <Input
                autoFocus
                value={text}
                // Read-only (not disabled) while checking, so focus stays and a
                // wrong path can be corrected or dismissed with Esc right away.
                readOnly={busy}
                onChange={(e) => {
                  setText(e.target.value);
                  setErr(null);
                }}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void submit();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditing(false);
                    setErr(null);
                  }
                }}
                onBlur={() => {
                  if (!busy) {
                    setEditing(false);
                    setErr(null);
                  }
                }}
                aria-invalid={err ? true : undefined}
                // Same box as the breadcrumbs (the shared Input is taller and
                // wider-padded), so focusing the bar doesn't resize the row.
                className={cn('!h-7 !rounded !px-1 !py-0 font-mono !text-xs', err && 'border-destructive')}
              />
              {/* Floats under the box instead of pushing the row taller. */}
              {err && (
                <div className="absolute left-0 top-full z-20 mt-0.5 rounded border bg-popover px-1.5 py-0.5 text-[10px] text-destructive shadow">
                  {err}
                </div>
              )}
            </div>
          ) : (
            <div
              ref={crumbsRef}
              className="flex h-7 min-w-0 cursor-text items-center overflow-hidden rounded border border-primary/40 px-1 font-mono text-xs hover:border-border"
              onClick={(e) => {
                if (e.target === e.currentTarget) startEdit();
              }}
              title="Click to type a path (Ctrl+L)"
            >
              {ancestorsOf(p.path).map((dir, i, all) => (
                <React.Fragment key={dir}>
                  {i > 1 && <span className="shrink-0 px-0.5 text-muted-foreground/50">/</span>}
                  <button
                    type="button"
                    {...(p.dropPropsFor?.(dir) ?? {})}
                    onClick={() => p.onNavigate(dir)}
                    className={cn(
                      'shrink-0 whitespace-nowrap rounded px-1 hover:bg-muted',
                      i === all.length - 1 && 'font-semibold',
                      p.dropTarget === dir && 'bg-primary/10 ring-1 ring-primary',
                    )}
                  >
                    {dir === '/' ? '/' : baseName(dir)}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
        <Button size="xs" variant="ghost" onClick={p.onRefresh} title={p.refreshTitle ?? 'Refresh (F5)'}>
          <RefreshIcon size={11} />
        </Button>
      </div>
      {p.children}
    </div>
  );
}
