/**
 * SSRF guard for outbound HTTP requests against operator-supplied URLs.
 *
 * The auth service lets users register Vantage backend URLs and proxies
 * requests against them with a shared backend token attached. Without a
 * guard, a low-privileged user could register `http://169.254.169.254/...`
 * (cloud metadata) or `http://127.0.0.1:8080` (sibling container) and turn
 * the service into an internal-network probe + credential exfiltrator.
 *
 * What this module does:
 *   - parses a URL and rejects userinfo, non-http schemes, bad ports
 *   - resolves the hostname via DNS (or recognises an IP literal)
 *   - rejects any resolved IP that lives in a blocked range
 *   - exposes `safeFetch` that connects to the validated IP (not via a
 *     fresh DNS lookup at fetch time) so DNS rebinding can't slip past:
 *     a TTL-0 record can't return a public IP on our check and a private
 *     IP at fetch time because we connect by IP.
 *
 * Escape hatch: AUTH_SSRF_ALLOW_PRIVATE=1 disables the private-range
 * checks for trusted-LAN deployments. Default off.
 *
 * No third-party CIDR libs — the matcher is rolled in this file.
 */

import { promises as dns } from 'node:dns';
import { Agent as HttpsAgent } from 'node:https';
import { Agent as HttpAgent } from 'node:http';
import { isIP, isIPv4, isIPv6 } from 'node:net';
import type { LookupFunction } from 'node:net';

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/**
 * Reads the env switch dynamically so tests can flip it mid-process. Cheap:
 * one Map lookup per call.
 */
function allowPrivate(): boolean {
  return process.env.AUTH_SSRF_ALLOW_PRIVATE === '1';
}

// ---------------------------------------------------------------------------
// CIDR matcher
// ---------------------------------------------------------------------------
//
// We keep CIDRs as (prefix bigint, bits) pairs. IPv4 is widened to a 32-bit
// integer; IPv6 is a 128-bit bigint. Mapped/embedded forms (::ffff:a.b.c.d
// and 64:ff9b::a.b.c.d) are normalised to a v4 string before being matched
// against the v4 list — far simpler than encoding the embed in v6 CIDR form.

interface CIDR4 {
  prefix: number; // 32-bit unsigned, top-aligned
  bits: number;
}
interface CIDR6 {
  prefix: bigint; // 128-bit unsigned, top-aligned
  bits: number;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`bad ipv4: ${ip}`);
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) throw new Error(`bad ipv4 octet: ${ip}`);
    n = (n * 256) + o;
  }
  // shift into a 32-bit unsigned by using >>> 0 trick at the boundary.
  return n >>> 0;
}

function parseCidr4(s: string): CIDR4 {
  const [ip, b] = s.split('/');
  const bits = Number(b);
  const addr = ipv4ToInt(ip);
  // Mask off host bits so prefix is canonical (so an input like 10.1.0.0/8
  // produces the same prefix as 10.0.0.0/8).
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { prefix: (addr & mask) >>> 0, bits };
}

function matches4(ipInt: number, c: CIDR4): boolean {
  const mask = c.bits === 0 ? 0 : (0xffffffff << (32 - c.bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === c.prefix;
}

function ipv6ToBigInt(ip: string): bigint {
  // node's `isIPv6` already accepts the broad spectrum we care about, but
  // doesn't expand ::. Manual expansion: split on ::, fill the gap with
  // zero-groups.
  if (!isIPv6(ip)) throw new Error(`bad ipv6: ${ip}`);
  // Strip a zone id if present (fe80::1%eth0); we don't care about it for
  // range checks.
  const zoneless = ip.split('%')[0];
  let groups: string[];
  if (zoneless.includes('::')) {
    const [left, right] = zoneless.split('::');
    const leftG = left === '' ? [] : left.split(':');
    const rightG = right === '' ? [] : right.split(':');
    // A trailing v4 form like ::ffff:1.2.3.4 — convert the v4 to two
    // 16-bit groups so the total still adds to 8.
    const rightExpanded: string[] = [];
    for (const g of rightG) {
      if (g.includes('.')) {
        const v4 = ipv4ToInt(g);
        rightExpanded.push(((v4 >>> 16) & 0xffff).toString(16));
        rightExpanded.push((v4 & 0xffff).toString(16));
      } else {
        rightExpanded.push(g);
      }
    }
    const leftExpanded: string[] = [];
    for (const g of leftG) {
      if (g.includes('.')) {
        const v4 = ipv4ToInt(g);
        leftExpanded.push(((v4 >>> 16) & 0xffff).toString(16));
        leftExpanded.push((v4 & 0xffff).toString(16));
      } else {
        leftExpanded.push(g);
      }
    }
    const fill = 8 - leftExpanded.length - rightExpanded.length;
    groups = [
      ...leftExpanded,
      ...Array(Math.max(0, fill)).fill('0'),
      ...rightExpanded,
    ];
  } else {
    // No ::, still might have a trailing v4 form like 0:0:0:0:0:ffff:1.2.3.4.
    const raw = zoneless.split(':');
    const expanded: string[] = [];
    for (const g of raw) {
      if (g.includes('.')) {
        const v4 = ipv4ToInt(g);
        expanded.push(((v4 >>> 16) & 0xffff).toString(16));
        expanded.push((v4 & 0xffff).toString(16));
      } else {
        expanded.push(g);
      }
    }
    groups = expanded;
  }
  if (groups.length !== 8) throw new Error(`bad ipv6 (expanded to ${groups.length} groups): ${ip}`);
  let n = 0n;
  for (const g of groups) {
    const v = parseInt(g || '0', 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) throw new Error(`bad ipv6 group: ${g} in ${ip}`);
    n = (n << 16n) | BigInt(v);
  }
  return n;
}

function parseCidr6(s: string): CIDR6 {
  const [ip, b] = s.split('/');
  const bits = Number(b);
  const addr = ipv6ToBigInt(ip);
  const mask = bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
  return { prefix: addr & mask, bits };
}

function matches6(ipBig: bigint, c: CIDR6): boolean {
  const mask = c.bits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - c.bits)) - 1n);
  return (ipBig & mask) === c.prefix;
}

