import * as React from 'react';
import type { FsEntry } from '@/types';
import {
  fsCopy,
  fsDelete,
  fsDownloadURL,
  fsMkdir,
  fsMove,
  fsRename,
  fsUpload,
  fsWrite,
} from '@/api';
import { baseName, copyName, joinPath, parentOf } from './fsPath';
import { fetchListing } from './hooks/useDirListing';
import type { RunBulk } from './hooks/useBulkRunner';
import { isConflict } from './logic/bulk';
import { preflightConflict } from './logic/conflicts';
import { clipboardStore, planPaste, type FsClipboard } from './logic/clipboard';
import { canDropInto } from './logic/dnd';
import { joinRel, type UploadPlan } from './logic/upload';

export interface FileActionsDeps {
  serverId: string;
  runBulk: RunBulk;
  afterMutation: (dirs: readonly string[]) => Promise<void>;
  onError: (msg: string) => void;
}

export interface MoveSource {
  path: string;
  isDir: boolean;
}

export interface FileActions {
  trash(entries: readonly FsEntry[]): Promise<void>;
  transfer(sources: readonly MoveSource[], targetDir: string, mode: 'copy' | 'move'): Promise<void>;
  paste(clip: FsClipboard, targetDir: string): Promise<void>;
  upload(plan: UploadPlan, targetDir: string): Promise<void>;
  download(entries: readonly FsEntry[]): void;
  create(parent: string, name: string, what: 'folder' | 'file'): Promise<void>;
  rename(entry: FsEntry, newName: string): Promise<void>;
  copyOrMoveTo(entry: FsEntry, dst: string, mode: 'copy' | 'move', overwrite: boolean): Promise<void>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function existingEntries(serverId: string, dir: string): Promise<Map<string, FsEntry['type']>> {
  try {
    const l = await fetchListing(serverId, dir, true);
    return new Map(l.entries.map((e) => [e.name, e.type]));
  } catch {
    return new Map();
  }
}

async function takenNames(serverId: string, dir: string): Promise<Set<string>> {
  return new Set((await existingEntries(serverId, dir)).keys());
}

export function createFileActions(d: FileActionsDeps): FileActions {
  const { serverId, runBulk, afterMutation, onError } = d;

  const localOps = async (
    title: string,
    ops: readonly { from: string; to: string; isDir: boolean; mode: 'copy' | 'move' }[],
    targetDir: string,
  ) => {
    const existing = await existingEntries(serverId, targetDir);
    const taken = new Set(existing.keys());
    const byId = new Map(ops.map((o) => [o.from, o]));
    await runBulk(
      title,
      ops.map((o) => ({ id: o.from, label: baseName(o.from) })),
      async (item, opts) => {
        const o = byId.get(item.id)!;
        const pre = preflightConflict(o.isDir, existing.get(baseName(o.to)), opts);
        if (pre === 'conflict') throw Object.assign(new Error('destination exists'), { status: 409 });
        if (pre === 'cannot-replace-folder') throw new Error("Folders can't be replaced — choose Keep both or Skip");
        let to = o.to;
        if (opts.keepBoth) {
          const name = copyName(baseName(o.to), o.isDir, taken);
          taken.add(name);
          to = joinPath(targetDir, name);
        }
        if (o.mode === 'copy') await fsCopy(serverId, o.from, to, { overwrite: opts.overwrite, recursive: o.isDir });
        else await fsMove(serverId, o.from, to, { overwrite: opts.overwrite });
      },
    );
    await afterMutation([targetDir, ...new Set(ops.map((o) => parentOf(o.from)))]);
  };

  return {
    async trash(entries) {
      await runBulk(
        `Moving ${plural(entries.length, 'item')} to trash`,
        entries.map((e) => ({ id: e.path, label: e.name })),
        (item) => fsDelete(serverId, item.id),
      );
      await afterMutation([...new Set(entries.map((e) => parentOf(e.path)))]);
    },

    async transfer(sources, targetDir, mode) {
      const ok = sources.filter((s) => canDropInto([s.path], targetDir));
      if (ok.length < sources.length) onError('Some items were not moved: they are already there or the target is inside them.');
      if (ok.length === 0) return;
      await localOps(
        `${mode === 'copy' ? 'Copying' : 'Moving'} ${plural(ok.length, 'item')}`,
        ok.map((s) => ({ from: s.path, to: joinPath(targetDir, baseName(s.path)), isDir: s.isDir, mode })),
        targetDir,
      );
    },

    async paste(clip, targetDir) {
      const plan = planPaste(clip, serverId, targetDir, await takenNames(serverId, targetDir));
      if (plan.refused.length) {
        onError(plan.refused.map((r) => `${baseName(r.path)}: ${r.reason}`).join('; '));
      }
      // Pastes from another server are routed to runCrossTransfer by the
      // shell before reaching here.
      if (plan.kind === 'transfer') return;
      if (plan.ops.length === 0) return;
      await localOps(
        `${clip.mode === 'cut' ? 'Moving' : 'Copying'} ${plural(plan.ops.length, 'item')}`,
        plan.ops,
        targetDir,
      );
      if (clip.mode === 'cut') clipboardStore.set(null);
    },

    async upload(plan, targetDir) {
      for (const rel of plan.dirs) {
        try {
          await fsMkdir(serverId, joinRel(targetDir, rel));
        } catch (e) {
          if (!isConflict(e)) {
            onError(`Could not create ${rel}: ${msg(e)}`);
            return;
          }
        }
      }
      const byId = new Map(plan.files.map((f, i) => [String(i), f]));
      await runBulk(
        `Uploading ${plural(plan.files.length, 'file')}`,
        plan.files.map((f, i) => ({ id: String(i), label: f.relDir ? `${f.relDir}/${f.file.name}` : f.file.name })),
        async (item, opts) => {
          const f = byId.get(item.id)!;
          const dir = joinRel(targetDir, f.relDir);
          let name: string | undefined;
          if (opts.keepBoth) name = copyName(f.file.name, false, await takenNames(serverId, dir));
          await fsUpload(serverId, dir, f.file, name, { overwrite: opts.overwrite });
        },
      );
      const topDirs = plan.dirs.filter((x) => !x.includes('/')).map((x) => joinRel(targetDir, x));
      await afterMutation([targetDir, ...topDirs]);
    },

    download(entries) {
      const files = entries.filter((e) => e.type === 'file' || e.type === 'symlink');
      const skipped = entries.filter((e) => e.type === 'dir');
      if (skipped.length) onError(`Folders can't be downloaded yet: ${skipped.map((e) => e.name).join(', ')}`);
      // One anchor click per file, spaced out so the browser doesn't
      // collapse them into a single "multiple downloads" block.
      files.forEach((e, i) => {
        window.setTimeout(() => {
          const a = document.createElement('a');
          a.href = fsDownloadURL(serverId, e.path);
          a.download = e.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }, i * 400);
      });
    },

    async create(parent, name, what) {
      try {
        const p = joinPath(parent, name);
        if (what === 'folder') await fsMkdir(serverId, p);
        else await fsWrite(serverId, p, '');
        await afterMutation([parent]);
      } catch (e) {
        onError(msg(e));
      }
    },

    async rename(entry, newName) {
      try {
        await fsRename(serverId, entry.path, joinPath(parentOf(entry.path), newName));
        await afterMutation([parentOf(entry.path)]);
      } catch (e) {
        onError(msg(e));
      }
    },

    async copyOrMoveTo(entry, dst, mode, overwrite) {
      try {
        if (mode === 'copy') await fsCopy(serverId, entry.path, dst, { overwrite, recursive: entry.type === 'dir' });
        else await fsMove(serverId, entry.path, dst, { overwrite });
        await afterMutation([parentOf(entry.path), parentOf(dst)]);
      } catch (e) {
        onError(msg(e));
      }
    },
  };
}

export function useFileActions(d: FileActionsDeps): FileActions {
  const { serverId, runBulk, afterMutation, onError } = d;
  return React.useMemo(
    () => createFileActions({ serverId, runBulk, afterMutation, onError }),
    [serverId, runBulk, afterMutation, onError],
  );
}
