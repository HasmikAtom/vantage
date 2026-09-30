import type { FsEntryType } from '@/types';

export type IconKind = 'dir' | 'symlink' | 'image' | 'archive' | 'code' | 'text' | 'file';

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar|deb|rpm)$/i;
const CODE = /(^\.env.*$)|\.(js|mjs|cjs|ts|tsx|jsx|go|py|rs|c|h|cc|cpp|java|rb|php|sh|bash|zsh|json|ya?ml|toml|ini|conf|cfg|xml|html?|css|scss|sql|lua|service|timer)$/i;
const TEXT = /(\.(txt|md|log|csv|tsv|rst)$)|^(readme|license|licence|makefile|dockerfile|changelog|notice)$/i;

export function iconKind(name: string, type: FsEntryType): IconKind {
  if (type === 'dir') return 'dir';
  if (type === 'symlink') return 'symlink';
  if (type !== 'file') return 'file';
  if (IMAGE.test(name)) return 'image';
  if (ARCHIVE.test(name)) return 'archive';
  if (CODE.test(name)) return 'code';
  if (TEXT.test(name)) return 'text';
  return 'file';
}
