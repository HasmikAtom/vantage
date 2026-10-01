/**
 * Name prefix for gate's session cookies (GATE_COOKIE_PREFIX).
 *
 * Browsers scope cookies by host, not port, so two Vantage stacks on one
 * address (e.g. the dev stack on :5173 and the main stack on :8088) would
 * share — and keep overwriting — one session cookie, logging the user out
 * of whichever they used last. Giving one of them its own prefix keeps the
 * logins apart. Unset keeps better-auth's default, so existing sessions
 * stay valid.
 */

export const DEFAULT_COOKIE_PREFIX = 'better-auth';

// Cookie-name-safe and short: letters, digits, '.', '_' and '-'.
const VALID = /^[A-Za-z0-9._-]{1,64}$/;

export function cookiePrefix(raw: string | undefined): string {
  const v = raw?.trim() ?? '';
  if (v === '') return DEFAULT_COOKIE_PREFIX;
  if (!VALID.test(v)) {
    throw new Error(`GATE_COOKIE_PREFIX must be 1-64 letters, digits, '.', '_' or '-' (got ${JSON.stringify(v)})`);
  }
  return v;
}
