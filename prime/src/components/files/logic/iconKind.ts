import type { FsEntryType } from '@/types';

export type IconKind =
  | 'dir'
  | 'symlink'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'archive'
  | 'code'
  | 'config'
  | 'exec'
  | 'key'
  | 'database'
  | 'disk'
  | 'font'
  | 'log'
  | 'text'
  | 'file';

const BY_EXT: Record<string, IconKind> = {};
const add = (kind: IconKind, exts: string) => {
  for (const e of exts.split(' ')) BY_EXT[e] = kind;
};
add('image', 'png jpg jpeg gif webp svg bmp ico avif tif tiff heic');
add('video', 'mp4 mkv mov avi webm m4v wmv flv mpg mpeg ts');
add('audio', 'mp3 flac wav ogg oga opus m4a aac wma');
add('pdf', 'pdf');
add('document', 'doc docx odt rtf ppt pptx odp pages key epub');
add('spreadsheet', 'xls xlsx ods csv tsv numbers');
add('archive', 'zip tar gz tgz bz2 xz zst 7z rar deb rpm apk jar');
add('code', 'js mjs cjs jsx tsx go py rs c h cc cpp hpp java kt rb php lua swift cs scala html htm css scss less vue svelte');
add('config', 'conf cfg ini yml yaml toml json json5 xml env properties service timer socket mount desktop plist');
add('exec', 'sh bash zsh fish ps1 bat cmd exe bin run appimage');
add('key', 'pem key crt cer csr der p12 pfx pub gpg asc jks');
add('database', 'db sqlite sqlite3 sql mdb');
add('disk', 'iso img qcow2 vmdk vdi vhd vhdx dmg');
add('font', 'ttf otf woff woff2 eot');
add('log', 'log');
add('text', 'txt md markdown rst nfo');
// 'ts' is far more often TypeScript than an MPEG transport stream here,
// and 'key' is more often a private key than a Keynote deck.
BY_EXT.ts = 'code';
BY_EXT.key = 'key';
// A bare '.bin' is opaque data, not something to run.
BY_EXT.bin = 'file';

const KEY_NAMES = /^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?|authorized_keys2?|known_hosts(\.old)?)$/i;
const TEXT_NAMES = /^(readme|license|licence|makefile|dockerfile|changelog|notice|authors|contributing|todo)$/i;
const DOTENV = /^\.env(\..+)?$/i;
// Logs, including rotated ones: kern.log, app.log.2.gz, syslog.1,
// messages.3.gz. A bare numeric suffix only counts when the base has no
// other dot and no digits (so libssl.so.3 and python3.12 are not logs).
const LOG = /\.log(\.\d+)?(\.(gz|xz|bz2|zst))?$/i;
const ROTATED = /^[a-z_-]+\.\d+(\.(gz|xz|bz2|zst))?$/i;

export function iconKind(name: string, type: FsEntryType, mode = 0): IconKind {
  if (type === 'dir') return 'dir';
  if (type === 'symlink') return 'symlink';
  if (type !== 'file') return 'file';
  if (KEY_NAMES.test(name)) return 'key';
  if (DOTENV.test(name)) return 'config';
  if (TEXT_NAMES.test(name)) return 'text';
  if (LOG.test(name)) return 'log';
  if (ROTATED.test(name) && (mode & 0o111) === 0) return 'log';
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const kind = BY_EXT[name.slice(dot + 1).toLowerCase()];
    if (kind) return kind;
  }
  // Unknown or no extension but executable (binaries, versioned names
  // like python3.12): show it as something you can run.
  if ((mode & 0o111) !== 0) return 'exec';
  return 'file';
}
