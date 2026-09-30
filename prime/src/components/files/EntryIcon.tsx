import type { FsEntry } from '@/types';
import { cn } from '@/lib/utils';
import {
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FolderIcon,
  LinkIcon,
} from '@/components/ui/icons';
import { iconKind } from './logic/iconKind';

export function EntryIcon({ entry, size = 13 }: { entry: FsEntry; size?: number }) {
  switch (iconKind(entry.name, entry.type)) {
    case 'dir':
      return <FolderIcon size={size} className="text-primary/80" />;
    case 'symlink':
      return <LinkIcon size={size} className={cn('text-muted-foreground', entry.broken && 'text-destructive')} />;
    case 'image':
      return <FileImageIcon size={size} className="text-muted-foreground/80" />;
    case 'archive':
      return <FileArchiveIcon size={size} className="text-muted-foreground/80" />;
    case 'code':
      return <FileCodeIcon size={size} className="text-muted-foreground/80" />;
    case 'text':
      return <FileTextIcon size={size} className="text-muted-foreground/80" />;
    default:
      return <FileIcon size={size} className="text-muted-foreground/70" />;
  }
}
