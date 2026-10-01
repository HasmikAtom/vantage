import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { passkey } from '@better-auth/passkey';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from './env.js';
// Imported as a path-only reference at the top so the dependency graph is
// obvious; the actual lookup happens lazily inside the hook below to avoid
// a circular import (whitelist.ts pulls `db` and `UserRole` from this
// file). Using a dynamic require / lazy import keeps the cycle resolvable.

// Single-line structured audit log helper. Operator-grade (one self-hosted
// admin), not SIEM-grade — keep payloads tiny and never include passwords,
// tokens, session IDs, or cookies. See task 3 in audit.md §4.
function audit(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...details, ts: new Date().toISOString() }));
}

// Make sure the SQLite parent dir exists — better-sqlite3 errors otherwise.
mkdirSync(dirname(env.databasePath), { recursive: true });

const db = new Database(env.databasePath);
db.pragma('journal_mode = WAL');

// bootstrap_lock holds a single row that the first sign-up race winner
// claims. SQLite's INSERT OR IGNORE + db.transaction (BEGIN IMMEDIATE)
// makes the claim atomic across concurrent connections, so two parallel
// sign-ups on an empty DB cannot both win — the loser falls through to
// the normal whitelist gate, which (correctly) rejects them since no
// whitelist exists yet.
db.exec('CREATE TABLE IF NOT EXISTS bootstrap_lock (id INTEGER PRIMARY KEY)');

// claimBootstrap returns true exactly once across the lifetime of the
// database: for the first sign-up that wins the race. Every subsequent
// caller — including a concurrent racer that arrived microseconds
// later — gets false. The atomic primitive is SQLite's BEGIN IMMEDIATE
// transaction holding an exclusive write lock around the INSERT OR
// IGNORE, so racing connections serialize on the lock and only one
// observes changes === 1.
function claimBootstrap(): boolean {
  return db.transaction(() => {
    const r = db.prepare('INSERT OR IGNORE INTO bootstrap_lock (id) VALUES (1)').run();
    return r.changes === 1;
  })();
}

// Returns true once the very first user has been created. Used by
// /auth/_status in server.ts so the SPA knows whether to show the
// "create the admin account" flow or the regular sign-in flow.
export function isBootstrapped(): boolean {
  try {
    const row = db.prepare('SELECT COUNT(*) AS c FROM user').get() as { c: number } | undefined;
    return !!row && row.c > 0;
  } catch {
    // user table doesn't exist yet (pre-migration). Treat as not bootstrapped.
    return false;
  }
}

// Role enum stored on every user record. The first user created (bootstrap)
// becomes 'admin' via the create.before hook below; future invited users
// default to 'viewer' via additionalFields.defaultValue. Promotion happens
// through an admin-only UI in a later phase. See container-roadmap.md
// Decision 1 for the role → action mapping.
export type UserRole = 'viewer' | 'operator' | 'admin';

