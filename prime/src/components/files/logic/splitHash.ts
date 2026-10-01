import { hashFor, pathFromHash } from './history';

// Split view stores both panes in the URL so a reload restores them:
//   #files:<leftPath>|<rightServerId>:<rightPath>
// hashFor() encodes every path segment with encodeURIComponent, so '|'
// and ':' only ever appear as the separators above.

export type FilesHash =
  | { mode: 'single'; path: string }
  | { mode: 'split'; left: string; rightServer: string; right: string };

const PREFIX = '#files:';
const SERVER_ID = /^[A-Za-z0-9_-]+$/;

export function splitHashFor(left: string, rightServer: string, right: string): string {
  return `${hashFor(left)}|${rightServer}:${hashFor(right).slice(PREFIX.length)}`;
}

export function parseFilesHash(hash: string): FilesHash | null {
  if (!hash.startsWith(PREFIX)) return null;
  const body = hash.slice(PREFIX.length);
  const bar = body.indexOf('|');
  if (bar < 0) {
    const path = pathFromHash(hash);
    return path === null ? null : { mode: 'single', path };
  }
  const left = pathFromHash(PREFIX + body.slice(0, bar));
  const rest = body.slice(bar + 1);
  const colon = rest.indexOf(':');
  if (left === null || colon <= 0) return null;
  const rightServer = rest.slice(0, colon);
  const right = pathFromHash(PREFIX + rest.slice(colon + 1));
  if (!SERVER_ID.test(rightServer) || right === null) return null;
  return { mode: 'split', left, rightServer, right };
}
