import { describe, expect, it } from 'vitest';
import { BulkRun, failedItems, isConflict, summarize, type BulkCallbacks, type BulkItem, type RunOptions } from './bulk';

const items = (n: number): BulkItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `item ${i}` }));

const httpError = (status: number, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { status });

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const noConflict: BulkCallbacks = {
  onConflict: () => Promise.reject(new Error('unexpected conflict')),
  onUpdate: () => {},
};

describe('BulkRun', () => {
  it('runs every item with at most 4 in flight', async () => {
    let active = 0;
    let peak = 0;
    const run = new BulkRun(items(10), async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    }, noConflict);
    const final = await run.start();
    expect(peak).toBe(4);
    expect(summarize(final).done).toBe(10);
  });

  it('continues after a 404 or other error and reports that item only', async () => {
    const run = new BulkRun(items(4), async (item) => {
      if (item.id === 'i1') throw httpError(404, 'no such file');
      if (item.id === 'i2') throw new Error('boom');
    }, noConflict);
    const final = await run.start();
    expect(final.map((s) => s.status)).toEqual(['done', 'failed', 'failed', 'done']);
    expect(final[1]?.error).toBe('no such file');
    expect(failedItems(final).map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it('asks on conflict and re-runs with overwrite for Replace', async () => {
    const calls: RunOptions[] = [];
    const run = new BulkRun(items(1), async (_item, opts) => {
      calls.push(opts);
      if (!opts.overwrite) throw httpError(409);
    }, {
      onConflict: async () => ({ choice: 'replace', applyToAll: false }),
      onUpdate: () => {},
    });
    const final = await run.start();
    expect(calls).toEqual([
      { overwrite: false, keepBoth: false },
      { overwrite: true, keepBoth: false },
    ]);
    expect(final[0]?.status).toBe('done');
  });

  it('passes keepBoth through for Keep both', async () => {
    const calls: RunOptions[] = [];
    const run = new BulkRun(items(1), async (_item, opts) => {
      calls.push(opts);
      if (!opts.keepBoth) throw httpError(409);
    }, {
      onConflict: async () => ({ choice: 'keepBoth', applyToAll: false }),
      onUpdate: () => {},
    });
    await run.start();
    expect(calls[1]).toEqual({ overwrite: false, keepBoth: true });
  });

  it('applies a sticky choice without asking again', async () => {
    let asked = 0;
    const run = new BulkRun(items(3), async (_item, opts) => {
      if (!opts.overwrite) throw httpError(409);
    }, {
      onConflict: async () => {
        asked++;
        return { choice: 'skip', applyToAll: true };
      },
      onUpdate: () => {},
    });
    const final = await run.start();
    expect(asked).toBe(1);
    expect(summarize(final).skipped).toBe(3);
  });

  it('does not start new items while a conflict prompt is open', async () => {
    const slow = deferred();
    const answer = deferred<{ choice: 'skip'; applyToAll: boolean }>();
    const started: string[] = [];
    const run = new BulkRun(items(3), async (item) => {
      started.push(item.id);
      if (item.id === 'i0') throw httpError(409);
      if (item.id === 'i1') await slow.promise;
    }, { onConflict: () => answer.promise, onUpdate: () => {} }, 2);
    const done = run.start();
    await new Promise((r) => setTimeout(r, 10));
    slow.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(['i0', 'i1']);
    answer.resolve({ choice: 'skip', applyToAll: false });
    await done;
    expect(started).toEqual(['i0', 'i1', 'i2']);
  });

  it('cancel marks items that have not started as cancelled', async () => {
    const gate = deferred();
    const run = new BulkRun(items(4), async () => {
      await gate.promise;
    }, noConflict, 1);
    const done = run.start();
    await new Promise((r) => setTimeout(r, 5));
    run.cancel();
    gate.resolve();
    const final = await done;
    expect(final.map((s) => s.status)).toEqual(['done', 'cancelled', 'cancelled', 'cancelled']);
  });

  it('reports progress through onUpdate', async () => {
    const seen: string[] = [];
    await new BulkRun(items(1), async () => {}, {
      onConflict: noConflict.onConflict,
      onUpdate: (s) => seen.push(s[0]!.status),
    }).start();
    expect(seen).toEqual(['running', 'done']);
  });

  it('handles an empty batch', async () => {
    expect(await new BulkRun([], async () => {}, noConflict).start()).toEqual([]);
  });
});

describe('isConflict', () => {
  it('matches only HTTP 409', () => {
    expect(isConflict(httpError(409))).toBe(true);
    expect(isConflict(httpError(404))).toBe(false);
    expect(isConflict('409')).toBe(false);
    expect(isConflict(null)).toBe(false);
  });
});
