// Baked into the bundle by Vite from VITE_VANTAGE_VERSION (set in the
// builder stage of prime/Dockerfile from the ARG VANTAGE_VERSION, which
// docker-compose passes from the Makefile-read VERSION file). Falls back to
// "dev" for ad-hoc local runs (`npm run dev` outside Docker, etc.).
export const PRIME_VERSION = import.meta.env.VITE_VANTAGE_VERSION ?? 'dev';
