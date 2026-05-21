/**
 * Pre-authorized email allowlist for sign-ups after the admin bootstrap.
 *
 * Design rationale (see MEMORY note on the design discussion):
 *
 *   The single-admin invariant in `auth.ts:create.before` rejects every
 *   sign-up after the first one. That's safe but means there's no way to
 *   onboard a second user without database surgery or temporarily lifting
 *   the gate. This module is the staging table that the admin uses to
 *   pre-approve specific emails.
 *
 *   When a whitelisted email signs up, the hook lets them through AND
 *   stamps them with the role the admin recorded. The whitelist row stays
 *   after sign-up — it doesn't act as a consumable token. That's
 *   deliberate: the same email remains valid for future password resets
 *   or re-registration if the user account is ever deleted.
 *
 *   Frontend never sees this table directly. The login form just learns
 *   "this email status is 'new'" (whitelisted but unregistered) via
 *   /auth/_email_status and switches into "create a password" mode —
 *   from the user's POV there's no separate sign-up flow.
 */

import { db } from './auth.js';
import type { UserRole } from './auth.js';

export interface WhitelistEntry {
  email: string;
  role: UserRole;
  addedAt: number;       // unix ms
  addedBy: string;       // user id of the admin who added it
}

export function ensureWhitelistSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whitelisted_emails (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('viewer','operator','admin')),
      added_at INTEGER NOT NULL,
      added_by TEXT NOT NULL
    )
  `);
}

// normalizeEmail lower-cases and trims; the column is treated as
// case-insensitive in every lookup so "User@Example.com" matches
// "user@example.com" registered earlier.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function listWhitelist(): WhitelistEntry[] {
  const rows = db
    .prepare('SELECT email, role, added_at, added_by FROM whitelisted_emails ORDER BY added_at DESC')
    .all() as Array<{ email: string; role: UserRole; added_at: number; added_by: string }>;
  return rows.map((r) => ({
    email: r.email,
    role: r.role,
    addedAt: r.added_at,
    addedBy: r.added_by,
  }));
}

export function addWhitelist(email: string, role: UserRole, addedBy: string): WhitelistEntry {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) {
    throw new Error('invalid email');
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO whitelisted_emails (email, role, added_at, added_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET role = excluded.role`,
  ).run(normalized, role, now, addedBy);
  // Re-read so the response reflects whatever the row actually is now
  // (in particular: the original added_at if this was a role-update).
  const row = db
    .prepare('SELECT email, role, added_at, added_by FROM whitelisted_emails WHERE email = ?')
    .get(normalized) as { email: string; role: UserRole; added_at: number; added_by: string };
  return {
    email: row.email,
    role: row.role,
    addedAt: row.added_at,
    addedBy: row.added_by,
  };
}

export function removeWhitelist(email: string): boolean {
  const normalized = normalizeEmail(email);
  const info = db.prepare('DELETE FROM whitelisted_emails WHERE email = ?').run(normalized);
  return info.changes > 0;
}

// whitelistRoleFor is the hot-path lookup used by the create.before hook.
// Returns null when the email is not on the list, otherwise the role the
// admin assigned. Always normalises so case differences don't bypass.
export function whitelistRoleFor(email: string): UserRole | null {
  const normalized = normalizeEmail(email);
  const row = db
    .prepare('SELECT role FROM whitelisted_emails WHERE email = ?')
    .get(normalized) as { role: UserRole } | undefined;
  return row ? row.role : null;
}

