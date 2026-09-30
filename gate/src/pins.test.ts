/**
 * Unit tests for pins.ts. Run with:
 *   node --import tsx --test src/pins.test.ts
 *
 * Uses an in-memory SQLite database so the tests never touch the real
 * gate DB and don't need the auth env vars auth.ts requires.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { MAX_PINS, createPinStore, validatePins } from './pins.js';

function store() {
  const s = createPinStore(new Database(':memory:'));
  s.ensureSchema();
  return s;
}

test('validatePins: accepts absolute paths and trims labels', () => {
  const r = validatePins({ pins: [{ path: '/var/log/', label: '  Logs ' }, { path: '/' }] });
  assert.deepEqual(r, {
    ok: true,
    pins: [
      { path: '/var/log', label: 'Logs' },
      { path: '/', label: null },
    ],
  });
});

test('validatePins: rejects relative, dot segments, NUL, and overlong paths', () => {
  for (const path of ['var/log', '/a/../b', '/a/./b', '/a\0b', '/' + 'x'.repeat(4096)]) {
    const r = validatePins({ pins: [{ path }] });
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(path).slice(0, 40)}`);
  }
});

test('validatePins: rejects duplicates, long labels, too many pins, bad shape', () => {
  assert.equal(validatePins({ pins: [{ path: '/a' }, { path: '/a/' }] }).ok, false);
  assert.equal(validatePins({ pins: [{ path: '/a', label: 'x'.repeat(101) }] }).ok, false);
  const many = Array.from({ length: MAX_PINS + 1 }, (_, i) => ({ path: `/p${i}` }));
  assert.equal(validatePins({ pins: many }).ok, false);
  assert.equal(validatePins(null).ok, false);
  assert.equal(validatePins({ pins: 'nope' }).ok, false);
  assert.equal(validatePins({ pins: [{ path: 5 }] }).ok, false);
});

test('replace stores pins in order and list returns them', () => {
  const s = store();
  s.replace('u1', 's1', [
    { path: '/b', label: null },
    { path: '/a', label: 'A' },
  ]);
  assert.deepEqual(s.list('u1', 's1'), [
    { path: '/b', label: null },
    { path: '/a', label: 'A' },
  ]);
  s.replace('u1', 's1', [{ path: '/c', label: null }]);
  assert.deepEqual(s.list('u1', 's1'), [{ path: '/c', label: null }]);
});

test('pins are isolated per user and per server', () => {
  const s = store();
  s.replace('u1', 's1', [{ path: '/u1s1', label: null }]);
  s.replace('u2', 's1', [{ path: '/u2s1', label: null }]);
  s.replace('u1', 's2', [{ path: '/u1s2', label: null }]);
  assert.deepEqual(s.list('u1', 's1'), [{ path: '/u1s1', label: null }]);
  assert.deepEqual(s.list('u2', 's1'), [{ path: '/u2s1', label: null }]);
  assert.deepEqual(s.list('u2', 's2'), []);
});

test('deleteForServer removes only that user+server', () => {
  const s = store();
  s.replace('u1', 's1', [{ path: '/a', label: null }]);
  s.replace('u1', 's2', [{ path: '/b', label: null }]);
  s.deleteForServer('u1', 's1');
  assert.deepEqual(s.list('u1', 's1'), []);
  assert.deepEqual(s.list('u1', 's2'), [{ path: '/b', label: null }]);
});
