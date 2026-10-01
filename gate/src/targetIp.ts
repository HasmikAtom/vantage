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
 */

import { isBlockedIP, validateAndResolve } from './net-policy.js';

export interface TargetResolverOptions {
  resolve?: (url: string) => Promise<{ ip: string }>;
  isBlocked?: (ip: string) => boolean;
  now?: () => number;
  ttlMs?: number;
}

export interface TargetResolver {
  currentIp(url: string, savedIp: string | null, onChange?: (ip: string) => void): Promise<string>;
}

export function createTargetResolver(o: TargetResolverOptions = {}): TargetResolver {
  const resolve = o.resolve ?? validateAndResolve;
  const isBlocked = o.isBlocked ?? isBlockedIP;
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 60_000;
  const cache = new Map<string, { ip: string; at: number }>();

  return {
    async currentIp(url, savedIp, onChange) {
      const hit = cache.get(url);
      let ip: string;
      if (hit && now() - hit.at <= ttl) {
        ip = hit.ip;
      } else {
        try {
          ip = (await resolve(url)).ip;
        } catch (err) {
          const message = (err as Error).message;
          // A name that now points into a blocked range is an SSRF signal:
          // refuse rather than quietly using the old address.
          if (/blocked range/.test(message)) throw err;
          // A temporary DNS failure: keep using the last validated address.
          if (savedIp && !isBlocked(savedIp)) return savedIp;
          throw err;
        }
        cache.set(url, { ip, at: now() });
      }
      if (ip !== savedIp) onChange?.(ip);
      return ip;
    },
  };
}

// Shared by the proxy and the transfer worker.
export const targetResolver = createTargetResolver();
