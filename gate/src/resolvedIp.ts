/**
 * Persist a server's freshly resolved IP — but only if the server still has
 * the URL the IP was looked up for. A proxied request resolves the old URL,
 * the user saves a new one meanwhile, and an unconditional write would pin
 * the new URL to the old host's address.
 */

import type Database from 'better-sqlite3';

export function saveResolvedIp(
  db: Database.Database,
  userId: string,
  id: string,
  url: string,
  ip: string,
): boolean {
  const r = db
    .prepare(`UPDATE vantage_server SET resolvedIp = ? WHERE userId = ? AND id = ? AND url = ?`)
    .run(ip, userId, id, url);
  return r.changes > 0;
}
