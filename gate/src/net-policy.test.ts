/**
 * Unit tests for net-policy.ts. Run with:
 *   node --import tsx --test src/net-policy.test.ts
 *
 * The tests are pure (CIDR + URL parsing) plus one end-to-end test that
 * stands up a local HTTP server on 127.0.0.1 and confirms safeFetch
 * refuses to connect to it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as dnsPromises } from 'node:dns';
import { AddressInfo } from 'node:net';

import {
  assertSafeURL,
  isBlockedIP,
  resolveHostnamesToIPs,
  safeFetch,
} from './net-policy.js';

// Make sure the env switch isn't carried in from the parent shell — these
// tests assume the safe default.
delete process.env.GATE_SSRF_ALLOW_PRIVATE;

// ---------------------------------------------------------------------------
// isBlockedIP
// ---------------------------------------------------------------------------

test('isBlockedIP: each blocked IPv4 range has a representative match', () => {
  // One IP from inside each documented blocked v4 range.
  const blocked = [
    '0.0.0.1',          // 0.0.0.0/8
    '10.0.0.1',         // 10.0.0.0/8
    '100.64.0.1',       // 100.64.0.0/10
    '127.0.0.1',        // 127.0.0.0/8
    '169.254.169.254',  // 169.254.0.0/16 (AWS metadata)
    '172.16.0.1',       // 172.16.0.0/12
    '172.31.255.254',   // upper edge of 172.16.0.0/12
    '192.0.0.1',        // 192.0.0.0/24
    '192.0.2.7',        // 192.0.2.0/24
    '192.168.1.1',      // 192.168.0.0/16
    '198.18.0.1',       // 198.18.0.0/15
    '198.51.100.1',     // 198.51.100.0/24
    '203.0.113.1',      // 203.0.113.0/24
    '239.0.0.1',        // 224.0.0.0/4 (multicast)
    '240.0.0.1',        // 240.0.0.0/4 (reserved)
    '255.255.255.255',  // broadcast
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedIP(ip), true, `expected ${ip} to be blocked`);
  }
});

test('isBlockedIP: public IPv4 are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '142.250.80.46', '93.184.216.34']) {
    assert.equal(isBlockedIP(ip), false, `expected ${ip} to be allowed`);
  }
});

test('isBlockedIP: each blocked IPv6 range has a representative match', () => {
  const blocked = [
    '::',                          // ::/128
    '::1',                         // loopback
    '::ffff:127.0.0.1',            // v4-mapped loopback (unwraps to 127/8)
    '::ffff:10.0.0.5',             // v4-mapped private (unwraps to 10/8)
    '::ffff:169.254.169.254',      // v4-mapped metadata
    '64:ff9b::a00:1',              // NAT64 carrying 10.0.0.1
    '100::1',                      // discard prefix
    '2001:db8::1',                 // documentation
    'fc00::1',                     // ULA
    'fd12:3456::1',                // ULA, also under fc00::/7
    'fe80::1',                     // link-local
    'ff02::1',                     // multicast
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedIP(ip), true, `expected ${ip} to be blocked`);
  }
});

test('isBlockedIP: public IPv6 are allowed', () => {
  for (const ip of ['2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450:4001:81d::200e']) {
    assert.equal(isBlockedIP(ip), false, `expected ${ip} to be allowed`);
  }
});

test('isBlockedIP: garbage IPs fail closed', () => {
  for (const ip of ['', 'not-an-ip', '999.999.999.999', '::g']) {
    assert.equal(isBlockedIP(ip), true, `expected garbage ${ip} to be blocked`);
  }
});

test('isBlockedIP: env opt-out returns false for everything', () => {
  process.env.GATE_SSRF_ALLOW_PRIVATE = '1';
  try {
    assert.equal(isBlockedIP('127.0.0.1'), false);
    assert.equal(isBlockedIP('169.254.169.254'), false);
    assert.equal(isBlockedIP('::1'), false);
  } finally {
    delete process.env.GATE_SSRF_ALLOW_PRIVATE;
  }
});

// ---------------------------------------------------------------------------
// assertSafeURL
// ---------------------------------------------------------------------------

test('assertSafeURL: accepts http and https', () => {
  assert.doesNotThrow(() => assertSafeURL('http://example.com'));
  assert.doesNotThrow(() => assertSafeURL('https://example.com:8443/x?y=1'));
});

test('assertSafeURL: rejects non-http schemes', () => {
  for (const u of [
    'file:///etc/passwd',
    'gopher://example.com/',
    'javascript:alert(1)',
    'ftp://example.com/',
    'data:text/plain,hello',
  ]) {
    assert.throws(() => assertSafeURL(u), /BAD_URL/, `expected ${u} to throw`);
  }
});

test('assertSafeURL: rejects userinfo', () => {
  assert.throws(() => assertSafeURL('http://user:pass@example.com'), /userinfo/);
  assert.throws(() => assertSafeURL('http://user@example.com'), /userinfo/);
});

test('assertSafeURL: rejects missing host', () => {
  // `new URL` for http requires a host, so an explicit invalid form is the
  // way in. http:/// has an empty hostname and we catch it.
  assert.throws(() => assertSafeURL('http://'), /BAD_URL/);
});

test('assertSafeURL: rejects weird ports', () => {
  // URL constructor itself rejects negative and >65535 ports as parse
  // errors — that surfaces as our generic BAD_URL message.
  for (const u of [
    'http://example.com:-1/',
    'http://example.com:99999/',
    'http://example.com:abc/',
  ]) {
    assert.throws(() => assertSafeURL(u), /BAD_URL/, `expected ${u} to throw`);
  }
});

test('assertSafeURL: returns the parsed URL on success', () => {
  const u = assertSafeURL('https://example.com:8443/path?q=1');
  assert.equal(u.protocol, 'https:');
  assert.equal(u.hostname, 'example.com');
  assert.equal(u.port, '8443');
  assert.equal(u.pathname, '/path');
});

// ---------------------------------------------------------------------------
// resolveHostnamesToIPs
// ---------------------------------------------------------------------------

test('resolveHostnamesToIPs: returns [ip] for an IP literal', async () => {
  assert.deepEqual(await resolveHostnamesToIPs('127.0.0.1'), ['127.0.0.1']);
  assert.deepEqual(await resolveHostnamesToIPs('::1'), ['::1']);
  assert.deepEqual(await resolveHostnamesToIPs('[::1]'), ['::1']);
});

// ---------------------------------------------------------------------------
// safeFetch — direct rejection + DNS-rebinding-style rejection via lookup
// ---------------------------------------------------------------------------

test('safeFetch: refuses a literal loopback URL', async () => {
  // Stand up a tiny server so we'd actually reach something if the guard
  // failed; the assertion is that we DON'T reach it.
  const srv = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('should not be reached');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    await assert.rejects(
      () => safeFetch(`http://127.0.0.1:${port}/`),
      /blocked range|BAD_URL/,
    );
  } finally {
    srv.close();
  }
});

test('safeFetch: refuses a hostname that resolves to loopback (rebinding-style)', async () => {
  // Monkey-patch dns.promises.resolve4 to return a private IP for our
  // sentinel hostname. The guard should see the resolved IP, classify it
  // as blocked, and refuse — without ever making an outbound connection.
  const original4 = dnsPromises.resolve4;
  const original6 = dnsPromises.resolve6;
  (dnsPromises as { resolve4: typeof original4 }).resolve4 = (async (hostname: string) => {
    if (hostname === 'rebind.test.invalid') return ['127.0.0.1'];
    return original4(hostname);
  }) as typeof original4;
  (dnsPromises as { resolve6: typeof original6 }).resolve6 = (async (hostname: string) => {
    if (hostname === 'rebind.test.invalid') throw new Error('no AAAA');
    return original6(hostname);
  }) as typeof original6;

  try {
    await assert.rejects(
      () => safeFetch('http://rebind.test.invalid/'),
      /blocked range/,
    );
  } finally {
    (dnsPromises as { resolve4: typeof original4 }).resolve4 = original4;
    (dnsPromises as { resolve6: typeof original6 }).resolve6 = original6;
  }
});

test('safeFetch: blocks file: and other dangerous schemes before any I/O', async () => {
  await assert.rejects(() => safeFetch('file:///etc/passwd'), /BAD_URL/);
  await assert.rejects(() => safeFetch('gopher://example.com/'), /BAD_URL/);
});
