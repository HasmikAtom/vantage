# ---- build stage ----
# Use the full Debian-based node image so better-sqlite3 builds its native
# binding without issues. Final image is a smaller slim variant.
FROM node:22-bookworm AS builder
WORKDIR /src

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runner

# better-sqlite3's prebuilt native module needs libstdc++ — already present
# in bookworm-slim. ca-certificates is for OAuth callbacks over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /src/package.json ./package.json
COPY --from=builder /src/node_modules ./node_modules
COPY --from=builder /src/dist ./dist

# Monorepo version baked in at build time so /auth/version can report it
# without needing the VERSION file at runtime. docker-compose passes this
# from the Makefile-read VANTAGE_VERSION; defaults to "dev" for ad-hoc builds.
ARG VANTAGE_VERSION=dev
ENV VANTAGE_VERSION=$VANTAGE_VERSION

EXPOSE 3000
CMD ["node", "dist/server.js"]
