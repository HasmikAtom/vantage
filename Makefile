# Vantage — dev/prod orchestration.
#
# Dev:  hot-reloading outpost (air) + Vite HMR, sources bind-mounted.
# Prod: distroless Go binary + static Vite build served by nginx (proxies /api).

DOCKER         ?= docker
COMPOSE_DEV    := $(DOCKER) compose -f docker-compose.dev.yml
COMPOSE_PROD   := $(DOCKER) compose -f docker-compose.prod.yml
COMPOSE_PRIME  := $(DOCKER) compose -f docker-compose.prime.yml
COMPOSE_OUTPOST := $(DOCKER) compose -f docker-compose.outpost.yml

# Monorepo version — single source of truth in the VERSION file at the repo
# root. Exported so docker compose `${VANTAGE_VERSION}` substitutions and
# Dockerfile build-args pick it up. Falls back to "dev" if VERSION is missing
# (e.g. running directly from a non-release checkout).
VANTAGE_VERSION := $(shell cat VERSION 2>/dev/null || echo dev)

VANTAGE_PROD_PORT          ?= 8088
VANTAGE_DEV_PRIME_PORT     ?= 5173
VANTAGE_DEV_OUTPOST_PORT   ?= 8082

# Detect the box this runs on so trusted-origin / passkey-RP / canonical URL
# defaults are sensible on a fresh deploy with zero .env config. Override any
# of these with explicit values in .env if you want a different name surfaced
# to browsers (e.g. a public domain).
VANTAGE_HOSTNAME           ?= $(shell hostname 2>/dev/null)
VANTAGE_LAN_IP             ?= $(shell hostname -I 2>/dev/null | awk '{print $$1}')
export VANTAGE_PROD_PORT VANTAGE_DEV_PRIME_PORT VANTAGE_DEV_OUTPOST_PORT \
       VANTAGE_HOSTNAME VANTAGE_LAN_IP VANTAGE_VERSION

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# help
# ---------------------------------------------------------------------------
.PHONY: help
help:
	@echo "Vantage — Make targets"
	@echo
	@echo "Dev (sources bind-mounted, hot reload):"
	@echo "  make dev                build + run dev stack (foreground)"
	@echo "  make dev-up             same, detached"
	@echo "  make dev-down           stop dev stack"
	@echo "  make dev-build          rebuild dev images"
	@echo "  make dev-logs           follow dev logs"
	@echo "  make dev-restart        restart dev containers"
	@echo "  make dev-shell-outpost  shell into dev outpost container"
	@echo "  make dev-shell-prime    shell into dev prime container"
	@echo
	@echo "Prod (multi-stage, immutable images):"
	@echo "  make prod             build + run prod stack (detached)"
	@echo "  make prod-down        stop prod stack"
	@echo "  make prod-build       rebuild prod images"
	@echo "  make prod-logs        follow prod logs"
	@echo "  make prod-restart     restart prod containers"
	@echo "  make prod-ps          show prod containers"
	@echo
	@echo "Prime (gate + prime only — outposts register from elsewhere):"
	@echo "  Prime bundles prime (dashboard SPA) + gate (auth service) on the same host."
	@echo "  make prime          build + run prime stack (detached)"
	@echo "  make prime-down     stop prime stack"
	@echo "  make prime-build    rebuild prime images"
	@echo "  make prime-logs     follow prime logs"
	@echo "  make prime-restart  restart prime containers"
	@echo "  make prime-ps       show prime containers"
	@echo
	@echo "Outpost (outpost-only deploy on a remote host, registered from the dashboard):"
	@echo "  make outpost-up        build + run outpost (detached)"
	@echo "  make outpost-down      stop outpost stack"
	@echo "  make outpost-build     rebuild outpost image"
	@echo "  make outpost-logs      follow outpost logs"
	@echo "  Required env: VANTAGE_OUTPOST_TOKEN (paste into the dashboard's Add Server form)"
	@echo "  Optional env: VANTAGE_OUTPOST_BIND=100.64.0.5  VANTAGE_OUTPOST_PORT=8095"
	@echo
	@echo "Component-specific build:"
	@echo "  make outpost-dev-build / outpost-prod-build"
	@echo "  make prime-dev-build / prime-prod-build"
	@echo
	@echo "Housekeeping:"
	@echo "  make update           update this machine's stack(s) to the newest release"
	@echo "                         (checks keys first; TAG=vX.Y.Z to pin or roll back,"
	@echo "                          STACK=outpost|prime|prod to choose)"
	@echo "  make update-check     only check keys and .env, change nothing"
	@echo "  make ps               list dev + prod containers"
	@echo "  make clean            stop both stacks, remove their images + volumes"
	@echo
	@echo "Vars (override on the make CLI or via .env):"
	@echo "  VANTAGE_PROD_PORT=$(VANTAGE_PROD_PORT)           prod nginx   -> host"
	@echo "  VANTAGE_DEV_PRIME_PORT=$(VANTAGE_DEV_PRIME_PORT)      dev vite     -> host"
	@echo "  VANTAGE_DEV_OUTPOST_PORT=$(VANTAGE_DEV_OUTPOST_PORT)    dev outpost  -> host"
	@echo
	@echo "Host auto-detected (used as defaults for trusted-origin / RP ID):"
	@echo "  VANTAGE_HOSTNAME=$(VANTAGE_HOSTNAME)"
	@echo "  VANTAGE_LAN_IP=$(VANTAGE_LAN_IP)"

