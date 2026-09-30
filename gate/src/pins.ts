/**
 * Per-user, per-server pinned folders for the Files tab sidebar.
 *
 * Storage shape:
 *   file_pin(
 *     userId    TEXT NOT NULL,
 *     serverId  TEXT NOT NULL,
 *     path      TEXT NOT NULL,      -- host-absolute, normalised (no trailing /)
 *     label     TEXT,               -- optional display name
 *     position  INTEGER NOT NULL,   -- sidebar order
 *     createdAt INTEGER NOT NULL,   -- unix ms
 *     PRIMARY KEY (userId, serverId, path)
 *   )
 *
 * The SPA edits the list locally and saves it whole (replace), so there is
 * no per-pin endpoint. Pins are a user preference: not audited, and gate
 * does not check that the path exists on the host.
 *
 * The store takes the Database as a parameter so tests can use an
 * in-memory DB without loading auth.ts (which needs the auth env vars).
 */

import type Database from 'better-sqlite3';

export interface Pin {
  path: string;
  label: string | null;
}

export const MAX_PINS = 50;
const MAX_PATH = 4096;
const MAX_LABEL = 100;

function normalisePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('/') || raw.length > MAX_PATH || raw.includes('\0')) return null;
  const trimmed = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  const segments = trimmed.split('/').slice(1);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  return trimmed === '' ? '/' : trimmed;
}

export function validatePins(
  input: unknown,
): { ok: true; pins: Pin[] } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { pins?: unknown }).pins)) {
    return { ok: false, error: 'body must be {pins: [{path, label?}]}' };
  }
  const raw = (input as { pins: unknown[] }).pins;
  if (raw.length > MAX_PINS) return { ok: false, error: `at most ${MAX_PINS} pins per server` };
  const seen = new Set<string>();
  const pins: Pin[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'each pin must be an object' };
    const { path: rawPath, label: rawLabel } = item as { path?: unknown; label?: unknown };
    const path = normalisePath(rawPath);
    if (!path) return { ok: false, error: `invalid path: ${String(rawPath).slice(0, 80)}` };
    if (seen.has(path)) return { ok: false, error: `duplicate path: ${path}` };
    seen.add(path);
    let label: string | null = null;
    if (rawLabel !== undefined && rawLabel !== null) {
      if (typeof rawLabel !== 'string') return { ok: false, error: 'label must be a string' };
      const t = rawLabel.trim();
      if (t.length > MAX_LABEL) return { ok: false, error: `label longer than ${MAX_LABEL} chars` };
      label = t === '' ? null : t;
    }
    pins.push({ path, label });
  }
  return { ok: true, pins };
}

export interface PinStore {
  ensureSchema(): void;
  list(userId: string, serverId: string): Pin[];
  replace(userId: string, serverId: string, pins: Pin[]): Pin[];
  deleteForServer(userId: string, serverId: string): void;
}

export function createPinStore(db: Database.Database): PinStore {
  const ensureSchema = () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_pin (
        userId    TEXT NOT NULL,
        serverId  TEXT NOT NULL,
        path      TEXT NOT NULL,
        label     TEXT,
        position  INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (userId, serverId, path)
      );
    `);
  };

  const list = (userId: string, serverId: string): Pin[] =>
    db
      .prepare(
        `SELECT path, label FROM file_pin WHERE userId = ? AND serverId = ? ORDER BY position`,
      )
      .all(userId, serverId) as Pin[];

  const deleteForServer = (userId: string, serverId: string): void => {
    db.prepare(`DELETE FROM file_pin WHERE userId = ? AND serverId = ?`).run(userId, serverId);
  };

  const replace = (userId: string, serverId: string, pins: Pin[]): Pin[] => {
    const insert = db.prepare(
      `INSERT INTO file_pin (userId, serverId, path, label, position, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    db.transaction(() => {
      deleteForServer(userId, serverId);
      pins.forEach((p, i) => insert.run(userId, serverId, p.path, p.label, i, now));
    })();
    return list(userId, serverId);
  };

  return { ensureSchema, list, replace, deleteForServer };
}
