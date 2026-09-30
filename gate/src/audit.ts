/**
 * Audit log — persistent record of user-initiated actions against any
 * registered outpost. Lives in the same SQLite database as BetterAuth so
 * we get atomic backups and queryable joins to the user table for free.
 *
 * Schema decision and retention policy are documented in
 * container-roadmap.md (Decision 2). Defaults: 90-day retention,
 * once-a-day sweep.
 *
 * What lands here: every write endpoint (start/stop/remove/create/etc.)
 * appends one row before returning. Reads and the auth event log
 * (signin/signup) deliberately do NOT — keeping the table focused on
 * forensic value rather than becoming a generic activity stream.
 */

import { db } from './auth.js';
import type { UserRole } from './auth.js';

export const AUDIT_RETENTION_DAYS = 90;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function ensureAuditSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT    NOT NULL,
      user_id     TEXT    NOT NULL,
      user_email  TEXT    NOT NULL,
      role        TEXT    NOT NULL,
      action      TEXT    NOT NULL,
      server_id   TEXT,
      target      TEXT,
      status      TEXT    NOT NULL,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit(ts);
    CREATE INDEX IF NOT EXISTS audit_user_idx ON audit(user_id, ts);
  `);
}

export type AuditStatus = 'ok' | 'error' | 'denied';

export interface AuditEntry {
  userId: string;
  userEmail: string;
  role: UserRole;
  action: string;
  serverId?: string | null;
  target?: string | null;
  status: AuditStatus;
  error?: string | null;
}

// Lazy-init the prepared statement so importers don't need to know the
// schema has been ensure'd before they call writeAudit. The typed
// `BindParameters` array form sidesteps better-sqlite3's narrower variadic
// `run()` signature, which TypeScript otherwise complains about.
let prepared: ReturnType<typeof db.prepare> | null = null;
function stmt(): ReturnType<typeof db.prepare> {
  prepared ??= db.prepare(
    `INSERT INTO audit (ts, user_id, user_email, role, action, server_id, target, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return prepared;
}

export function writeAudit(entry: AuditEntry): void {
  stmt().run([
    new Date().toISOString(),
    entry.userId,
    entry.userEmail,
    entry.role,
    entry.action,
    entry.serverId ?? null,
    entry.target ?? null,
    entry.status,
    entry.error ?? null,
  ]);
}

// Delete rows older than the retention window. Returns rows removed.
// Cheap on a tiny table (SQLite slices through this in microseconds),
// so safe to run on a timer.
export function sweepAudit(retentionDays = AUDIT_RETENTION_DAYS): number {
  const result = db
    .prepare(`DELETE FROM audit WHERE ts < datetime('now', ?)`)
    .run(`-${retentionDays} days`);
  return result.changes;
}

// startAuditRetention kicks off the daily sweep and runs one immediately
// so a long-stopped server catches up on cleanup at boot. Returns a
// cancel function for tests; in production the interval lives for the
// lifetime of the process.
export function startAuditRetention(): () => void {
  sweepAudit();
  const handle = setInterval(() => {
    try {
      sweepAudit();
    } catch (err) {
      // Don't crash the gate service if the sweep fails — the audit
      // log is forensic, not load-bearing. Log and continue.
      console.error('audit sweep failed:', err);
    }
  }, SWEEP_INTERVAL_MS);
  return () => clearInterval(handle);
}
