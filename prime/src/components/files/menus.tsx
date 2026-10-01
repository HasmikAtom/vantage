import type { ReactNode } from 'react';
import type { FsEntry } from '@/types';
import type { MenuEntry } from '@/components/ui/context-menu';
import {
  ClipboardIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  FolderIcon,
  PinIcon,
  RefreshIcon,
  ScissorsIcon,
  TrashIcon,
  UploadIcon,
} from '@/components/ui/icons';
import { EDITOR_MAX_BYTES } from './fsPath';

// Context-menu contents for the explorer. Items the role cannot perform
// stay visible but disabled with the same hint the old toolbar used.

export interface MenuCtx {
  canControl: boolean;
  canAdmin: boolean;
  hasClipboard: boolean;
  showHidden: boolean;
  open(e: FsEntry): void;
  edit(e: FsEntry): void;
  download(list: readonly FsEntry[]): void;
  cut(list: readonly FsEntry[]): void;
  copy(list: readonly FsEntry[]): void;
  paste(dir: string): void;
  // Split view only: copy/move the targets into the other pane's folder.
  toOther?: (list: readonly FsEntry[], mode: 'copy' | 'move') => void;
  rename(e: FsEntry): void;
  copyTo(e: FsEntry): void;
  moveTo(e: FsEntry): void;
  copyPath(e: FsEntry): void;
  pin?: (e: FsEntry) => void;
  sendTo(e: FsEntry): void;
  perms(e: FsEntry): void;
  trash(list: readonly FsEntry[]): void;
  newItem(what: 'folder' | 'file', dir: string): void;
  uploadFiles(): void;
  uploadFolder(): void;
  refresh(): void;
  toggleHidden(): void;
  openTrashBin(): void;
}

const OPERATOR = 'Operator role required';
const ADMIN = 'Admin role required';
const SEP: MenuEntry = { kind: 'separator' };

interface ItemOpts {
  allowed?: boolean;
  why?: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
}

function item(label: string, onSelect: () => void, o: ItemOpts = {}): MenuEntry {
  const allowed = o.allowed ?? true;
  return {
    kind: 'item',
    label,
    onSelect,
    disabled: !allowed,
    ...(!allowed && o.why ? { title: o.why } : {}),
    ...(o.icon ? { icon: o.icon } : {}),
    ...(o.shortcut ? { shortcut: o.shortcut } : {}),
    ...(o.danger ? { danger: true } : {}),
  };
}

export function itemMenu(targets: readonly FsEntry[], c: MenuCtx): MenuEntry[] {
  const one = targets.length === 1 ? targets[0]! : null;
  const files = targets.filter((e) => e.type !== 'dir');
  const op: ItemOpts = { allowed: c.canControl, why: OPERATOR };
  const out: MenuEntry[] = [];

  if (one) {
    out.push(item('Open', () => c.open(one), {
      shortcut: 'Enter',
      icon: one.type === 'dir' ? <FolderIcon size={12} /> : <FileTextIcon size={12} />,
    }));
    if (one.type === 'file' && one.size <= EDITOR_MAX_BYTES) out.push(item('Edit', () => c.edit(one)));
  }
  if (files.length > 0) {
    out.push(item(files.length > 1 ? `Download ${files.length} files` : 'Download', () => c.download(targets), {
      icon: <DownloadIcon size={12} />,
    }));
  }
  out.push(SEP);
  out.push(item('Cut', () => c.cut(targets), { ...op, icon: <ScissorsIcon size={12} />, shortcut: 'Ctrl+X' }));
  out.push(item('Copy', () => c.copy(targets), { icon: <CopyIcon size={12} />, shortcut: 'Ctrl+C' }));
  if (one && one.type === 'dir' && c.hasClipboard) {
    out.push(item('Paste into folder', () => c.paste(one.path), { ...op, icon: <ClipboardIcon size={12} /> }));
  }
  const toOther = c.toOther;
  if (toOther) {
    out.push(item('Copy to other pane', () => toOther(targets, 'copy'), { ...op, icon: <CopyIcon size={12} />, shortcut: 'F5' }));
    out.push(item('Move to other pane', () => toOther(targets, 'move'), { ...op, shortcut: 'F6' }));
  }
  out.push(SEP);
  if (one) {
    out.push(item('Rename', () => c.rename(one), { ...op, shortcut: 'F2' }));
    out.push(item('Copy to…', () => c.copyTo(one), op));
    out.push(item('Move to…', () => c.moveTo(one), op));
    out.push(item('Copy path', () => c.copyPath(one)));
    const pin = c.pin;
    if (one.type === 'dir' && pin) out.push(item('Pin to sidebar', () => pin(one), { icon: <PinIcon size={12} /> }));
    if (one.type === 'file') out.push(item('Send to another server…', () => c.sendTo(one), op));
    out.push(item('Permissions…', () => c.perms(one), { allowed: c.canAdmin, why: ADMIN }));
    out.push(SEP);
  }
  out.push(item(
    targets.length > 1 ? `Move ${targets.length} items to trash` : 'Move to trash',
    () => c.trash(targets),
    { ...op, icon: <TrashIcon size={12} />, shortcut: 'Del', danger: true },
  ));
  return out;
}

export function backgroundMenu(dir: string, c: MenuCtx): MenuEntry[] {
  const op: ItemOpts = { allowed: c.canControl, why: OPERATOR };
  return [
    item('New folder', () => c.newItem('folder', dir), { ...op, icon: <FolderIcon size={12} />, shortcut: 'Ctrl+Shift+N' }),
    item('New file', () => c.newItem('file', dir), { ...op, icon: <FileTextIcon size={12} /> }),
    item('Upload files…', c.uploadFiles, { ...op, icon: <UploadIcon size={12} /> }),
    item('Upload folder…', c.uploadFolder, op),
    item('Paste', () => c.paste(dir), {
      allowed: c.canControl && c.hasClipboard,
      ...(c.canControl ? {} : { why: OPERATOR }),
      icon: <ClipboardIcon size={12} />,
      shortcut: 'Ctrl+V',
    }),
    SEP,
    item('Refresh', c.refresh, { icon: <RefreshIcon size={12} />, shortcut: 'F5' }),
    item(c.showHidden ? 'Hide hidden files' : 'Show hidden files', c.toggleHidden),
    item('Open trash bin', c.openTrashBin, { icon: <TrashIcon size={12} /> }),
  ];
}
