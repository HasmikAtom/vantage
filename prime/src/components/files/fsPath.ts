// Path + formatting helpers for the Files explorer. Every path is
// HOST-relative and absolute ("/etc/hosts"); the outpost maps it through
// /hostfs internally.

export const ROOT = '/';

// Files up to this size open in the in-browser editor; larger ones download.
export const EDITOR_MAX_BYTES = 1 << 20;

export function joinPath(parent: string, name: string): string {
  return parent === '/' ? '/' + name : parent + '/' + name;
}

export function parentOf(p: string): string {
  if (p === '/' || !p.includes('/')) return '/';
  const i = p.lastIndexOf('/');
  return i === 0 ? '/' : p.slice(0, i);
}

export function baseName(p: string): string {
  if (p === '/') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

export function isSameOrDescendant(ancestor: string, p: string): boolean {
  if (ancestor === '/') return true;
  return p === ancestor || p.startsWith(ancestor + '/');
}

export function ancestorsOf(p: string): string[] {
  if (p === '/') return ['/'];
  const out = ['/'];
  let cur = '';
  for (const seg of p.split('/').slice(1)) {
    cur += '/' + seg;
    out.push(cur);
  }
  return out;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
}

export function formatSize(bytes: number, type: string): string {
  return type === 'dir' ? '—' : formatBytes(bytes);
}

export function formatMtime(unix: number): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
  });
}

// copyName picks the name for a copy placed next to the original:
// "a.txt" → "a (copy).txt" → "a (copy 2).txt". Directories and names whose
// only dot is the leading one (".bashrc") get the suffix at the end.
export function copyName(name: string, isDir: boolean, taken: ReadonlySet<string>): string {
  const dot = isDir ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = `${stem} (copy${n === 1 ? '' : ' ' + n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
