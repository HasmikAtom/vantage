import * as React from 'react';
import {
  BulkRun,
  failedItems,
  type BulkItem,
  type BulkOp,
  type ConflictChoice,
  type ItemState,
} from '../logic/bulk';
import { BulkProgressDialog } from '../dialogs/BulkProgressDialog';
import { ConflictDialog } from '../dialogs/ConflictDialog';

export interface RunBulkOptions {
  concurrency?: number;
  // Called when the user presses Cancel (in addition to stopping new items),
  // e.g. to cancel gate transfers that are already running.
  onCancel?: () => void;
}

export type RunBulk = (title: string, items: BulkItem[], op: BulkOp, opts?: RunBulkOptions) => Promise<ItemState[]>;
export type AskConflict = (item: BulkItem) => Promise<{ choice: ConflictChoice; applyToAll: boolean }>;

interface ViewState {
  title: string;
  states: ItemState[];
  finished: boolean;
  visible: boolean;
  op: BulkOp;
  opts: RunBulkOptions;
}

interface PendingConflict {
  item: BulkItem;
  resolve: (r: { choice: ConflictChoice; applyToAll: boolean }) => void;
}

// useBulkRunner owns the progress + conflict dialogs for multi-item work.
// The progress dialog appears only for > 5 items or runs longer than 1s,
// and stays open at the end only when something failed or it was already
// showing. askConflict exposes the same conflict dialog to callers that
// resolve conflicts before a run (cross-server transfers).
export function useBulkRunner(onRetried: () => void): {
  runBulk: RunBulk;
  askConflict: AskConflict;
  dialogs: React.ReactNode;
} {
  const [view, setView] = React.useState<ViewState | null>(null);
  const [conflict, setConflict] = React.useState<PendingConflict | null>(null);
  const runRef = React.useRef<BulkRun | null>(null);
  const cancelHook = React.useRef<(() => void) | null>(null);

  const askConflict = React.useCallback<AskConflict>(
    (item) => new Promise((resolve) => setConflict({ item, resolve })),
    [],
  );

  const runBulk = React.useCallback<RunBulk>(
    async (title, items, op, opts = {}) => {
      if (items.length === 0) return [];
      const run = new BulkRun(
        items,
        op,
        {
          onUpdate: (states) => setView((v) => (v ? { ...v, states: [...states] } : v)),
          onConflict: askConflict,
        },
        opts.concurrency ?? 4,
      );
      runRef.current = run;
      cancelHook.current = opts.onCancel ?? null;
      setView({
        title,
        states: items.map((item): ItemState => ({ item, status: 'queued', error: null })),
        finished: false,
        visible: items.length > 5,
        op,
        opts,
      });
      const timer = window.setTimeout(() => setView((v) => (v ? { ...v, visible: true } : v)), 1000);
      const final = await run.start();
      window.clearTimeout(timer);
      runRef.current = null;
      cancelHook.current = null;
      const failed = final.some((s) => s.status === 'failed');
      setView((v) => {
        if (!v) return v;
        if (!v.visible && !failed) return null;
        return { ...v, states: final, finished: true, visible: true };
      });
      return final;
    },
    [askConflict],
  );

  const cancel = React.useCallback(() => {
    runRef.current?.cancel();
    cancelHook.current?.();
  }, []);

  const retry = React.useCallback(async () => {
    if (!view) return;
    const { title, op, states, opts } = view;
    setView(null);
    await runBulk(`${title} (retry)`, failedItems(states), op, opts);
    onRetried();
  }, [view, runBulk, onRetried]);

  const dialogs = (
    <>
      {view?.visible && (
        <BulkProgressDialog
          title={view.title}
          states={view.states}
          finished={view.finished}
          onCancel={cancel}
          onRetry={() => void retry()}
          onClose={() => setView(null)}
        />
      )}
      {conflict && (
        <ConflictDialog
          item={conflict.item}
          onAnswer={(choice, applyToAll) => {
            conflict.resolve({ choice, applyToAll });
            setConflict(null);
          }}
          onCancelAll={() => {
            cancel();
            conflict.resolve({ choice: 'skip', applyToAll: true });
            setConflict(null);
          }}
        />
      )}
    </>
  );

  return { runBulk, askConflict, dialogs };
}