// Embedded-v4 detection. Returns the v4 dotted string if the v6 address
// holds a mapped or NAT64-style embed; otherwise null.
function embeddedV4(ip: string): string | null {
  let big: bigint;
  try {
    big = ipv6ToBigInt(ip);
  } catch {
    return null;
  }
  // ::ffff:0:0/96 — IPv4-mapped IPv6
  const mappedPrefix = 0xffffn << 32n; // upper 80 bits zero, next 16 = ffff
  const mappedMask = ((1n << 128n) - 1n) ^ ((1n << 32n) - 1n);
  if ((big & mappedMask) === mappedPrefix) {
    return v4FromLow32(big);
  }
  // 64:ff9b::/96 — NAT64 well-known
  const nat64Prefix = 0x0064ff9b00000000n << 64n;
  const nat64Mask = ((1n << 128n) - 1n) ^ ((1n << 32n) - 1n);
  if ((big & nat64Mask) === nat64Prefix) {
    return v4FromLow32(big);
  }
  return null;
}

function v4FromLow32(big: bigint): string {
  const low = Number(big & 0xffffffffn);
  const a = (low >>> 24) & 0xff;
  const b = (low >>> 16) & 0xff;
  const c = (low >>> 8) & 0xff;
  const d = low & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

// ---------------------------------------------------------------------------
// the block list
// ---------------------------------------------------------------------------

const BLOCKED_V4: readonly CIDR4[] = [
  '0.0.0.0/8',          // current network / "this host"
  '10.0.0.0/8',         // RFC1918 private
  '100.64.0.0/10',      // CGNAT
  '127.0.0.0/8',        // loopback
  '169.254.0.0/16',     // link-local + AWS/GCP/Azure metadata
  '172.16.0.0/12',      // RFC1918 private
  '192.0.0.0/24',       // IETF protocol assignments
  '192.0.2.0/24',       // TEST-NET-1
  '192.168.0.0/16',     // RFC1918 private
  '198.18.0.0/15',      // benchmark
  '198.51.100.0/24',    // TEST-NET-2
  '203.0.113.0/24',     // TEST-NET-3
  '224.0.0.0/4',        // multicast
  '240.0.0.0/4',        // reserved (includes 255.255.255.255)
  '255.255.255.255/32', // broadcast (covered by 240.0.0.0/4 but listed for clarity)
].map(parseCidr4);

const BLOCKED_V6: readonly CIDR6[] = [
  '::/128',          // unspecified
  '::1/128',         // loopback
  // ::ffff:0:0/96 (v4-mapped) and 64:ff9b::/96 (NAT64) are handled by
  // unwrapping the embedded v4 and re-matching against BLOCKED_V4 — see
  // isBlockedIP. They're listed here as a defence in depth in case a v6
  // arrives that we didn't recognise as embedded.
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '100::/64',        // discard prefix
  '2001:db8::/32',   // documentation
  'fc00::/7',        // unique local addresses
  'fe80::/10',       // link-local
  'ff00::/8',        // multicast
].map(parseCidr6);

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export function isBlockedIP(ip: string): boolean {
  if (allowPrivate()) return false;
  const fam = isIP(ip);
  if (fam === 4) {
    let n: number;
    try {
      n = ipv4ToInt(ip);
    } catch {
      return true; // garbage in -> block, fail closed
    }
    return BLOCKED_V4.some((c) => matches4(n, c));
  }
  if (fam === 6) {
    // Unwrap embedded v4 first so ::ffff:127.0.0.1 maps onto 127.0.0.0/8.
    const v4 = embeddedV4(ip);
    if (v4 !== null && isIPv4(v4)) {
      // We deliberately also still check the v6 list below — defence in
      // depth and matches the spec's `::ffff:0:0/96` block.
      const n = ipv4ToInt(v4);
      if (BLOCKED_V4.some((c) => matches4(n, c))) return true;
    }
    let big: bigint;
    try {
      big = ipv6ToBigInt(ip);
    } catch {
      return true;
    }
    return BLOCKED_V6.some((c) => matches6(big, c));
  }
  // Not a valid IP literal of either family — fail closed.
  return true;
}

/**
 * Resolves a hostname to the union of A and AAAA records. If `host` is
 * already an IP literal, returns [host]. Falls through gracefully if one
 * family has no records (very common for v6).
 */
export async function resolveHostnamesToIPs(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  // Strip an IPv6 bracketed literal: [::1] → ::1
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const inner = hostname.slice(1, -1);
    if (isIP(inner)) return [inner];
  }
  const out = new Set<string>();
  const [a4, a6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);
  if (a4.status === 'fulfilled') for (const ip of a4.value) out.add(ip);
  if (a6.status === 'fulfilled') for (const ip of a6.value) out.add(ip);
  return Array.from(out);
}

