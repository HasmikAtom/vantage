import { createAuthClient } from 'better-auth/react';
import { passkeyClient } from '@better-auth/passkey/client';

// Same-origin: in dev, Vite proxies /auth to the gate service. In prod,
// nginx routes /auth to it. Either way, the SPA just talks to itself.
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/auth',
  plugins: [passkeyClient()],
});

export const { useSession, signIn, signOut, signUp } = authClient;

// ---------------------------------------------------------------------------
// Roles — must stay in lock-step with auth/src/auth.ts::UserRole and
// outpost/main.go::role* constants.
// ---------------------------------------------------------------------------

export type UserRole = 'viewer' | 'operator' | 'admin';

const ROLE_RANK: Record<UserRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

// Fails closed on any unknown/missing value — the outpost does the same.
function validRole(v: unknown): UserRole {
  return v === 'admin' || v === 'operator' || v === 'viewer' ? v : 'viewer';
}

/**
 * Returns the current user's role, or 'viewer' if the session is unloaded
 * or the role field is missing. Default-deny ensures UI gates never grant
 * elevated controls during the brief loading window after page load.
 */
export function useCurrentRole(): UserRole {
  const session = useSession();
  const user = session.data?.user as { role?: unknown } | undefined;
  return validRole(user?.role);
}

/**
 * Returns true if the current user has at least the precedence of `min`.
 * Use this for UI gates:
 *
 *   const canControl = useCan('operator');
 *   <Button disabled={!canControl}>Stop</Button>
 *
 * Outpost enforcement remains the source of truth — this is for UX only.
 */
export function useCan(min: UserRole): boolean {
  const role = useCurrentRole();
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
