/**
 * Unit tests for targetIp.ts. Run with:
 *   node --import tsx --test src/targetIp.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTargetResolver } from './targetIp.js';

function setup(answers: (string | Error)[]) {
  let now = 1_000_000;
  let calls = 0;
  const resolver = createTargetResolver({
    resolve: async () => {
      const a = answers[Math.min(calls++, answers.length - 1)]!;
      if (a instanceof Error) throw a;
      return { ip: a };
    },
    now: () => now,
    ttlMs: 60_000,
  });
  return { resolver, advance: (ms: number) => { now += ms; }, calls: () => calls };
}

test('follows the hostname to its current address and reports the change', async () => {
  const { resolver } = setup(['10.0.7.4']);
  const changed: string[] = [];
  const ip = await resolver.currentIp('http://outpost:8080', '10.0.7.3', (n) => changed.push(n));
  assert.equal(ip, '10.0.7.4');
  assert.deepEqual(changed, ['10.0.7.4']);
});

test('does not report a change when the address is the same', async () => {
  const { resolver } = setup(['10.0.7.3']);
  const changed: string[] = [];
  await resolver.currentIp('http://outpost:8080', '10.0.7.3', (n) => changed.push(n));
  assert.deepEqual(changed, []);
});

test('reuses a lookup for a minute, then looks again', async () => {
  const { resolver, advance, calls } = setup(['10.0.0.1', '10.0.0.2']);
  assert.equal(await resolver.currentIp('http://h:1', null), '10.0.0.1');
  assert.equal(await resolver.currentIp('http://h:1', null), '10.0.0.1');
  assert.equal(calls(), 1);
  advance(60_001);
  assert.equal(await resolver.currentIp('http://h:1', null), '10.0.0.2');
  assert.equal(calls(), 2);
});

test('a name that does not resolve is an error — never the old address', async () => {
  // e.g. a Docker container being recreated: its old IP may already belong
  // to another container, which must not receive the outpost token.
  const { resolver } = setup([new Error('BAD_URL: hostname did not resolve (h)')]);
  await assert.rejects(resolver.currentIp('http://h:1', '10.0.0.9'), /did not resolve/);
});

test('a name that now resolves into a blocked range is refused, never falls back', async () => {
  const { resolver } = setup([new Error('BAD_URL: resolved IP 169.254.1.1 is in a blocked range')]);
  await assert.rejects(resolver.currentIp('http://h:1', '10.0.0.9'), /blocked range/);
});

test('without a saved address a DNS failure is an error', async () => {
  const { resolver } = setup([new Error('BAD_URL: hostname did not resolve (h)')]);
  await assert.rejects(resolver.currentIp('http://h:1', null), /did not resolve/);
});

test('requests made at the same time share one lookup', async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const resolver = createTargetResolver({
    resolve: async () => {
      calls++;
      await gate;
      return { ip: '10.0.0.1', ips: ['10.0.0.1'] };
    },
  });
  const a = resolver.currentIp('http://h:1', null);
  const b = resolver.currentIp('http://h:1', null);
  release();
  assert.deepEqual(await Promise.all([a, b]), ['10.0.0.1', '10.0.0.1']);
  assert.equal(calls, 1);
});

test('a failed shared lookup is not cached', async () => {
  const { resolver, calls } = setup([new Error('BAD_URL: hostname did not resolve (h)'), '10.0.0.1']);
  await assert.rejects(resolver.currentIp('http://h:1', null));
  assert.equal(await resolver.currentIp('http://h:1', null), '10.0.0.1');
  assert.equal(calls(), 2);
});

test('keeps the saved address while it is still one of the answers', async () => {
  // Round-robin names list their addresses in varying order; following the
  // first answer would flip the saved IP back and forth.
  const resolver = createTargetResolver({
    resolve: async () => ({ ip: '10.0.0.1', ips: ['10.0.0.1', '10.0.0.2'] }),
  });
  const changed: string[] = [];
  const ip = await resolver.currentIp('http://h:1', '10.0.0.2', (n) => changed.push(n));
  assert.equal(ip, '10.0.0.2');
  assert.deepEqual(changed, []);
});

test('a failure saving the new address does not fail the request', async () => {
  // Persisting is best-effort (e.g. SQLITE_BUSY); the address itself passed
  // validation, so the request goes ahead and the save is retried next time.
  const { resolver } = setup(['10.0.7.4']);
  const ip = await resolver.currentIp('http://outpost:8080', '10.0.7.3', () => {
    throw new Error('SQLITE_BUSY');
  });
  assert.equal(ip, '10.0.7.4');
});
