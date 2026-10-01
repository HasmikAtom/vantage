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
 * Fail closed: if the name can't be resolved (e.g. a Docker container being
 * recreated) the request errors. Falling back to the saved IP would send the
 * token to whichever machine now holds that address.
 */

import { validateAndResolve } from './net-policy.js';

export interface TargetResolverOptions {
  resolve?: (url: string) => Promise<{ ip: string }>;
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
  const cache = new Map<string, { ip: string; at: number }>();

  return {
    async currentIp(url, savedIp, onChange) {
      const hit = cache.get(url);
      let ip: string;
      if (hit && now() - hit.at <= ttl) {
        ip = hit.ip;
      } else {
        // Throws on a name that doesn't resolve or resolves into a blocked
        // range; both reach the caller as an error.
        ip = (await resolve(url)).ip;
        cache.set(url, { ip, at: now() });
      }
      if (ip !== savedIp) onChange?.(ip);
      return ip;
    },
  };
}

// Shared by the proxy and the transfer worker.
export const targetResolver = createTargetResolver();
