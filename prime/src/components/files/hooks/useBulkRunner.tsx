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

export type RunBulk = (title: string, items: BulkItem[], op: BulkOp) => Promise<ItemState[]>;

interface ViewState {
  title: string;
  states: ItemState[];
  finished: boolean;
  visible: boolean;
  op: BulkOp;
}

interface PendingConflict {
  item: BulkItem;
  resolve: (r: { choice: ConflictChoice; applyToAll: boolean }) => void;
}

// useBulkRunner owns the progress + conflict dialogs for multi-item work.
// The progress dialog appears only for > 5 items or runs longer than 1s,
// and stays open at the end only when something failed or it was already
// showing.
export function useBulkRunner(onRetried: () => void): { runBulk: RunBulk; dialogs: React.ReactNode } {
  const [view, setView] = React.useState<ViewState | null>(null);
  const [conflict, setConflict] = React.useState<PendingConflict | null>(null);
  const runRef = React.useRef<BulkRun | null>(null);

  const runBulk = React.useCallback<RunBulk>(async (title, items, op) => {
    if (items.length === 0) return [];
    const run = new BulkRun(items, op, {
      onUpdate: (states) => setView((v) => (v ? { ...v, states: [...states] } : v)),
      onConflict: (item) => new Promise((resolve) => setConflict({ item, resolve })),
    });
    runRef.current = run;
    setView({
      title,
      states: items.map((item): ItemState => ({ item, status: 'queued', error: null })),
      finished: false,
      visible: items.length > 5,
      op,
    });
    const timer = window.setTimeout(() => setView((v) => (v ? { ...v, visible: true } : v)), 1000);
    const final = await run.start();
    window.clearTimeout(timer);
    runRef.current = null;
    const failed = final.some((s) => s.status === 'failed');
    setView((v) => {
      if (!v) return v;
      if (!v.visible && !failed) return null;
      return { ...v, states: final, finished: true, visible: true };
    });
    return final;
  }, []);

  const retry = React.useCallback(async () => {
    if (!view) return;
    const { title, op, states } = view;
    setView(null);
    await runBulk(`${title} (retry)`, failedItems(states), op);
    onRetried();
  }, [view, runBulk, onRetried]);

  const dialogs = (
    <>
      {view?.visible && (
        <BulkProgressDialog
          title={view.title}
          states={view.states}
          finished={view.finished}
          onCancel={() => runRef.current?.cancel()}
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
            runRef.current?.cancel();
            conflict.resolve({ choice: 'skip', applyToAll: true });
            setConflict(null);
          }}
        />
      )}
    </>
  );

  return { runBulk, dialogs };
}
