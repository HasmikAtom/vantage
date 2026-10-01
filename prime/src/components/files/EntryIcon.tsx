import type { FsEntry } from '@/types';
import {
  DatabaseIcon,
  DiscIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileConfigIcon,
  FileDocumentIcon,
  FileFontIcon,
  FileIcon,
  FileImageIcon,
  FileLogIcon,
  FilePdfIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  FolderIcon,
  KeyIcon,
  LinkIcon,
  TerminalIcon,
  type IconProps,
} from '@/components/ui/icons';
import { iconKind, type IconKind } from './logic/iconKind';

// One icon + tint per kind. The 500 shades read on the light theme; the
// 400 shades keep contrast on the dark one.
const KINDS: Record<IconKind, { Icon: (p: IconProps) => JSX.Element; className: string }> = {
  dir: { Icon: FolderIcon, className: 'text-primary/80' },
  symlink: { Icon: LinkIcon, className: 'text-muted-foreground' },
  image: { Icon: FileImageIcon, className: 'text-violet-500 dark:text-violet-400' },
  video: { Icon: FileVideoIcon, className: 'text-pink-500 dark:text-pink-400' },
  audio: { Icon: FileAudioIcon, className: 'text-fuchsia-500 dark:text-fuchsia-400' },
  pdf: { Icon: FilePdfIcon, className: 'text-red-500 dark:text-red-400' },
  document: { Icon: FileDocumentIcon, className: 'text-sky-500 dark:text-sky-400' },
  spreadsheet: { Icon: FileSpreadsheetIcon, className: 'text-emerald-500 dark:text-emerald-400' },
  archive: { Icon: FileArchiveIcon, className: 'text-amber-500 dark:text-amber-400' },
  code: { Icon: FileCodeIcon, className: 'text-blue-500 dark:text-blue-400' },
  config: { Icon: FileConfigIcon, className: 'text-slate-500 dark:text-slate-400' },
  exec: { Icon: TerminalIcon, className: 'text-lime-600 dark:text-lime-400' },
  key: { Icon: KeyIcon, className: 'text-yellow-600 dark:text-yellow-400' },
  database: { Icon: DatabaseIcon, className: 'text-cyan-500 dark:text-cyan-400' },
  disk: { Icon: DiscIcon, className: 'text-orange-500 dark:text-orange-400' },
  font: { Icon: FileFontIcon, className: 'text-indigo-500 dark:text-indigo-400' },
  log: { Icon: FileLogIcon, className: 'text-stone-500 dark:text-stone-400' },
  text: { Icon: FileTextIcon, className: 'text-muted-foreground/80' },
  file: { Icon: FileIcon, className: 'text-muted-foreground/70' },
};

// cn() only joins classes, so a broken link must swap the colour rather
// than append a second text-* class (CSS order would decide the winner).
export function iconClassFor(kind: IconKind, broken: boolean): string {
  return kind === 'symlink' && broken ? 'text-destructive' : KINDS[kind].className;
}

export function EntryIcon({ entry, size = 13 }: { entry: FsEntry; size?: number }) {
  const kind = iconKind(entry.name, entry.type, entry.mode);
  const { Icon } = KINDS[kind];
  return <Icon size={size} className={iconClassFor(kind, !!entry.broken)} />;
}
