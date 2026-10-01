/**
 * Unit tests for transferSnapshot.ts. Run with:
 *   node --import tsx --test src/transferSnapshot.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapshotFor, snapshotOf } from './transferSnapshot.js';

const state = {
  id: 't1',
  userId: 'u1',
  bytesTotal: 100,
  bytesDone: 40,
  status: 'running' as const,
  error: null,
  srcPath: '/secret/not/exposed',
};

test('snapshotOf exposes only the progress fields', () => {
  assert.deepEqual(snapshotOf(state), { id: 't1', bytesTotal: 100, bytesDone: 40, status: 'running', error: null });
});

test('snapshotFor returns the owner\'s transfer', () => {
  const store = new Map([['t1', state]]);
  assert.deepEqual(snapshotFor(store, 't1', 'u1'), snapshotOf(state));
});

test('snapshotFor hides other users\' and unknown transfers', () => {
  const store = new Map([['t1', state]]);
  assert.equal(snapshotFor(store, 't1', 'someone-else'), null);
  assert.equal(snapshotFor(store, 'nope', 'u1'), null);
});
