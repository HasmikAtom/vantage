/**
 * Unit tests for cookiePrefix.ts. Run with:
 *   node --import tsx --test src/cookiePrefix.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_COOKIE_PREFIX, cookiePrefix } from './cookiePrefix.js';

test('unset keeps the existing cookie name, so current sessions stay valid', () => {
  assert.equal(cookiePrefix(undefined), DEFAULT_COOKIE_PREFIX);
  assert.equal(cookiePrefix(''), DEFAULT_COOKIE_PREFIX);
  assert.equal(DEFAULT_COOKIE_PREFIX, 'better-auth');
});

test('a second stack on the same host gets its own cookie name', () => {
  // Browsers ignore the port for cookies, so dev (:5173) and the main stack
  // (:8088) on one address would otherwise overwrite each other's login.
  assert.equal(cookiePrefix('vantage-dev'), 'vantage-dev');
  assert.equal(cookiePrefix('  vantage-dev  '), 'vantage-dev');
});

test('a value that cannot be a cookie name is refused at startup', () => {
  for (const bad of ['has space', 'semi;colon', 'equals=sign', 'comma,', 'quote"', 'x'.repeat(65)]) {
    assert.throws(() => cookiePrefix(bad), /GATE_COOKIE_PREFIX/, `expected rejection for ${bad}`);
  }
});
