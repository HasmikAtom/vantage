/**
 * Per-user backend server registry, persisted in the same SQLite DB as
 * better-auth. Backend tokens are encrypted at rest with AES-256-GCM; the
 * key is sourced from env.registryKey (VANTAGE_REGISTRY_KEY).
 *
 * Storage shape:
 *   vantage_server(
 *     id              TEXT PRIMARY KEY,
 *     userId          TEXT NOT NULL,
 *     name            TEXT NOT NULL,
 *     url             TEXT NOT NULL,           -- e.g. http://10.0.0.5:8080
 *     tokenCiphertext BLOB NOT NULL,           -- AES-GCM output
 *     tokenNonce      BLOB NOT NULL,           -- 12-byte GCM IV
 *     tokenTag        BLOB NOT NULL,           -- 16-byte GCM auth tag
 *     resolvedIp      TEXT                     -- resolved IP from registration
 *                                              -- time; the proxy connects to
 *                                              -- THIS IP rather than re-resolving
 *                                              -- the hostname (defeats DNS rebind)
 *     createdAt       INTEGER NOT NULL         -- unix ms
 *   )
 *   INDEX vantage_server_userId ON vantage_server(userId)
 *
 * All reads/writes go through this module so the encryption boundary is in
 * one place. Routes never touch raw token bytes directly.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { db } from './auth.js';
import { env } from './env.js';

// ---------------------------------------------------------------------------
// schema migration
// ---------------------------------------------------------------------------

export function ensureRegistrySchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vantage_server (
      id              TEXT PRIMARY KEY,
      userId          TEXT NOT NULL,
      name            TEXT NOT NULL,
      url             TEXT NOT NULL,
      tokenCiphertext BLOB NOT NULL,
      tokenNonce      BLOB NOT NULL,
      tokenTag        BLOB NOT NULL,
      createdAt       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vantage_server_userId
      ON vantage_server(userId);
  `);
  // Additive migration: resolvedIp was introduced with the SSRF guard.
  // PRAGMA table_info lets us skip the ADD COLUMN if it's already there
  // (SQLite has no IF NOT EXISTS for ADD COLUMN).
  const cols = db.prepare(`PRAGMA table_info(vantage_server)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'resolvedIp')) {
    db.exec(`ALTER TABLE vantage_server ADD COLUMN resolvedIp TEXT`);
  }
}

// ---------------------------------------------------------------------------
// encryption — AES-256-GCM
// ---------------------------------------------------------------------------

// Decode and validate the key once at module load. Failing here at startup
// is much friendlier than failing on the first encrypt/decrypt later.
const key: Buffer = (() => {
  let buf: Buffer;
  try {
    buf = Buffer.from(env.registryKey, 'base64');
  } catch {
    throw new Error('VANTAGE_REGISTRY_KEY must be base64-encoded');
  }
  if (buf.length !== 32) {
    throw new Error(
      `VANTAGE_REGISTRY_KEY must decode to 32 bytes (got ${buf.length}). ` +
        `Generate with: openssl rand -base64 32`,
    );
  }
  return buf;
})();

interface EncryptedToken {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

function encryptToken(plaintext: string): EncryptedToken {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { ciphertext, nonce, tag };
}

function decryptToken(enc: EncryptedToken): string {
  const decipher = createDecipheriv('aes-256-gcm', key, enc.nonce);
  decipher.setAuthTag(enc.tag);
  const plaintext = Buffer.concat([
    decipher.update(enc.ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface ServerSummary {
  id: string;
  name: string;
  url: string;
  createdAt: number;
}

/** Internal row shape — never returned to callers; token stays inside the module. */
interface ServerRow {
  id: string;
  userId: string;
  name: string;
  url: string;
  tokenCiphertext: Buffer;
  tokenNonce: Buffer;
  tokenTag: Buffer;
  resolvedIp: string | null;
  createdAt: number;
}

function newId(): string {
  return 'srv-' + randomBytes(4).toString('hex');
}

export function listServers(userId: string): ServerSummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, url, createdAt
         FROM vantage_server
        WHERE userId = ?
        ORDER BY createdAt ASC`,
    )
    .all(userId) as Omit<ServerRow, 'userId' | 'tokenCiphertext' | 'tokenNonce' | 'tokenTag' | 'resolvedIp'>[];
  return rows;
}

export function getServer(userId: string, id: string): ServerRow | null {
  const row = db
    .prepare(
      `SELECT id, userId, name, url, tokenCiphertext, tokenNonce, tokenTag, resolvedIp, createdAt
         FROM vantage_server
        WHERE userId = ? AND id = ?`,
    )
    .get(userId, id) as ServerRow | undefined;
  return row ?? null;
}

/**
 * Returns the decrypted token for a server along with the pinned
 * resolvedIp captured at registration time. Used by the proxy and the
 * transfer worker — both connect to `resolvedIp` rather than re-resolving
 * the hostname, which is what defeats DNS rebinding.
 */
export function getServerToken(
  userId: string,
  id: string,
): { url: string; token: string; resolvedIp: string | null } | null {
  const row = getServer(userId, id);
  if (!row) return null;
  const token = decryptToken({
    ciphertext: row.tokenCiphertext,
    nonce: row.tokenNonce,
    tag: row.tokenTag,
  });
  return { url: row.url, token, resolvedIp: row.resolvedIp };
}

export function addServer(
  userId: string,
  input: { name: string; url: string; token: string; resolvedIp?: string | null },
): ServerSummary {
  const id = newId();
  const enc = encryptToken(input.token);
  const now = Date.now();
  db.prepare(
    `INSERT INTO vantage_server
       (id, userId, name, url, tokenCiphertext, tokenNonce, tokenTag, resolvedIp, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    input.name,
    input.url,
    enc.ciphertext,
    enc.nonce,
    enc.tag,
    input.resolvedIp ?? null,
    now,
  );
  return { id, name: input.name, url: input.url, createdAt: now };
}

export function updateServer(
  userId: string,
  id: string,
  patch: { name?: string; url?: string; token?: string; resolvedIp?: string | null },
): ServerSummary | null {
  const row = getServer(userId, id);
  if (!row) return null;

  const name = patch.name ?? row.name;
  const url = patch.url ?? row.url;
  // If the URL changed and the caller didn't pass a new resolvedIp, clear
  // the cached IP — it would be stale. Callers that re-probe should pass
  // the freshly resolved IP.
  const resolvedIp =
    patch.resolvedIp !== undefined
      ? patch.resolvedIp
      : patch.url !== undefined && patch.url !== row.url
        ? null
        : row.resolvedIp;

  if (patch.token !== undefined) {
    const enc = encryptToken(patch.token);
    db.prepare(
      `UPDATE vantage_server
          SET name = ?, url = ?, tokenCiphertext = ?, tokenNonce = ?, tokenTag = ?, resolvedIp = ?
        WHERE userId = ? AND id = ?`,
    ).run(name, url, enc.ciphertext, enc.nonce, enc.tag, resolvedIp, userId, id);
  } else {
    db.prepare(
      `UPDATE vantage_server SET name = ?, url = ?, resolvedIp = ? WHERE userId = ? AND id = ?`,
    ).run(name, url, resolvedIp, userId, id);
  }

  return { id, name, url, createdAt: row.createdAt };
}

export function removeServer(userId: string, id: string): boolean {
  const info = db
    .prepare(`DELETE FROM vantage_server WHERE userId = ? AND id = ?`)
    .run(userId, id);
  return info.changes > 0;
}