export const auth = betterAuth({
  database: db,
  basePath: env.basePath,
  secret: env.secret,
  baseURL: env.baseURL || undefined,
  trustedOrigins: env.trustedOrigins,

  // Extend the user schema with our role column. better-auth's migration
  // runner picks this up automatically on next startup. `input: false`
  // means the field is server-controlled — sign-up requests can't set it,
  // which is how we keep someone from POSTing { role: 'admin' } at the
  // bootstrap window. The first-user override happens in the hook below.
  user: {
    additionalFields: {
      role: {
        type: 'string',
        defaultValue: 'viewer',
        required: false,
        input: false,
      },
    },
  },

  // Built-in rate limiter (in-memory; single-host self-hosted, no Redis).
  // Tune here: window is in seconds. /sign-in/* covers email + social +
  // passkey; /sign-up/* is defence-in-depth on top of the bootstrap gate.
  rateLimit: {
    enabled: true,
    storage: 'memory',
    customRules: {
      '/sign-in/*': { window: 60, max: 5 },
      '/sign-up/*': { window: 60, max: 3 },
    },
  },

  // Explicitly pin cookie attributes rather than trusting better-auth's
  // version-dependent defaults. Secure follows NODE_ENV so dev over
  // http://localhost still gets a session; prod (behind nginx on the same
  // origin per vite.config.ts) is HTTPS-only.
  advanced: {
    useSecureCookies: env.isProduction,
    cookiePrefix: env.cookiePrefix,
    defaultCookieAttributes: {
      httpOnly: true,
      secure: env.isProduction,
      sameSite: 'lax',
      path: '/',
    },
  },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    // First sign-up bootstraps the admin and is auto-signed-in. Further
    // sign-ups get rejected by the hook below.
    autoSignIn: true,
  },

  socialProviders: {
    ...(env.github.clientId && env.github.clientSecret
      ? {
          github: {
            clientId: env.github.clientId,
            clientSecret: env.github.clientSecret,
          },
        }
      : {}),
    ...(env.google.clientId && env.google.clientSecret
      ? {
          google: {
            clientId: env.google.clientId,
            clientSecret: env.google.clientSecret,
          },
        }
      : {}),
  },

  plugins: [
    passkey({
      rpID: env.rpID,
      rpName: env.rpName,
    }),
  ],

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Single-admin bootstrap: the *first* user created is the admin.
          // Race-safe via claimBootstrap() — concurrent sign-ups on an
          // empty DB serialize on a SQLite write lock; only one ever
          // wins. The loser falls through to the whitelist gate below
          // (which will reject since no whitelist exists pre-bootstrap),
          // matching the UX of an over-eager double-click.
          if (claimBootstrap()) {
            return { data: { ...user, role: 'admin' } };
          }

          // After bootstrap, sign-ups are only allowed for emails the
          // admin has pre-authorised in `whitelisted_emails`. The lookup
          // applies to every create path: email/password sign-up, OAuth
          // (GitHub/Google) — anything that lands in this hook. Lazy
          // import here is intentional: whitelist.ts depends on the `db`
          // export from this file, so a top-level import would cycle.
          const { whitelistRoleFor } = await import('./whitelist.js');
          const role = whitelistRoleFor(user.email);
          if (!role) {
            throw new APIError('FORBIDDEN', {
              message: 'Email not authorized to sign up. Ask the admin to add it.',
            });
          }
          return { data: { ...user, role } };
        },
        after: async (user) => {
          audit('signup.success', { userId: user.id, email: user.email });
        },
      },
    },
    session: {
      create: {
        after: async (session) => {
          // Fires for both /sign-in/* and /sign-up/* (autoSignIn) — the
          // signup.success log already covered the latter, so we tag this
          // generically rather than trying to disambiguate.
          audit('signin.success', { userId: session.userId });
        },
      },
    },
  },

  // Request-level after-hook. Runs for every endpoint, including failure
  // paths (better-auth catches the APIError, populates ctx.context.returned,
  // then still invokes the after-hook). We use this for events that
  // databaseHooks can't observe: failed sign-ins (no session row created)
  // and passkey registration (no user/session row created).
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      const path = ctx.path;
      const returned = ctx.context.returned;
      const failed = isAPIError(returned);

      if (path === '/sign-in/email' && failed) {
        // ctx.body is the parsed signin payload; email is fine to log,
        // password obviously is not. Reason is the better-auth error code.
        const body = ctx.body as { email?: unknown } | undefined;
        const email = typeof body?.email === 'string' ? body.email : undefined;
        audit('signin.failure', { email, reason: returned.body?.code });
        return;
      }

      if (path === '/passkey/verify-registration' && !failed) {
        // verify-registration runs under freshSessionMiddleware, so the
        // user is already authenticated; ctx.context.session is set.
        const userId = ctx.context.session?.user?.id;
        audit('passkey.registered', { userId });
        return;
      }
    }),
  },
});

export { db };
