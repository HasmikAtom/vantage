/**
 * Dismissed failed services — per user, per server.
 *
 * A failed systemd unit that's known to be harmless (e.g. cloud-init on a
 * VPS) can be dismissed so it stops showing in the dashboard's failure
 * banner. A dismissal records when the unit failed (`failedSince`, Unix ms,
 * from the outpost); the SPA drops it once the unit recovers or fails
 * again with a different time, so a dismissal can't hide a new problem.
 * Older outposts send no failure time: those dismissals are by name only.
 *
 * Stored in gate (like pins) so they follow the user across browsers.
 */

import type Database from 'better-sqlite3';

export interface Dismissal {
  unit: string;
  failedSince: number | null;
}

export const MAX_DISMISSALS = 200;

// systemd unit-name characters (incl. \x2d-style escapes); services only.
const UNIT = /^[A-Za-z0-9@:._\\-]{1,248}\.service$/;

export function validateDismissals(
  body: unknown,
): { ok: true; dismissals: Dismissal[] } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { dismissals?: unknown }).dismissals)) {
    return { ok: false, error: 'expected { dismissals: [...] }' };
  }
  const raw = (body as { dismissals: unknown[] }).dismissals;
  if (raw.length > MAX_DISMISSALS) return { ok: false, error: `at most ${MAX_DISMISSALS} dismissals` };
  const seen = new Set<string>();
  const dismissals: Dismissal[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'each dismissal must be an object' };
    const { unit, failedSince } = item as { unit?: unknown; failedSince?: unknown };
    if (typeof unit !== 'string' || !UNIT.test(unit)) return { ok: false, error: 'invalid unit name' };
    if (seen.has(unit)) return { ok: false, error: `duplicate unit ${unit}` };
    seen.add(unit);
    if (failedSince !== undefined && failedSince !== null && !(Number.isSafeInteger(failedSince) && (failedSince as number) >= 0)) {
      return { ok: false, error: 'failedSince must be a non-negative integer (Unix ms) or null' };
    }
    dismissals.push({ unit, failedSince: (failedSince as number | null | undefined) ?? null });
  }
  return { ok: true, dismissals };
}

export interface DismissalStore {
  ensureSchema(): void;
  list(userId: string, serverId: string): Dismissal[];
  replace(userId: string, serverId: string, dismissals: Dismissal[]): Dismissal[];
  deleteForServer(userId: string, serverId: string): void;
}

export function createDismissalStore(db: Database.Database): DismissalStore {
  const ensureSchema = () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dismissed_service (
        userId      TEXT NOT NULL,
        serverId    TEXT NOT NULL,
        unit        TEXT NOT NULL,
        failedSince INTEGER,
        createdAt   INTEGER NOT NULL,
        PRIMARY KEY (userId, serverId, unit)
      );
    `);
  };

  const list = (userId: string, serverId: string): Dismissal[] =>
    db
      .prepare(`SELECT unit, failedSince FROM dismissed_service WHERE userId = ? AND serverId = ? ORDER BY unit`)
      .all(userId, serverId) as Dismissal[];

  const deleteForServer = (userId: string, serverId: string): void => {
    db.prepare(`DELETE FROM dismissed_service WHERE userId = ? AND serverId = ?`).run(userId, serverId);
  };

  const replace = (userId: string, serverId: string, dismissals: Dismissal[]): Dismissal[] => {
    const insert = db.prepare(
      `INSERT INTO dismissed_service (userId, serverId, unit, failedSince, createdAt) VALUES (?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    db.transaction(() => {
      deleteForServer(userId, serverId);
      for (const d of dismissals) insert.run(userId, serverId, d.unit, d.failedSince, now);
    })();
    return list(userId, serverId);
  };

  return { ensureSchema, list, replace, deleteForServer };
}
