/**
 * Unit tests for resolvedIp.ts. Run with:
 *   node --import tsx --test src/resolvedIp.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { saveResolvedIp } from './resolvedIp.js';

function db() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE vantage_server (id TEXT, userId TEXT, url TEXT, resolvedIp TEXT)`);
  d.prepare(`INSERT INTO vantage_server VALUES ('s1', 'u1', 'http://new:8080', NULL)`).run();
  return d;
}
const ipOf = (d: Database.Database) =>
  (d.prepare(`SELECT resolvedIp FROM vantage_server WHERE id = 's1'`).get() as { resolvedIp: string | null }).resolvedIp;

test('saves the address when the server still has the URL it was looked up for', () => {
  const d = db();
  assert.equal(saveResolvedIp(d, 'u1', 's1', 'http://new:8080', '10.0.0.5'), true);
  assert.equal(ipOf(d), '10.0.0.5');
});

test('does not save an address looked up for a URL the server no longer has', () => {
  // A request in flight while the user edits the URL must not write the old
  // host's address over the new one.
  const d = db();
  assert.equal(saveResolvedIp(d, 'u1', 's1', 'http://old:8080', '10.0.0.9'), false);
  assert.equal(ipOf(d), null);
});
