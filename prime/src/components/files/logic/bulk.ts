// BulkRun executes one single-item API call per selected entry with a
// concurrency cap. It is the only path multi-item operations take (trash,
// move, copy, paste, drag-drop, upload), so conflict handling and error
// reporting behave the same everywhere.
//
// Conflicts (HTTP 409 "destination exists") pause the run: no new item
// starts until the user answers Replace / Skip / Keep both. With "apply to
// remaining" the answer sticks for the rest of the run. Any other error
// fails that item only; the rest of the batch continues.

export type ConflictChoice = 'replace' | 'skip' | 'keepBoth';

export interface BulkItem {
  id: string;
  label: string;
}

export type ItemStatus = 'queued' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';

export interface ItemState {
  item: BulkItem;
  status: ItemStatus;
  error: string | null;
}

export interface RunOptions {
  overwrite: boolean;
  keepBoth: boolean;
}

export type BulkOp = (item: BulkItem, opts: RunOptions) => Promise<void>;

export interface BulkCallbacks {
  onConflict(item: BulkItem): Promise<{ choice: ConflictChoice; applyToAll: boolean }>;
  onUpdate(states: readonly ItemState[]): void;
}

export function isConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 409;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class BulkRun {
  private states: ItemState[];
  private next = 0;
  private cancelled = false;
  private sticky: ConflictChoice | null = null;
  private conflictChain: Promise<unknown> = Promise.resolve();
  private paused: Promise<void> = Promise.resolve();

  constructor(
    private readonly items: readonly BulkItem[],
    private readonly op: BulkOp,
    private readonly cb: BulkCallbacks,
    private readonly concurrency = 4,
  ) {
    this.states = items.map((item): ItemState => ({ item, status: 'queued', error: null }));
  }

  cancel(): void {
    this.cancelled = true;
  }

  async start(): Promise<ItemState[]> {
    const n = Math.min(this.concurrency, this.items.length);
    await Promise.all(Array.from({ length: n }, () => this.worker()));
    return this.snapshot();
  }

  private snapshot(): ItemState[] {
    return this.states.map((s) => ({ ...s }));
  }

  private set(i: number, status: ItemStatus, error: string | null = null): void {
    const cur = this.states[i];
    if (!cur) return;
    this.states[i] = { ...cur, status, error };
    this.cb.onUpdate(this.snapshot());
  }

  private async worker(): Promise<void> {
    for (;;) {
      await this.paused;
      const i = this.next++;
      if (i >= this.items.length) return;
      if (this.cancelled) {
        this.set(i, 'cancelled');
        continue;
      }
      this.set(i, 'running');
      await this.runOne(i);
    }
  }

  private async runOne(i: number): Promise<void> {
    const item = this.items[i]!;
    try {
      await this.op(item, { overwrite: false, keepBoth: false });
      this.set(i, 'done');
      return;
    } catch (err) {
      if (!isConflict(err)) {
        this.set(i, 'failed', message(err));
        return;
      }
    }
    const choice = await this.resolveConflict(item);
    if (choice === 'skip') {
      this.set(i, 'skipped');
      return;
    }
    try {
      await this.op(item, { overwrite: choice === 'replace', keepBoth: choice === 'keepBoth' });
      this.set(i, 'done');
    } catch (err) {
      this.set(i, 'failed', message(err));
    }
  }

  // Prompts are serialised: two workers hitting conflicts at once get two
  // dialogs one after the other, and the second sees a sticky answer if
  // the first chose "apply to remaining".
  private resolveConflict(item: BulkItem): Promise<ConflictChoice> {
    const ask = async (): Promise<ConflictChoice> => {
      if (this.sticky) return this.sticky;
      let release!: () => void;
      this.paused = new Promise<void>((r) => (release = r));
      try {
        const { choice, applyToAll } = await this.cb.onConflict(item);
        if (applyToAll) this.sticky = choice;
        return choice;
      } finally {
        release();
      }
    };
    const p = this.conflictChain.then(ask);
    this.conflictChain = p.catch(() => undefined);
    return p;
  }
}

export function summarize(states: readonly ItemState[]): Record<ItemStatus, number> {
  const out: Record<ItemStatus, number> = {
    queued: 0, running: 0, done: 0, skipped: 0, failed: 0, cancelled: 0,
  };
  for (const s of states) out[s.status]++;
  return out;
}

export function failedItems(states: readonly ItemState[]): BulkItem[] {
  return states.filter((s) => s.status === 'failed').map((s) => s.item);
}
