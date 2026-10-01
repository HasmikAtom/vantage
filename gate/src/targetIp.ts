/**
 * Which IP to connect to for a registered outpost.
 *
 * Registration validates the URL against the SSRF policy and saves the
 * resolved IP. Connecting to that saved IP forever breaks when the outpost's
 * address changes (Docker networks, DHCP): requests — with the outpost token
 * — then go to whatever machine holds the old address. So the hostname is
 * looked up again (reused for ttlMs), every new answer goes through the same
 * SSRF validation, and callers are told when the address changed so they can
 * persist it. Connecting by validated IP still defeats DNS rebinding within
 * a request.
 *
 * Concurrent requests for one URL share a single lookup, and when the saved
 * IP is still among the validated answers it is kept, so a name with several
 * addresses doesn't flip between them.
 *
 * Fail closed: if the name can't be resolved (e.g. a Docker container being
 * recreated) the request errors. Falling back to the saved IP would send the
 * token to whichever machine now holds that address.
 */

import { validateAndResolve } from './net-policy.js';

export interface TargetResolverOptions {
  resolve?: (url: string) => Promise<{ ip: string; ips?: string[] }>;
  now?: () => number;
  ttlMs?: number;
}

export interface TargetResolver {
  currentIp(url: string, savedIp: string | null, onChange?: (ip: string) => void): Promise<string>;
}

export function createTargetResolver(o: TargetResolverOptions = {}): TargetResolver {
  const resolve = o.resolve ?? validateAndResolve;
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 60_000;
  const cache = new Map<string, { ip: string; ips: string[]; at: number }>();
  const inflight = new Map<string, Promise<{ ip: string; ips: string[] }>>();

  // Throws on a name that doesn't resolve or resolves into a blocked range;
  // both reach the caller as an error and nothing is cached.
  function lookup(url: string): Promise<{ ip: string; ips: string[] }> {
    let p = inflight.get(url);
    if (!p) {
      p = resolve(url)
        .then((r) => {
          const entry = { ip: r.ip, ips: r.ips ?? [r.ip], at: now() };
          cache.set(url, entry);
          return entry;
        })
        .finally(() => inflight.delete(url));
      inflight.set(url, p);
    }
    return p;
  }

  return {
    async currentIp(url, savedIp, onChange) {
      const hit = cache.get(url);
      const answer = hit && now() - hit.at <= ttl ? hit : await lookup(url);
      const ip = savedIp !== null && answer.ips.includes(savedIp) ? savedIp : answer.ip;
      if (ip !== savedIp) {
        // Saving is best-effort: the address passed validation, so a storage
        // error must not fail the request; the next lookup tries again.
        try {
          onChange?.(ip);
        } catch (e) {
          console.warn(`[gate] could not save the new outpost address ${ip}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return ip;
    },
  };
}

// Shared by the proxy and the transfer worker.
export const targetResolver = createTargetResolver();
