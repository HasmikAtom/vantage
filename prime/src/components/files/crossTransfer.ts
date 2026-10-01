import type { FsEntry, FsEntryType } from '@/types';
import { cancelTransfer, createTransfer, fetchTransferStatus, fsDelete, fsList, fsMkdir, fsStat } from '@/api';
import { baseName, copyName, formatBytes, joinPath, parentOf } from './fsPath';
import { fetchListing } from './hooks/useDirListing';
import type { AskConflict, RunBulk } from './hooks/useBulkRunner';
import { isConflict, type ConflictChoice } from './logic/bulk';
import {
  CROSS_CONFIRM_FILES,
  TooManyFilesError,
  planCrossTransfer,
  topsToDelete,
  type CrossPlan,
  type CrossSource,
} from './logic/crossPlan';
import { joinRel } from './logic/upload';
import { pollTransfer } from './transferWatch';

// Copies or moves files and folders from one server to another through
// gate's existing single-file transfer API. Folders are walked in the
// browser, recreated on the destination, and each file is one transfer.
// A move deletes a top-level source (to that server's trash) only after
// every file under it arrived and nothing under it had to be skipped.

export interface CrossApi {
  list(serverId: string, path: string): Promise<FsEntry[]>;
  existing(serverId: string, dir: string): Promise<Map<string, FsEntryType>>;
  mkdir(serverId: string, path: string): Promise<void>;
  startTransfer(req: { srcServer: string; srcPath: string; dstServer: string; dstPath: string; overwrite: boolean }): Promise<string>;
  awaitTransfer(id: string): Promise<void>;
  cancelTransfer(id: string): Promise<void>;
  trash(serverId: string, path: string): Promise<void>;
  // Size of a destination file, or null if it doesn't exist; used when gate
  // no longer knows a transfer (restart, or finished long ago).
  stat?: (serverId: string, path: string) => Promise<{ size: number } | null>;
}

export const defaultCrossApi: CrossApi = {
  list: async (serverId, path) => (await fsList(serverId, path)).entries,
  existing: async (serverId, dir) => {
    const l = await fetchListing(serverId, dir, true);
    return new Map(l.entries.map((e) => [e.name, e.type]));
  },
  mkdir: (serverId, path) => fsMkdir(serverId, path),
  startTransfer: async (req) => (await createTransfer({ ...req, mode: 'copy' })).id,
  awaitTransfer: (id) => pollTransfer(id, fetchTransferStatus),
  cancelTransfer: (id) => cancelTransfer(id),
  trash: (serverId, path) => fsDelete(serverId, path),
  stat: async (serverId, path) => {
    try {
      const e = await fsStat(serverId, path);
      return e.type === 'file' ? { size: e.size } : null;
    } catch {
      return null;
    }
  },
};

