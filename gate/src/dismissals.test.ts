/**
 * Unit tests for dismissals.ts. Run with:
 *   node --import tsx --test src/dismissals.test.ts
 *
 * In-memory SQLite, like pins.test.ts, so no real DB or auth env needed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { MAX_DISMISSALS, createDismissalStore, validateDismissals } from './dismissals.js';

function store() {
  const s = createDismissalStore(new Database(':memory:'));
  s.ensureSchema();
  return s;
}

test('validateDismissals: accepts unit names with an optional failure time', () => {
  const r = validateDismissals({
    dismissals: [
      { unit: 'cloud-init.service', failedSince: 1791276138123 },
      { unit: 'getty@tty1.service' },
      { unit: 'systemd-fsck@dev-disk-by\\x2duuid-12ab.service', failedSince: null },
    ],
  });
  assert.deepEqual(r, {
    ok: true,
    dismissals: [
      { unit: 'cloud-init.service', failedSince: 1791276138123 },
      { unit: 'getty@tty1.service', failedSince: null },
      { unit: 'systemd-fsck@dev-disk-by\\x2duuid-12ab.service', failedSince: null },
    ],
  });
});

test('validateDismissals: rejects non-services, odd names, bad times, duplicates, too many, bad shape', () => {
  const bad = [
    null,
    {},
    { dismissals: 'x' },
    { dismissals: [{ unit: 'cron.timer' }] },
    { dismissals: [{ unit: '../etc.service' }] },
    { dismissals: [{ unit: 'a b.service' }] },
    { dismissals: [{ unit: 'x'.repeat(300) + '.service' }] },
    { dismissals: [{ unit: 'a.service', failedSince: -1 }] },
    { dismissals: [{ unit: 'a.service', failedSince: 1.5 }] },
    { dismissals: [{ unit: 'a.service', failedSince: '123' }] },
    { dismissals: [{ unit: 'a.service' }, { unit: 'a.service' }] },
    { dismissals: Array.from({ length: MAX_DISMISSALS + 1 }, (_, i) => ({ unit: `u${i}.service` })) },
  ];
  for (const b of bad) assert.equal(validateDismissals(b).ok, false, `expected rejection for ${JSON.stringify(b)?.slice(0, 60)}`);
});

test('store: replace, list, and isolation per user and server', () => {
  const s = store();
  s.replace('u1', 's1', [{ unit: 'a.service', failedSince: 5 }]);
  s.replace('u1', 's2', [{ unit: 'b.service', failedSince: null }]);
  s.replace('u2', 's1', [{ unit: 'c.service', failedSince: 7 }]);
  assert.deepEqual(s.list('u1', 's1'), [{ unit: 'a.service', failedSince: 5 }]);
  assert.deepEqual(s.list('u1', 's2'), [{ unit: 'b.service', failedSince: null }]);
  assert.deepEqual(s.list('u2', 's1'), [{ unit: 'c.service', failedSince: 7 }]);
  // replace swaps the whole list
  assert.deepEqual(s.replace('u1', 's1', []), []);
  assert.deepEqual(s.list('u2', 's1'), [{ unit: 'c.service', failedSince: 7 }]);
});

test('store: deleteForServer removes only that user and server', () => {
  const s = store();
  s.replace('u1', 's1', [{ unit: 'a.service', failedSince: 1 }]);
  s.replace('u1', 's2', [{ unit: 'b.service', failedSince: 2 }]);
  s.deleteForServer('u1', 's1');
  assert.deepEqual(s.list('u1', 's1'), []);
  assert.deepEqual(s.list('u1', 's2'), [{ unit: 'b.service', failedSince: 2 }]);
});
