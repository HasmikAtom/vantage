# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Monorepo version baked into the SPA bundle as VITE_VANTAGE_VERSION so the
# About panel can read it via import.meta.env at runtime. docker-compose
# passes this from the Makefile-read VANTAGE_VERSION; defaults to "dev" for
# ad-hoc builds.
ARG VANTAGE_VERSION=dev
ENV VITE_VANTAGE_VERSION=$VANTAGE_VERSION

RUN npm run build

# ---- runtime stage ----
FROM nginx:1.27-alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
# Files placed under /etc/nginx/templates/*.template are envsubst-rendered to
# /etc/nginx/conf.d/* by the base image's 20-envsubst-on-templates.sh at boot.
# Only ${VAR} sequences matching real env vars are expanded; nginx's own
# $variables ($host, $remote_addr, …) are left alone because they are not env
# vars on the container.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