export interface CrossDeps {
  api: CrossApi;
  runBulk: RunBulk;
  askConflict: AskConflict;
  confirm(message: string): boolean;
  // One call per run with every problem joined, so nothing is overwritten.
  onError(message: string): void;
  // Progress while source folders are scanned; null when scanning is over.
  onStatus?: (message: string | null) => void;
  // Sources that were moved (copied and then trashed at the source),
  // reported after each pass including retries.
  onMoved?: (serverId: string, paths: string[]) => void;
  // The one-operation slot (useBulkRunner.claim/release): held for the
  // whole run so a local operation can't start mid-scan or mid-prompt.
  claim?: () => boolean;
  release?: () => void;
  // Aborting cancels the run while it is still scanning/preparing.
  signal?: AbortSignal;
  // The run was accepted (not refused as a second run or a busy slot), so
  // the caller can wire its Cancel to this run's signal.
  onStart?: () => void;
  afterMutation(serverId: string, dirs: readonly string[]): Promise<void>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

class CancelledScan extends Error {}

async function mkdirOk(api: CrossApi, serverId: string, path: string): Promise<void> {
  try {
    await api.mkdir(serverId, path);
  } catch (e) {
    if (!isConflict(e)) throw e;
  }
}

// One cross-server run at a time: a second F5/F6/drop while the first is
// still scanning or copying would fight over the progress dialog.
let active = false;

export async function runCrossTransfer(
  d: CrossDeps,
  src: { serverId: string; items: readonly CrossSource[] },
  dst: { serverId: string; dir: string; label?: string },
  mode: 'copy' | 'move',
): Promise<string[]> {
  if (active) {
    d.onError('Another cross-server copy is already running — wait for it to finish.');
    return [];
  }
  if (d.claim && !d.claim()) {
    d.onError('Finish or close the current operation first.');
    return [];
  }
  active = true;
  const ctx = { handedOff: false };
  try {
    d.onStart?.();
    return await crossRun(d, src, dst, mode, ctx);
  } finally {
    active = false;
    d.onStatus?.(null);
    // runBulk took the slot over (it frees it when its dialog closes);
    // otherwise the run stopped early and gives it back here.
    if (!ctx.handedOff) d.release?.();
  }
}

async function crossRun(
  d: CrossDeps,
  src: { serverId: string; items: readonly CrossSource[] },
  dst: { serverId: string; dir: string; label?: string },
  mode: 'copy' | 'move',
  ctx: { handedOff: boolean },
): Promise<string[]> {
  const verb = mode === 'copy' ? 'Copy' : 'Move';
  const notes: string[] = [];
  const flush = () => {
    if (notes.length > 0) d.onError(notes.join(' · '));
    notes.length = 0;
  };

  const cancelledNote = `${verb} cancelled — nothing was changed.`;
  const isCancelled = () => d.signal?.aborted === true;

  let plan: CrossPlan;
  d.onStatus?.('Scanning folders…');
  try {
    plan = await planCrossTransfer(
      src.items,
      (p) => {
        if (isCancelled()) throw new CancelledScan();
        return d.api.list(src.serverId, p);
      },
      undefined,
      (n) => d.onStatus?.(`Scanning folders… ${n} ${n === 1 ? 'folder' : 'folders'}`),
    );
  } catch (e) {
    if (e instanceof CancelledScan) d.onError(cancelledNote);
    else d.onError(e instanceof TooManyFilesError ? e.message : `Could not read the source folders: ${msg(e)}`);
    return [];
  }
  d.onStatus?.(null);
  if (isCancelled()) {
    d.onError(cancelledNote);
    return [];
  }
  if (
    plan.files.length > CROSS_CONFIRM_FILES &&
    !d.confirm(`${verb} ${plan.files.length.toLocaleString('en-US')} files (${formatBytes(plan.totalBytes)}) to ${dst.label ?? 'another server'}?`)
  ) {
    return [];
  }

  // Top-level name conflicts at the destination. If the destination can't
  // be listed, stop: copying blind would merge into folders unasked.
  let existing: Map<string, FsEntryType>;
  try {
    existing = await d.api.existing(dst.serverId, dst.dir);
  } catch (e) {
    d.onError(`Could not read the destination folder: ${msg(e)}`);
    return [];
  }
  const taken = new Set(existing.keys());
  const target = new Map<string, { name: string; overwrite: boolean }>();
  const kept = new Set<string>();
  // Tops the user chose to Skip (kept on purpose, not because of a failure).
  const userSkipped = new Set<string>();
  let sticky: ConflictChoice | null = null;
  for (const t of plan.tops) {
    const there = existing.get(t.name);
    if (there === undefined) {
      target.set(t.path, { name: t.name, overwrite: false });
      taken.add(t.name);
      continue;
    }
    let choice = sticky;
    if (!choice) {
      const a = await d.askConflict({ id: t.path, label: t.name });
      if (a.cancelled) {
        d.onError(cancelledNote);
        return [];
      }
      choice = a.choice;
      if (a.applyToAll) sticky = a.choice;
    }
    if (choice === 'skip') {
      kept.add(t.path);
      userSkipped.add(t.path);
    } else if (choice === 'replace') {
      if (t.isDir || there === 'dir') {
        notes.push(`${t.name}: folders can't be replaced — choose Keep both or Skip`);
        kept.add(t.path);
      } else {
        target.set(t.path, { name: t.name, overwrite: true });
      }
    } else {
      const name = copyName(t.name, t.isDir, taken);
      taken.add(name);
      target.set(t.path, { name, overwrite: false });
    }
  }

  if (isCancelled()) {
    d.onError(cancelledNote);
    return [];
  }

  // Recreate folders, parents first. Cancel is still honoured here; some
  // folders may exist by then, so the message says so.
  const partlyCancelled = `${verb} cancelled — some folders may already have been created.`;
  d.onStatus?.('Creating folders…');
  for (const t of plan.tops) {
    const tgt = target.get(t.path);
    if (!tgt || !t.isDir) continue;
    const root = joinPath(dst.dir, tgt.name);
    try {
      for (const rel of ['', ...t.dirs]) {
        if (isCancelled()) {
          d.onError(partlyCancelled);
          return [];
        }
        await mkdirOk(d.api, dst.serverId, joinRel(root, rel));
      }
    } catch (e) {
      notes.push(`Could not create ${tgt.name} on the destination: ${msg(e)}`);
      target.delete(t.path);
      kept.add(t.path);
    }
  }

  // Finishing step: runs after the first pass and again after every
  // "Retry failed", so a retried move still removes its sources.
  const done = new Set<string>();
  const trashed = new Set<string>();
  let pass = 0;
  const settle = async () => {
    pass++;
    if (pass === 1 && plan.skipped.length > 0) {
      notes.push(
        `${plan.skipped.length} link(s) or special file(s) skipped: ${plan.skipped.slice(0, 3).map(baseName).join(', ')}${plan.skipped.length > 3 ? '…' : ''}`,
      );
    }
    const movedNow: string[] = [];
    if (mode === 'move') {
      for (const p of topsToDelete(plan, done, kept)) {
        if (trashed.has(p)) continue;
        try {
          await d.api.trash(src.serverId, p);
          trashed.add(p);
          movedNow.push(p);
        } catch (e) {
          notes.push(`Copied, but could not remove ${baseName(p)} from the source: ${msg(e)}`);
        }
      }
      const keptCount = plan.tops.length - trashed.size - userSkipped.size;
      if (pass > 1 && keptCount === 0 && movedNow.length > 0 && notes.length === 0) {
        // Replaces the "kept at the source" message from the first pass.
        notes.push('All items moved.');
      }
      if (pass === 1 && userSkipped.size > 0) {
        notes.push(`${userSkipped.size} skipped (you chose Skip)`);
      }
      if (keptCount > 0) {
        notes.push(`${keptCount} ${keptCount === 1 ? 'item was' : 'items were'} kept at the source because not everything was copied`);
      }
    }
    // A failed refresh only means a stale listing; it must not swallow the
    // clipboard update or this pass's messages.
    try {
      if (mode === 'move') await d.afterMutation(src.serverId, [...new Set(plan.tops.map((t) => parentOf(t.path)))]);
      await d.afterMutation(dst.serverId, [dst.dir]);
    } catch (e) {
      notes.push(`Could not refresh the listing: ${msg(e)}`);
    }
    if (movedNow.length > 0) d.onMoved?.(src.serverId, movedNow);
    flush();
  };

  d.onStatus?.(null);
  if (isCancelled()) {
    d.onError(partlyCancelled);
    return [];
  }

  // One transfer per file, two at a time.
  const files = plan.files.filter((f) => target.has(f.top));
  const byId = new Map(files.map((f) => [f.srcPath, f]));
  const running = new Set<string>();
  ctx.handedOff = true;
  await d.runBulk(
    `${mode === 'copy' ? 'Copying' : 'Moving'} ${files.length} ${files.length === 1 ? 'file' : 'files'} to another server`,
    files.map((f) => ({ id: f.srcPath, label: f.rel ? `${baseName(f.top)}/${f.rel}` : baseName(f.top) })),
    async (item) => {
      const f = byId.get(item.id)!;
      const tgt = target.get(f.top)!;
      const top = joinPath(dst.dir, tgt.name);
      const id = await d.api.startTransfer({
        srcServer: src.serverId,
        srcPath: f.srcPath,
        dstServer: dst.serverId,
        dstPath: f.rel ? joinRel(top, f.rel) : top,
        overwrite: tgt.overwrite,
      });
      running.add(id);
      try {
        try {
          await d.api.awaitTransfer(id);
        } catch (e) {
          // Gate forgot the transfer (restart, or the tab slept past its
          // retention): trust the destination if the file is complete.
          const forgotten = typeof e === 'object' && e !== null && (e as { unknownTransfer?: unknown }).unknownTransfer === true;
          // Only when nothing was at that path before: after Replace an old
          // same-size file would look exactly like a finished copy.
          const there =
            forgotten && !tgt.overwrite && d.api.stat
              ? await d.api.stat(dst.serverId, f.rel ? joinRel(top, f.rel) : top)
              : null;
          if (!there || there.size !== f.size) throw e;
        }
        done.add(item.id);
      } finally {
        running.delete(id);
      }
    },
    {
      claimed: true,
      concurrency: 2,
      onCancel: () => {
        for (const id of running) void d.api.cancelTransfer(id).catch(() => {});
      },
      onSettled: settle,
    },
  );
  return [...trashed];
}