# ---------------------------------------------------------------------------
# dev
# ---------------------------------------------------------------------------
.PHONY: dev dev-up dev-down dev-build dev-logs dev-restart dev-shell-outpost dev-shell-prime
dev:
	$(COMPOSE_DEV) up --build

dev-up:
	$(COMPOSE_DEV) up --build -d

dev-down:
	$(COMPOSE_DEV) down

dev-build:
	$(COMPOSE_DEV) build

dev-logs:
	$(COMPOSE_DEV) logs -f

dev-restart:
	$(COMPOSE_DEV) restart

dev-shell-outpost:
	$(COMPOSE_DEV) exec outpost sh

dev-shell-prime:
	$(COMPOSE_DEV) exec prime sh

# ---------------------------------------------------------------------------
# prod
# ---------------------------------------------------------------------------
.PHONY: prod prod-up prod-down prod-build prod-logs prod-restart prod-ps
prod: prod-up

prod-up:
	$(COMPOSE_PROD) up --build -d
	@echo
	@echo "Prod stack up. Prime: http://localhost:$(VANTAGE_PROD_PORT)"

prod-down:
	$(COMPOSE_PROD) down

prod-build:
	$(COMPOSE_PROD) build

prod-logs:
	$(COMPOSE_PROD) logs -f

prod-restart:
	$(COMPOSE_PROD) restart

prod-ps:
	$(COMPOSE_PROD) ps

# ---------------------------------------------------------------------------
# prime (prime SPA + gate auth, no outpost — for multi-host deployments where
# every outpost lives on a different machine, registered from the dashboard)
# ---------------------------------------------------------------------------
.PHONY: prime prime-up prime-down prime-build prime-logs prime-restart prime-ps
prime: prime-up

prime-up:
	$(COMPOSE_PRIME) up --build -d
	@echo
	@echo "Prime up. Dashboard: http://localhost:$(VANTAGE_PROD_PORT)"
	@echo "Run \`make outpost-up\` on each box you want to monitor, then"
	@echo "register it from the dashboard's Servers panel."

prime-down:
	$(COMPOSE_PRIME) down

prime-build:
	$(COMPOSE_PRIME) build

prime-logs:
	$(COMPOSE_PRIME) logs -f

prime-restart:
	$(COMPOSE_PRIME) restart

prime-ps:
	$(COMPOSE_PRIME) ps

# ---------------------------------------------------------------------------
# outpost (outpost-only — runs on a remote host, registered from the dashboard)
# ---------------------------------------------------------------------------
.PHONY: outpost-up outpost-down outpost-build outpost-logs outpost-restart outpost-ps
outpost-up:
	$(COMPOSE_OUTPOST) up --build -d
	@echo
	@echo "Outpost up. Register it in the dashboard's Servers panel:"
	@echo "  URL: http://$(or $(VANTAGE_OUTPOST_BIND),0.0.0.0):$(or $(VANTAGE_OUTPOST_PORT),8095)"

outpost-down:
	$(COMPOSE_OUTPOST) down

outpost-build:
	$(COMPOSE_OUTPOST) build

outpost-logs:
	$(COMPOSE_OUTPOST) logs -f

outpost-restart:
	$(COMPOSE_OUTPOST) restart

outpost-ps:
	$(COMPOSE_OUTPOST) ps

# ---------------------------------------------------------------------------
# per-service builds (useful for CI cache reuse)
# ---------------------------------------------------------------------------
.PHONY: outpost-dev-build outpost-prod-build prime-dev-build prime-prod-build
outpost-dev-build:
	$(COMPOSE_DEV)  build outpost

outpost-prod-build:
	$(COMPOSE_PROD) build outpost

prime-dev-build:
	$(COMPOSE_DEV)  build prime

prime-prod-build:
	$(COMPOSE_PROD) build prime

# ---------------------------------------------------------------------------
# misc
# ---------------------------------------------------------------------------
.PHONY: update update-check
# Move a deployment checkout to the newest release tag and rebuild the
# stack(s) running here, after checking the keys (see scripts/update.sh).
update:
	@bash scripts/update.sh

update-check:
	@bash scripts/update.sh --check-only

.PHONY: ps clean
ps:
	@echo "== dev =="
	@$(COMPOSE_DEV)  ps || true
	@echo
	@echo "== prod =="
	@$(COMPOSE_PROD) ps || true
	@echo
	@echo "== prime =="
	@$(COMPOSE_PRIME) ps || true

clean:
	-$(COMPOSE_DEV)   down -v --rmi local
	-$(COMPOSE_PROD)  down -v --rmi local
	-$(COMPOSE_PRIME) down -v --rmi local
