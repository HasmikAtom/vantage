# ---- build stage ----
FROM golang:1.25-alpine AS builder
WORKDIR /src

COPY go.mod ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/vantage-api ./

# ---- runtime stage ----
# Needs smartctl (SMART), systemctl + dbus (services), tzdata (timestamps),
# ca-certificates (Cloudflare API HTTPS), docker CLI + compose plugin
# (Phase 5b stack management — `docker compose up/down/config`).
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      smartmontools \
      systemd \
      dbus \
      pciutils \
      ca-certificates \
      curl \
      gnupg \
      tzdata \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
 && chmod a+r /etc/apt/keyrings/docker.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/debian $(. /etc/os-release; echo $VERSION_CODENAME) stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      docker-ce-cli \
      docker-compose-plugin \
 && apt-get purge -y --auto-remove curl gnupg \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /out/vantage-api /usr/local/bin/vantage-api

# Monorepo version baked in at build time so /version can report it without
# needing the VERSION file at runtime. docker-compose passes this from the
# Makefile-read VANTAGE_VERSION; defaults to "dev" for ad-hoc builds.
ARG VANTAGE_VERSION=dev
ENV VANTAGE_VERSION=$VANTAGE_VERSION

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/vantage-api"]
CMD ["-addr=:8080"]
