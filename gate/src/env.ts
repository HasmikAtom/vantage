/**
 * Single source of truth for environment configuration.
 * Throws at startup if a required-for-production value is missing.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  port: parseInt(optional('PORT', '3000'), 10),
  databasePath: optional('AUTH_DB_PATH', './data/auth.db'),
  basePath: optional('AUTH_BASE_PATH', '/auth'),

  // 'production' / 'development' / 'test'. Drives whether session cookies
  // are flagged Secure: dev over http://localhost would otherwise drop them.
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',

  secret: required('BETTER_AUTH_SECRET'),
  baseURL: optional('BETTER_AUTH_URL'),

  // AES-256-GCM key for encrypting per-server backend tokens stored in the
  // registry. Must be a 32-byte secret, base64-encoded. Generate with:
  //   openssl rand -base64 32
  // Rotation invalidates every stored token; admins must re-enter each
  // server's token afterwards.
  registryKey: required('VANTAGE_REGISTRY_KEY'),

  trustedOrigins: optional('TRUSTED_ORIGINS', 'http://localhost:8088,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Passkey relying party — must match the origin host the user sees.
  rpID: optional('AUTH_RP_ID', 'localhost'),
  rpName: optional('AUTH_RP_NAME', 'Vantage'),

  github: {
    clientId: optional('GITHUB_CLIENT_ID'),
    clientSecret: optional('GITHUB_CLIENT_SECRET'),
  },
  google: {
    clientId: optional('GOOGLE_CLIENT_ID'),
    clientSecret: optional('GOOGLE_CLIENT_SECRET'),
  },
};

// Loud startup warning when AUTH_RP_ID is left at its 'localhost' default
// in a production deploy. Passkey REGISTRATION silently binds to whatever
// rpID is active at enrollment time, so a wrong value here means every
// passkey users register is bound to 'localhost' and unusable from any
// real hostname — they'd need to re-enroll every key once it's fixed.
// Emit on the way out of this module so it shows up before any handler
// runs (and at-most-once because the module is cached).
if (env.isProduction && env.rpID === 'localhost') {
  // eslint-disable-next-line no-console
  console.warn(
    [
      '',
      '************************************************************',
      'WARNING: AUTH_RP_ID is "localhost" in production.',
      'Passkeys registered now will be bound to localhost and will',
      'NOT work from your real dashboard hostname. Set AUTH_RP_ID',
      'to the hostname users see in their browser BEFORE any user',
      'enrolls a passkey.',
      '************************************************************',
      '',
    ].join('\n'),
  );
}
