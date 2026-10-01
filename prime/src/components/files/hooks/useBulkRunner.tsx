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
  // Runs after every pass, including a "Retry failed" pass, so callers can
  // finish work that depends on the outcome (e.g. deleting moved sources).
  onSettled?: (states: ItemState[]) => void | Promise<void>;
  // The caller already holds the operation slot (see claim()).
  claimed?: boolean;
}

export type RunBulk = (title: string, items: BulkItem[], op: BulkOp, opts?: RunBulkOptions) => Promise<ItemState[]>;
// cancelled: the user chose "Cancel all" (or closed the dialog).
export type AskConflict = (item: BulkItem) => Promise<{ choice: ConflictChoice; applyToAll: boolean; cancelled?: boolean }>;

interface ViewState {
  title: string;
  states: ItemState[];
  finished: boolean;
  // Items are done; onSettled (e.g. trashing moved sources) is running and
  // can no longer be cancelled.
  settling: boolean;
  visible: boolean;
  op: BulkOp;
  opts: RunBulkOptions;
}

interface PendingConflict {
  item: BulkItem;
  resolve: (r: { choice: ConflictChoice; applyToAll: boolean; cancelled?: boolean }) => void;
}

// useBulkRunner owns the progress + conflict dialogs for multi-item work.
// The progress dialog appears only for > 5 items or runs longer than 1s,
// and stays open at the end only when something failed or it was already
// showing. askConflict exposes the same conflict dialog to callers that
// resolve conflicts before a run (cross-server transfers).
// One operation at a time: from a run's start until its progress dialog is
// gone (including a finished dialog that still offers "Retry failed"), a
// new runBulk is refused — its items come back 'cancelled' and onBusy runs.
export function useBulkRunner(
  onRetried: () => void,
  onBusy?: () => void,
  // A "Retry failed" pass that crashes; first passes report through their caller.
  onError?: (message: string) => void,
): {
  runBulk: RunBulk;
  askConflict: AskConflict;
  // Hold the one-operation slot across a longer job (a cross-server copy
  // scans and prompts before its runBulk); runBulk({claimed:true}) takes it
  // over, release() gives it back if the job stops before that.
  claim: () => boolean;
  release: () => void;
  dialogs: React.ReactNode;
} {
  const [view, setView] = React.useState<ViewState | null>(null);
  const [conflict, setConflict] = React.useState<PendingConflict | null>(null);
  const runRef = React.useRef<BulkRun | null>(null);
  const cancelHook = React.useRef<(() => void) | null>(null);
  const pending = React.useRef<PendingConflict | null>(null);
  const mounted = React.useRef(true);
  const busy = React.useRef(false);
  const shown = React.useRef(false);
  const onBusyRef = React.useRef(onBusy);
  onBusyRef.current = onBusy;
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;
  const claim = React.useCallback(() => {
    if (busy.current || !mounted.current) return false;
    busy.current = true;
    return true;
  }, []);
  const release = React.useCallback(() => {
    busy.current = false;
  }, []);

  const askConflict = React.useCallback<AskConflict>(
    (item) =>
      new Promise((resolve) => {
        // Nobody can answer once the explorer is gone (e.g. the user switched
        // dashboard tab mid-scan): treat it as "Cancel all".
        if (!mounted.current) {
          resolve({ choice: 'skip', applyToAll: true, cancelled: true });
          return;
        }
        const p = { item, resolve };
        pending.current = p;
        setConflict(p);
      }),
    [],
  );

  // Leaving the explorer cancels the run and answers any open prompt, so a
  // cross-server run can finish and release its one-at-a-time guard.
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runRef.current?.cancel();
      cancelHook.current?.();
      pending.current?.resolve({ choice: 'skip', applyToAll: true, cancelled: true });
      pending.current = null;
    };
  }, []);

  const runBulk = React.useCallback<RunBulk>(
    async (title, items, op, opts = {}) => {
      // Nothing would show or control a run started after the explorer
      // closed (e.g. a cross-server copy still preparing when the user
      // switched tab).
      if (!mounted.current) {
        return items.map((item): ItemState => ({ item, status: 'cancelled', error: null }));
      }
      if (busy.current && !opts.claimed) {
        onBusyRef.current?.();
        return items.map((item): ItemState => ({ item, status: 'cancelled', error: null }));
      }
      if (items.length === 0) {
        try {
          await opts.onSettled?.([]);
        } finally {
          if (opts.claimed) busy.current = false;
        }
        return [];
      }
      busy.current = true;
      let timer: number | undefined;
      try {
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
          settling: false,
          visible: items.length > 5,
          op,
          opts,
        });
        shown.current = items.length > 5;
        // Also covers a slow onSettled, so a quick move whose clean-up drags
        // on still gets a dialog.
        timer = window.setTimeout(() => {
          shown.current = true;
          setView((v) => (v ? { ...v, visible: true } : v));
        }, 1000);
        const final = await run.start();
        runRef.current = null;
        cancelHook.current = null;
        if (opts.onSettled) {
          setView((v) => (v ? { ...v, states: final, settling: true } : v));
          await opts.onSettled(final);
        }
        window.clearTimeout(timer);
        const failed = final.some((s) => s.status === 'failed');
        // A quick clean run never showed a dialog: free right away. Otherwise
        // the finished dialog (and its Retry) holds the slot until closed.
        if (!shown.current && !failed) {
          busy.current = false;
          setView(null);
        } else {
          shown.current = true;
          setView((v) => (v ? { ...v, states: final, finished: true, settling: false, visible: true } : v));
        }
        return final;
      } catch (e) {
        // A crash must not leave every later operation refused.
        busy.current = false;
        shown.current = false;
        setView(null);
        throw e;
      } finally {
        window.clearTimeout(timer);
        runRef.current = null;
        cancelHook.current = null;
      }
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
    busy.current = false;
    try {
      await runBulk(`${title} (retry)`, failedItems(states), op, opts);
    } catch (e) {
      onErrorRef.current?.(e instanceof Error ? e.message : String(e));
    }
    onRetried();
  }, [view, runBulk, onRetried]);

  const dialogs = (
    <>
      {view?.visible && (
        <BulkProgressDialog
          title={view.title}
          states={view.states}
          finished={view.finished}
          settling={view.settling}
          onCancel={cancel}
          onRetry={() => void retry()}
          onClose={() => {
            busy.current = false;
            setView(null);
          }}
        />
      )}
      {conflict && (
        <ConflictDialog
          item={conflict.item}
          onAnswer={(choice, applyToAll) => {
            conflict.resolve({ choice, applyToAll });
            pending.current = null;
            setConflict(null);
          }}
          onCancelAll={() => {
            cancel();
            conflict.resolve({ choice: 'skip', applyToAll: true, cancelled: true });
            pending.current = null;
            setConflict(null);
          }}
        />
      )}
    </>
  );

  return { runBulk, askConflict, claim, release, dialogs };
}