/**
 * Parses + validates a URL. Throws on any rule failure. Returns the parsed
 * URL on success. Does NOT perform DNS resolution — call
 * resolveHostnamesToIPs + isBlockedIP for that.
 */
export function assertSafeURL(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('BAD_URL: not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`BAD_URL: scheme must be http or https (got ${u.protocol})`);
  }
  if (u.username || u.password) {
    throw new Error('BAD_URL: userinfo (user:pass@host) is not permitted');
  }
  if (!u.hostname) {
    throw new Error('BAD_URL: missing host');
  }
  if (u.port !== '') {
    const p = Number(u.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`BAD_URL: invalid port ${u.port}`);
    }
  }
  return u;
}

export interface ValidatedTarget {
  url: URL;
  ip: string;
  family: 4 | 6;
}

/**
 * The full pipeline: parse, resolve, check every resolved IP, return the
 * URL + the IP we picked to connect through. Callers should pass that IP
 * to `connectByIP` (or equivalent) to defeat DNS rebinding.
 */
export async function validateAndResolve(url: string): Promise<ValidatedTarget> {
  const u = assertSafeURL(url);
  const ips = await resolveHostnamesToIPs(u.hostname);
  if (ips.length === 0) {
    throw new Error(`BAD_URL: hostname did not resolve (${u.hostname})`);
  }
  for (const ip of ips) {
    if (isBlockedIP(ip)) {
      throw new Error(`BAD_URL: resolved IP ${ip} is in a blocked range`);
    }
  }
  // Prefer the first v4 — Node's fetch + IP literal works cleanly for v4
  // and most LAN/backend deployments are v4 today. Fall back to the first
  // v6 if no v4 came back.
  const v4 = ips.find((ip) => isIPv4(ip));
  const picked = v4 ?? ips[0];
  return { url: u, ip: picked, family: isIPv4(picked) ? 4 : 6 };
}

/**
 * Build an HTTP(S) agent that pins DNS to a specific IP for a given
 * hostname. This is the primitive that defeats DNS rebinding: the actual
 * TCP connect goes to the IP we just validated, even though the request's
 * Host header (and TLS SNI for https) still carries the original
 * hostname so vhost dispatch and certificate validation work normally.
 */
export function agentForPinnedIP(family: 4 | 6, ip: string, scheme: 'http:' | 'https:'): HttpAgent | HttpsAgent {
  const lookup: LookupFunction = (_hostname, _options, cb) => {
    cb(null, ip, family);
  };
  // Node 23's undici-backed fetch will honour `dispatcher` for fine-grained
  // control, but for the plain http/https agents the `lookup` field on the
  // agent options is enough — node:net.Socket consults it.
  return scheme === 'https:'
    ? new HttpsAgent({ lookup, keepAlive: false })
    : new HttpAgent({ lookup, keepAlive: false });
}

/**
 * Convenience wrapper: parses + resolves + checks `url`, then fetches it
 * with the connect pinned to the validated IP and redirects disabled.
 *
 * HTTPS caveat: Node's WHATWG `fetch` (undici) doesn't expose a plain
 * `agent` field; instead we connect via an http(s).Agent through the
 * `dispatcher` extension. To keep this widely compatible across Node
 * versions, we use the simpler `(scheme)://(ip):(port)(path)` form with
 * the Host header preserved. For http this is fully transparent. For
 * https this means the TLS cert validates against the IP, which usually
 * fails for operator-owned LANs. The proxy callers should generally
 * stick to http for in-LAN backends; the caveat is documented at the
 * call site.
 */
export async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const target = await validateAndResolve(url);
  const u = target.url;
  // Rebuild URL with the IP. Bracketed for v6.
  const hostInUrl = target.family === 6 ? `[${target.ip}]` : target.ip;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const ipUrl = `${u.protocol}//${hostInUrl}:${port}${u.pathname}${u.search}`;
  // Headers: preserve caller-supplied headers, force the Host header to the
  // original hostname (with port iff non-default) so the upstream's vhost
  // dispatch still works.
  const headers = new Headers(init?.headers);
  const defaultPort = u.protocol === 'https:' ? '443' : '80';
  const hostHeader = u.port && u.port !== defaultPort ? `${u.hostname}:${u.port}` : u.hostname;
  headers.set('Host', hostHeader);
  return fetch(ipUrl, {
    ...init,
    headers,
    redirect: 'manual',
  });
}
