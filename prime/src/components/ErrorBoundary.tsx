import * as React from 'react';

interface Props {
  children: React.ReactNode;
  /** Optional label shown in the fallback, e.g. "the dashboard". */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Minimal class-component error boundary. Catches render-time exceptions in
 * the subtree so one throwing tab doesn't blank the whole shell. The fallback
 * is intentionally plain Tailwind to match the rest of the app and avoid
 * pulling in `react-error-boundary` (not in package.json).
 *
 * Production note: the error message is shown verbatim, the stack is not.
 * If you want stacks in dev only, gate on `import.meta.env.DEV`.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface to the console so it's visible in dev/devtools. No remote
    // reporter is wired up — that's a separate concern.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background px-6">
          <div className="max-w-md w-full rounded-md border bg-card p-6 space-y-4">
            <div className="font-mono text-[10px] uppercase tracking-wider text-destructive">
              {this.props.label ? `Error in ${this.props.label}` : 'Something went wrong'}
            </div>
            <div className="text-sm text-foreground break-words">
              {this.state.error.message || 'An unexpected error occurred.'}
            </div>
            <div className="text-[11px] text-muted-foreground font-mono">
              The rest of the app is unaffected. Retry to remount this section.
            </div>
            <button
              onClick={this.reset}
              className="rounded-md border bg-muted px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider hover:bg-muted/70 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
