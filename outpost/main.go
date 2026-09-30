package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	tokenHeader = "X-Vantage-Outpost-Token"
	roleHeader  = "X-Vantage-Role"

	// Audit declaration headers. Handlers set these BEFORE any branch (role
	// deny, validation error, success). The gate proxy reads them out of the
	// upstream response and writes one audit row per declared action, then
	// strips the headers before returning to the SPA — they're an internal
	// control-plane contract, not user-facing data.
	auditActionHeader = "X-Vantage-Audit-Action"
	auditTargetHeader = "X-Vantage-Audit-Target"
)

// Role precedence. Stays in lock-step with auth.ts::UserRole. The gate
// service is the only caller that can reach us (proxy + outpost token), so
// trusting this header is acceptable — but we fail closed on an unknown or
// missing value rather than guessing.
const (
	roleViewer   = "viewer"
	roleOperator = "operator"
	roleAdmin    = "admin"
)

var roleRank = map[string]int{
	roleViewer:   1,
	roleOperator: 2,
	roleAdmin:    3,
}

// roleAtLeast returns true when `got` has at least the precedence of `min`.
// Unknown/empty `got` is treated as no role (rank 0) and always denied.
func roleAtLeast(min, got string) bool {
	return roleRank[got] >= roleRank[min]
}

// requireRole wraps a handler with a role check based on the proxy-supplied
// X-Vantage-Role header. The gate service strips any client-supplied value
// before forwarding, so this header reflects the authenticated user's role.
// Returns 403 with a small JSON body if the caller is below `min`.
func requireRole(min string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get(roleHeader)
		if !roleAtLeast(min, got) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		next(w, r)
	}
}

var (
	manager      = NewManager()
	outpostToken = os.Getenv("VANTAGE_OUTPOST_TOKEN")
)

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Printf("encode: %v", err)
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// vantageVersion returns the monorepo version baked into the image at build
// time (ARG VANTAGE_VERSION → ENV VANTAGE_VERSION). Falls back to "dev" for
// bare-metal runs where the binary was built without the build-arg set.
func vantageVersion() string {
	if v := os.Getenv("VANTAGE_VERSION"); v != "" {
		return v
	}
	return "dev"
}

// requireToken enforces the shared-secret header on every request.
// outpostToken is required at startup; we never reach here with it empty.
func requireToken(next http.Handler) http.Handler {
	want := []byte(outpostToken)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := []byte(r.Header.Get(tokenHeader))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			writeErr(w, http.StatusUnauthorized, "invalid outpost token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// dashboardHandler builds the /dashboard endpoint against an explicit
// Manager. Conditional GET: each refresh bumps Manager.version under m.mu,
// which we expose as a weak ETag (W/"<n>"). With 2s client-side polling
// most ticks land on the same version the client already has and the
// handler short-circuits to 304.
//
// Cache-Control: "no-cache" instead of "no-store" — we *want* the client to
// keep the previous body so it can revalidate against our ETag. no-store
// would forbid storage and defeat conditional GETs (including on 304s,
// where stripping storage would be incoherent).
//
// The ETag is "weak" because we promise "same logical representation", not
// byte-identity — JSON encoder output isn't pinned across runs.
func dashboardHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		snap, version := m.SnapshotWithVersion()
		etag := fmt.Sprintf(`W/"%d"`, version)
		if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
			w.Header().Set("ETag", etag)
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", etag)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(snap); err != nil {
			log.Printf("encode: %v", err)
		}
	}
}

// Default graceful-stop timeout in seconds. Docker sends SIGTERM, waits this
// long for the process to exit, then escalates to SIGKILL. Matches the
// `docker stop` CLI default; per-request override is a future enhancement
// (e.g. a "?t=30" passthrough on the SPA's stop button).
const defaultStopTimeoutSecs = 10

// containerCommandHandler runs start/stop/restart against the Manager's
// docker client. Each registration binds one action — the action name doubles
// as the audit log entry — so the handler stays tiny and Go 1.22's enhanced
// mux extracts {id} from the path for free.
//
// Order matters inside this handler:
//  1. Set audit headers BEFORE any deny path so the proxy logs every
//     attempt (allowed or denied) under the right action.
//  2. Role check next — denying still produces an audit row at the proxy
//     because step 1 already declared the action.
//  3. Validation / execution.
//
// On success the handler returns 202 Accepted and fast-pokes refreshMedium
// so the SSE stream pushes the new container state within ~1s instead of
// waiting for the next 15s tick. The body is a small JSON ack; the UI
// reconciles from the SSE stream, not from this response.
func containerCommandHandler(m *Manager, action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		w.Header().Set(auditActionHeader, "container."+action)
		w.Header().Set(auditTargetHeader, id)

		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		if id == "" {
			writeErr(w, http.StatusBadRequest, "missing container id")
			return
		}

		// Bound the docker call to 30s. stop/restart with t=10 takes up to
		// ~12s in the worst case (SIGTERM grace + SIGKILL + state settle);
		// 30s is comfortable headroom without leaving a wedged handler open
		// indefinitely if the docker socket itself hangs.
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		var err error
		switch action {
		case "start":
			err = m.docker.startContainer(ctx, id)
		case "stop":
			err = m.docker.stopContainer(ctx, id, defaultStopTimeoutSecs)
		case "restart":
			err = m.docker.restartContainer(ctx, id, defaultStopTimeoutSecs)
		default:
			writeErr(w, http.StatusInternalServerError, "unknown action")
			return
		}

		if err != nil {
			if errors.Is(err, ErrDockerNotFound) {
				writeErr(w, http.StatusNotFound, "container not found")
				return
			}
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}

		// Fast-poke: refresh the docker collector now so the SSE stream
		// surfaces the new state without waiting for the medium tick. Runs
		// in its own goroutine with a fresh context — refreshMedium can
		// outlive this HTTP request.
		m.RequestRefreshMedium()

		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "action": action, "id": id})
	}
}

var validRestartPolicies = map[string]bool{
	"":                true,
	"no":              true,
	"on-failure":      true,
	"always":          true,
	"unless-stopped":  true,
}

// containerCreateHandler runs the create-and-start flow for a single
// container. Order:
//  1. Set audit headers (action=container.create, target=image initially).
//  2. Role gate.
//  3. Decode + validate the request body.
//  4. Pull the image if it isn't local (blocking; bounded by ctx).
//  5. POST /containers/create to docker, then POST /start.
//  6. Update audit target to the new container ID and respond 201.
//
// The whole call can take minutes for a cold pull; the gate proxy carves
// out a longer upstream timeout for this path. UI shows a "Pulling…"
// pending state while the request is open.
//
// Failure cleanup: if we create the container but fail to start it, we
// best-effort remove the dead container so the user doesn't end up with
// half-built rubble. Failures DURING create (bad name, bad image) need no
// cleanup since nothing was made.
func containerCreateHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "container.create")

		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}

		var req CreateContainerRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		req.Image = strings.TrimSpace(req.Image)
		req.Name = strings.TrimSpace(req.Name)
		if req.Image == "" {
			writeErr(w, http.StatusBadRequest, "image is required")
			return
		}
		// Set the audit target up front to the image string, since we don't
		// have a container ID yet. We'll overwrite with the real ID after
		// create succeeds.
		w.Header().Set(auditTargetHeader, req.Image)

		if _, ok := validRestartPolicies[req.RestartPolicy]; !ok {
			writeErr(w, http.StatusBadRequest, "invalid restartPolicy")
			return
		}
		for _, p := range req.Ports {
			if p.ContainerPort < 1 || p.ContainerPort > 65535 {
				writeErr(w, http.StatusBadRequest, "container port out of range")
				return
			}
			if p.HostPort < 0 || p.HostPort > 65535 {
				writeErr(w, http.StatusBadRequest, "host port out of range")
				return
			}
			if p.Protocol != "" && p.Protocol != "tcp" && p.Protocol != "udp" {
				writeErr(w, http.StatusBadRequest, "protocol must be tcp or udp")
				return
			}
		}
		for _, mnt := range req.Mounts {
			if strings.TrimSpace(mnt.HostPath) == "" || strings.TrimSpace(mnt.ContainerPath) == "" {
				writeErr(w, http.StatusBadRequest, "mount paths cannot be empty")
				return
			}
		}

		// Allow up to 5 minutes for the whole create flow (image pull is the
		// long part on a cold registry). Caller's r.Context() is the floor —
		// if the SPA disconnects we abort the pull and bail.
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()

		exists, err := m.docker.imageExists(ctx, req.Image)
		if err != nil {
			writeErr(w, http.StatusBadGateway, "image check: "+err.Error())
			return
		}
		if !exists {
			if err := m.docker.pullImage(ctx, req.Image); err != nil {
				writeErr(w, http.StatusBadGateway, err.Error())
				return
			}
		}

		body := buildCreateBody(req)
		id, warnings, err := m.docker.createContainer(ctx, req.Name, body)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		// Update audit target now that we have a real container ID.
		w.Header().Set(auditTargetHeader, id)

		if err := m.docker.startContainer(ctx, id); err != nil {
			// Best-effort cleanup of the dead container we just made — leave
			// no rubble. Use background ctx so an aborted request doesn't
			// skip cleanup, and force=true since the container may be in a
			// half-created state.
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
			_ = m.docker.removeContainer(cleanupCtx, id, true, true)
			cleanupCancel()
			writeErr(w, http.StatusBadGateway, "start: "+err.Error())
			return
		}

		// Fast-poke: refresh collector so the new container appears in the
		// SSE snapshot within ~1s instead of waiting for the medium tick.
		m.RequestRefreshMedium()

		writeJSONStatus(w, http.StatusCreated, CreateContainerResponse{
			ID:       id,
			Name:     req.Name,
			Warnings: warnings,
		})
	}
}

// buildCreateBody projects our friendly request shape into the Docker API
// body. PortBindings + ExposedPorts have to be kept in sync — Docker treats
// ExposedPorts as the "what the image declares" set and PortBindings as
// "host-side bindings"; published ports need both entries to actually work.
func buildCreateBody(req CreateContainerRequest) dockerCreateBody {
	body := dockerCreateBody{
		Image: req.Image,
		Cmd:   req.Cmd,
		Env:   req.Env,
	}
	body.HostConfig.RestartPolicy.Name = req.RestartPolicy

	if len(req.Ports) > 0 {
		body.ExposedPorts = map[string]struct{}{}
		body.HostConfig.PortBindings = map[string][]dockerPortBinding{}
		for _, p := range req.Ports {
			proto := p.Protocol
			if proto == "" {
				proto = "tcp"
			}
			key := fmt.Sprintf("%d/%s", p.ContainerPort, proto)
			body.ExposedPorts[key] = struct{}{}
			if p.HostPort > 0 {
				body.HostConfig.PortBindings[key] = []dockerPortBinding{{
					HostIP:   "0.0.0.0",
					HostPort: fmt.Sprintf("%d", p.HostPort),
				}}
			}
		}
	}

	if len(req.Mounts) > 0 {
		body.HostConfig.Binds = make([]string, 0, len(req.Mounts))
		for _, m := range req.Mounts {
			mode := "rw"
			if m.ReadOnly {
				mode = "ro"
			}
			body.HostConfig.Binds = append(body.HostConfig.Binds,
				fmt.Sprintf("%s:%s:%s", m.HostPath, m.ContainerPath, mode))
		}
	}
	return body
}

// writeJSONStatus is like writeJSON but with an explicit status code.
// Used here for 201 Created; writeJSON always emits 200.
func writeJSONStatus(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Printf("encode: %v", err)
	}
}

// containerRemoveHandler deletes a container. Two interesting params:
//
//	force=true   → SIGKILL a running container before removal (Docker would
//	               otherwise return 409 "you cannot remove a running container").
//	volumes=true → also remove anonymous volumes attached to the container.
//	               Named volumes are left alone — those are independent objects.
//
// Audit headers declared up front so even denied attempts (insufficient role,
// invalid ID) and conflicts (running, force=false) generate an audit row at
// the proxy. The action name stays "container.remove" regardless of outcome —
// status field on the audit row carries ok / denied / error.
func containerRemoveHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		w.Header().Set(auditActionHeader, "container.remove")
		w.Header().Set(auditTargetHeader, id)

		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		if id == "" {
			writeErr(w, http.StatusBadRequest, "missing container id")
			return
		}
		force := r.URL.Query().Get("force") == "true"
		removeVolumes := r.URL.Query().Get("volumes") == "true"

		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		err := m.docker.removeContainer(ctx, id, force, removeVolumes)
		if err != nil {
			switch {
			case errors.Is(err, ErrDockerNotFound):
				writeErr(w, http.StatusNotFound, "container not found")
			case errors.Is(err, ErrContainerRunning):
				// 409 lets the UI surface "container is running" → second
				// confirm dialog offering force=true. We deliberately do NOT
				// silently force-kill; that's a separate, more dangerous
				// decision the user makes.
				writeErr(w, http.StatusConflict, "container is running; pass force=true to remove anyway")
			default:
				writeErr(w, http.StatusBadGateway, err.Error())
			}
			return
		}
		// Fast-poke: refresh the docker collector now so the removed
		// container drops out of the SSE snapshot within ~1s.
		m.RequestRefreshMedium()
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "action": "remove", "id": id})
	}
}

// containerInspectHandler returns the full docker-inspect view for one
// container. Gated to operator+ because env vars routinely carry secrets
// (DB passwords, API tokens, etc.) — same rationale as the logs gate in
// container-roadmap.md Decision 1.
//
// No audit row: reads aren't audited under the current scope; the audit
// table is reserved for actions that change state.
func containerInspectHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		id := r.PathValue("id")
		if id == "" {
			writeErr(w, http.StatusBadRequest, "missing container id")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		view, err := m.docker.inspectContainer(ctx, id)
		if err != nil {
			if errors.Is(err, ErrDockerNotFound) {
				writeErr(w, http.StatusNotFound, "container not found")
				return
			}
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, view)
	}
}

// ---------------------------------------------------------------------------
// Reclaim — list + bulk-delete + build-cache prune
// ---------------------------------------------------------------------------
//
// Pattern per category:
//   GET  /api/reclaim/{kind}        list current reclaimables
//   POST /api/reclaim/{kind}        bulk-delete by id/name; per-item result
//
// Plus the build-cache special case (no list, no per-item):
//   POST /api/reclaim/build-cache   docker build prune
//
// All write endpoints are operator+ gated and audited. The list endpoints
// don't need a role gate beyond authentication (same as the dashboard
// snapshot — info you can already see via the disk-usage cards).

func reclaimListImagesHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		out, err := m.docker.listReclaimableImages(ctx)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, out)
	}
}

func reclaimListContainersHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		out, err := m.docker.listReclaimableContainers(ctx)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, out)
	}
}

func reclaimListVolumesHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		out, err := m.docker.listReclaimableVolumes(ctx)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, out)
	}
}

// applyReclaim is the shared bulk-delete loop used by all three list-able
// kinds. `del(ctx, id) error` is the per-item deleter — caller passes
// removeImage / removeContainer / removeVolume bound with the right flags.
// Maps ErrDockerNotFound → "skipped" (already gone), ErrImageInUse /
// ErrVolumeInUse → "skipped: in use", everything else → "error".
func applyReclaim(ctx context.Context, ids []string, del func(context.Context, string) error) ReclaimResult {
	res := ReclaimResult{Items: make([]ReclaimItemResult, 0, len(ids))}
	for _, id := range ids {
		// Each delete gets its own 30s budget — independent of how many
		// are queued so one slow item doesn't punish the rest.
		itemCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := del(itemCtx, id)
		cancel()
		switch {
		case err == nil:
			res.Items = append(res.Items, ReclaimItemResult{ID: id, Status: "ok"})
			res.SuccessCount++
		case errors.Is(err, ErrDockerNotFound):
			res.Items = append(res.Items, ReclaimItemResult{ID: id, Status: "skipped", Error: "already gone"})
			res.SkippedCount++
		case errors.Is(err, ErrImageInUse), errors.Is(err, ErrVolumeInUse), errors.Is(err, ErrContainerRunning):
			res.Items = append(res.Items, ReclaimItemResult{ID: id, Status: "skipped", Error: "in use"})
			res.SkippedCount++
		default:
			res.Items = append(res.Items, ReclaimItemResult{ID: id, Status: "error", Error: err.Error()})
			res.ErrorCount++
		}
	}
	return res
}

func reclaimApplyImagesHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "reclaim.images")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		var req ReclaimRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if len(req.IDs) == 0 {
			writeErr(w, http.StatusBadRequest, "no ids provided")
			return
		}
		w.Header().Set(auditTargetHeader, summarizeIDs(req.IDs))

		// 5-minute global ceiling on the whole batch; individual items
		// have their own per-call 30s budget inside applyReclaim.
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		res := applyReclaim(ctx, req.IDs, func(c context.Context, id string) error {
			// force=true because the user explicitly selected these as
			// reclaimable; docker's "image is tagged twice, requires force"
			// 409 isn't a meaningful protection here.
			return m.docker.removeImage(c, id, true)
		})
		m.RequestRefreshMedium()
		writeJSON(w, res)
	}
}

func reclaimApplyContainersHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "reclaim.containers")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		var req ReclaimRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if len(req.IDs) == 0 {
			writeErr(w, http.StatusBadRequest, "no ids provided")
			return
		}
		w.Header().Set(auditTargetHeader, summarizeIDs(req.IDs))

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		res := applyReclaim(ctx, req.IDs, func(c context.Context, id string) error {
			// force=false: stopped containers don't need it, and an
			// unexpectedly-running one becoming "in use" via the 409 path
			// is the correct conservative outcome.
			return m.docker.removeContainer(c, id, false, false)
		})
		m.RequestRefreshMedium()
		writeJSON(w, res)
	}
}

func reclaimApplyVolumesHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "reclaim.volumes")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		var req ReclaimRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if len(req.IDs) == 0 {
			writeErr(w, http.StatusBadRequest, "no names provided")
			return
		}
		w.Header().Set(auditTargetHeader, summarizeIDs(req.IDs))

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		res := applyReclaim(ctx, req.IDs, func(c context.Context, name string) error {
			return m.docker.removeVolume(c, name, false)
		})
		m.RequestRefreshMedium()
		writeJSON(w, res)
	}
}

func reclaimBuildCacheHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "reclaim.build_cache")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		freed, err := m.docker.pruneBuildCache(ctx)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		m.RequestRefreshMedium()
		writeJSON(w, ReclaimResult{FreedBytes: freed, SuccessCount: 1})
	}
}

// summarizeIDs builds a short audit-target string for the headers. Full
// ID lists can blow past sane header sizes; we cap to first 3 IDs +
// count. Reading the audit table is the place to get the full picture,
// not the header.
func summarizeIDs(ids []string) string {
	const maxIDLen = 12
	const maxShow = 3
	parts := make([]string, 0, maxShow)
	for i, id := range ids {
		if i >= maxShow {
			break
		}
		if len(id) > maxIDLen {
			id = id[:maxIDLen]
		}
		parts = append(parts, id)
	}
	if len(ids) > maxShow {
		parts = append(parts, fmt.Sprintf("+%d more", len(ids)-maxShow))
	}
	return strings.Join(parts, ",")
}

// ---------------------------------------------------------------------------
// Stacks (docker-compose) endpoints
// ---------------------------------------------------------------------------
//
// CRUD over compose stacks. Each stack is one directory under
// <VANTAGE_DATA_DIR>/stacks/ holding a docker-compose.yml. Five endpoints:
//
//   GET    /api/stacks         list
//   POST   /api/stacks         create + up
//   GET    /api/stacks/{name}  read YAML + member containers
//   PUT    /api/stacks/{name}  replace YAML + up (reconcile)
//   DELETE /api/stacks/{name}  down + remove dir
//
// All writes are gated to operator+ and audited. Validation via
// `docker compose config` runs BEFORE persistence, so a malformed file
// never lands on disk.

// stackContainersBy returns the subset of the live container snapshot whose
// compose-project label matches `name`. Reads from the existing collector
// snapshot — no extra docker call.
func stackContainersBy(m *Manager, name string) []Container {
	snap := m.Snapshot()
	out := []Container{}
	for _, c := range snap.Containers {
		if c.Stack == name {
			out = append(out, c)
		}
	}
	return out
}

func stacksListHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Reads gated to viewer+ — same as the dashboard snapshot.
		entries, err := listStacks()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}

		// Walk the live snapshot once to:
		//   (a) build a per-stack container count
		//   (b) capture working_dir for each discovered project (used in
		//       the row + detail view to show where the YAML lives on the
		//       host).
		snap := m.Snapshot()
		byStack := map[string]int{}
		workingDirByStack := map[string]string{}
		for _, c := range snap.Containers {
			if c.Stack == "" {
				continue
			}
			byStack[c.Stack]++
			// Keep the first non-empty working_dir we see; all members of
			// the same compose project should report the same path. If
			// they don't (mixed deploy?), the first wins — acceptable for
			// a v1 informational display.
			if workingDirByStack[c.Stack] == "" && c.StackWorkingDir != "" {
				workingDirByStack[c.Stack] = c.StackWorkingDir
			}
		}

		// Also stash the config_files label per project, so the discovered
		// branch below can stat the on-disk file to set HasFile.
		configFilesByStack := map[string]string{}
		for _, c := range snap.Containers {
			if c.Stack == "" {
				continue
			}
			if configFilesByStack[c.Stack] == "" && c.StackConfigFiles != "" {
				configFilesByStack[c.Stack] = c.StackConfigFiles
			}
		}

		managedNames := map[string]bool{}
		out := make([]StackSummary, 0, len(entries)+len(byStack))
		for _, e := range entries {
			managedNames[e.Name] = true
			out = append(out, StackSummary{
				Name:           e.Name,
				Kind:           "managed",
				UpdatedAt:      e.UpdatedAt.UTC().Format(time.RFC3339),
				ContainerCount: byStack[e.Name],
				HasFile:        true,
			})
		}
		// Discovered stacks: any compose project label not backed by a
		// file under our stacks dir. Sort for stable order alongside the
		// already-sorted managed entries.
		discovered := make([]string, 0, len(byStack))
		for name := range byStack {
			if !managedNames[name] {
				discovered = append(discovered, name)
			}
		}
		sort.Strings(discovered)
		for _, name := range discovered {
			// Stat the primary config_file path to decide HasFile.
			// Cheap on the file count we'd ever see (one stat per stack).
			hasFile := false
			if files := parseConfigFiles(configFilesByStack[name]); len(files) > 0 {
				if _, err := os.Stat(hostPath(files[0])); err == nil {
					hasFile = true
				}
			}
			out = append(out, StackSummary{
				Name:           name,
				Kind:           "discovered",
				WorkingDir:     workingDirByStack[name],
				ContainerCount: byStack[name],
				HasFile:        hasFile,
			})
		}
		writeJSON(w, out)
	}
}

func stackGetHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !validStackName(name) {
			writeErr(w, http.StatusBadRequest, "invalid stack name")
			return
		}
		members := stackContainersBy(m, name)

		// Managed: file on disk, treat as canonical source.
		if yaml, err := readStackYAML(name); err == nil {
			entries, _ := listStacks()
			var updated string
			for _, e := range entries {
				if e.Name == name {
					updated = e.UpdatedAt.UTC().Format(time.RFC3339)
					break
				}
			}
			writeJSON(w, Stack{
				Name:       name,
				Kind:       "managed",
				UpdatedAt:  updated,
				YAML:       yaml,
				Containers: members,
			})
			return
		} else if !errors.Is(err, ErrStackNotFound) {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}

		// Discovered: no managed file, but containers exist with this
		// project label. Try to load the YAML from the host via the
		// config_files label (compose's authoritative source of truth for
		// which file was used). If the file's gone, we still return the
		// stack — just with empty YAML — so the UI can surface a clear
		// "compose file missing" message instead of hiding the stack.
		if len(members) > 0 {
			workingDir := ""
			configFiles := ""
			for _, c := range members {
				if c.StackWorkingDir != "" && workingDir == "" {
					workingDir = c.StackWorkingDir
				}
				if c.StackConfigFiles != "" && configFiles == "" {
					configFiles = c.StackConfigFiles
				}
			}
			yaml := ""
			if y, _, readErr := readDiscoveredYAML(configFiles, r.Header.Get(roleHeader)); readErr == nil {
				yaml = y
			}
			writeJSON(w, Stack{
				Name:       name,
				Kind:       "discovered",
				WorkingDir: workingDir,
				YAML:       yaml,
				Containers: members,
			})
			return
		}

		writeErr(w, http.StatusNotFound, "stack not found")
	}
}

func stackCreateHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "stack.create")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}

		var req StackCreateRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512<<10)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		req.Name = strings.TrimSpace(req.Name)
		w.Header().Set(auditTargetHeader, req.Name)
		if !validStackName(req.Name) {
			writeErr(w, http.StatusBadRequest, "invalid stack name (use [a-z0-9_-], max 64 chars)")
			return
		}
		if strings.TrimSpace(req.YAML) == "" {
			writeErr(w, http.StatusBadRequest, "yaml is required")
			return
		}
		if stackExists(req.Name) {
			writeErr(w, http.StatusConflict, "stack already exists")
			return
		}

		if err := writeStackYAML(req.Name, req.YAML); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		composePath, _ := stackComposePath(req.Name)

		// Validate against the freshly-written file. On failure roll back
		// the directory so a half-created stack doesn't linger.
		validateCtx, cancelV := context.WithTimeout(r.Context(), 30*time.Second)
		if err := composeValidate(validateCtx, composePath); err != nil {
			cancelV()
			_ = removeStackDir(req.Name)
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		cancelV()

		// `compose up -d` pulls images + starts services. Allow up to 10
		// minutes — multi-service stacks with cold pulls can run long.
		upCtx, cancelU := context.WithTimeout(r.Context(), 10*time.Minute)
		defer cancelU()
		if err := composeUp(upCtx, req.Name, composePath); err != nil {
			// Don't auto-rollback the directory — the YAML is valid; the
			// failure might be transient (image not available, port
			// conflict). Leave the file so the user can fix and re-apply.
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}

		m.RequestRefreshMedium()

		writeJSONStatus(w, http.StatusCreated, map[string]any{
			"ok":   true,
			"name": req.Name,
		})
	}
}

func stackUpdateHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		w.Header().Set(auditActionHeader, "stack.update")
		w.Header().Set(auditTargetHeader, name)

		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		if !validStackName(name) {
			writeErr(w, http.StatusBadRequest, "invalid stack name")
			return
		}

		var req StackUpdateRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512<<10)).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if strings.TrimSpace(req.YAML) == "" {
			writeErr(w, http.StatusBadRequest, "yaml is required")
			return
		}

		// Branch on whether we have a managed file for this name. Both
		// branches do the same shape (write-temp → validate → promote →
		// compose up), just with different paths and project directories.
		if stackExists(name) {
			if err := updateManagedStack(r.Context(), m, name, req.YAML, w); err != nil {
				// updateManagedStack writes the error response itself
				return
			}
			return
		}

		// Not managed → look for a discovered stack with this name.
		members := stackContainersBy(m, name)
		if len(members) == 0 {
			writeErr(w, http.StatusNotFound, "stack not found")
			return
		}
		var workingDir, configFiles string
		for _, c := range members {
			if c.StackWorkingDir != "" && workingDir == "" {
				workingDir = c.StackWorkingDir
			}
			if c.StackConfigFiles != "" && configFiles == "" {
				configFiles = c.StackConfigFiles
			}
		}
		if workingDir == "" || configFiles == "" {
			writeErr(w, http.StatusBadRequest,
				"discovered stack: missing working_dir or config_files label, cannot locate the compose file on the host")
			return
		}
		// Resolve the primary host file path even when the existing file
		// is missing — we may be RESTORING a file that was deleted.
		hostFilePath := parseConfigFiles(configFiles)[0]
		updateDiscoveredStack(r.Context(), m, name, workingDir, hostFilePath, req.YAML, r.Header.Get(roleHeader), w)
	}
}

// updateManagedStack handles the managed path: file lives under our
// /data/stacks/<name>/ directory, compose project dir is that same dir.
// Returns nil on success (response already written) or an error sentinel
// to indicate the handler should stop (errors also already written).
func updateManagedStack(ctx context.Context, m *Manager, name, yaml string, w http.ResponseWriter) error {
	composePath, _ := stackComposePath(name)
	tmpPath := composePath + ".new"
	if err := os.WriteFile(tmpPath, []byte(yaml), 0o600); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return err
	}
	validateCtx, cancelV := context.WithTimeout(ctx, 30*time.Second)
	if err := composeValidate(validateCtx, tmpPath); err != nil {
		cancelV()
		_ = os.Remove(tmpPath)
		writeErr(w, http.StatusBadRequest, err.Error())
		return err
	}
	cancelV()
	if err := os.Rename(tmpPath, composePath); err != nil {
		_ = os.Remove(tmpPath)
		writeErr(w, http.StatusInternalServerError, err.Error())
		return err
	}
	upCtx, cancelU := context.WithTimeout(ctx, 10*time.Minute)
	defer cancelU()
	if err := composeUp(upCtx, name, composePath); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return err
	}
	m.RequestRefreshMedium()
	writeJSONStatus(w, http.StatusOK, map[string]any{"ok": true, "name": name})
	return nil
}

// updateDiscoveredStack handles the discovered path: file lives on the
// host at hostFilePath (e.g. /home/hasmik/.../docker-compose.yml).
// composeUpInDir uses --project-directory <hostWorkingDir> + -f <hostfsPath>
// so compose's relative-path resolution emits host paths the daemon
// understands.
//
// hostFilePath comes from a Docker container label (config_files), which
// is attacker-controllable by anyone who can run containers. Route the
// write through the openat2-anchored helpers so a crafted label cannot
// redirect at a denylisted file, outside the host root, or via a
// symlink swap mid-operation.
//
// composeValidate runs against the host-absolute path (it shells out to
// `docker compose` which needs the host path); the path was validated by
// safeWriteFile already, so passing it on for validation is safe.
func updateDiscoveredStack(ctx context.Context, m *Manager, name, hostWorkingDir, hostFilePath, yaml, role string, w http.ResponseWriter) {
	// Write the file atomically through the rooted handle. safeWriteFile
	// does temp-write + rename internally; the temp lives in the same
	// directory so we don't cross filesystems.
	if _, err := safeWriteFile(hostFilePath, role, []byte(yaml), 0o644); err != nil {
		// resolveSafeName errors are user-input issues; syscall errors
		// from inside safeWriteFile are server-side. Distinguish so the
		// client sees a useful status.
		if errors.Is(err, ErrPathDenied) || errors.Is(err, ErrAdminRequired) || errors.Is(err, ErrPathOutsideHost) {
			writeErr(w, http.StatusBadRequest, err.Error())
		} else {
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	// Validate the written file. If validation fails we leave the file
	// in place (the user will fix it and retry); we don't roll back to
	// the previous version because we never read it. This matches the
	// legacy behaviour.
	validateCtx, cancelV := context.WithTimeout(ctx, 30*time.Second)
	if err := composeValidate(validateCtx, hostPath(hostFilePath)); err != nil {
		cancelV()
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cancelV()
	upCtx, cancelU := context.WithTimeout(ctx, 10*time.Minute)
	defer cancelU()
	if err := composeUpInDir(upCtx, name, hostWorkingDir, hostFilePath); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	m.RequestRefreshMedium()
	writeJSONStatus(w, http.StatusOK, map[string]any{"ok": true, "name": name})
}

// stackDeriveHandler builds a fresh docker-compose.yml from a stack's
// member containers via docker inspect. Used by the UI's "Recreate as
// managed" flow when the original compose file is gone (so edit is
// impossible) — gives the user a starting YAML they can review, edit,
// and save as a new managed stack.
//
// Operator+ gated because env vars routinely carry secrets (same
// rationale as the inspect endpoint). Read-only — doesn't write or
// deploy anything; pure projection.
func stackDeriveHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		name := r.PathValue("name")
		if !validStackName(name) {
			writeErr(w, http.StatusBadRequest, "invalid stack name")
			return
		}
		members := stackContainersBy(m, name)
		if len(members) == 0 {
			writeErr(w, http.StatusNotFound, "stack not found")
			return
		}
		// 60s for the inspect loop — one docker call per member, usually
		// sub-second each, but a slow socket shouldn't be capped to the
		// generic 30s.
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		yaml, err := deriveComposeYAML(ctx, m.docker, name, members)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, map[string]string{"yaml": yaml})
	}
}

func stackDeleteHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		w.Header().Set(auditActionHeader, "stack.remove")
		w.Header().Set(auditTargetHeader, name)

		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		if !validStackName(name) {
			writeErr(w, http.StatusBadRequest, "invalid stack name")
			return
		}
		if !stackExists(name) {
			// Same logic as update: discovered stacks are read-only in v1.
			if len(stackContainersBy(m, name)) > 0 {
				writeErr(w, http.StatusBadRequest,
					"discovered stack: remove from the host shell (we don't own the compose file)")
				return
			}
			writeErr(w, http.StatusNotFound, "stack not found")
			return
		}
		removeVolumes := r.URL.Query().Get("volumes") == "true"

		composePath, _ := stackComposePath(name)
		// 5 minutes for `compose down` — usually quick but a stop-grace on
		// many services can add up.
		downCtx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()
		if err := composeDown(downCtx, name, composePath, removeVolumes); err != nil {
			// Don't remove the dir if compose down failed — the on-disk
			// file is the user's only handle to retry/diagnose. They can
			// fix the underlying issue and re-DELETE.
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		if err := removeStackDir(name); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		m.RequestRefreshMedium()
		writeJSONStatus(w, http.StatusOK, map[string]any{"ok": true, "name": name})
	}
}

// containerLogsHandler streams one container's stdout+stderr as SSE.
// Operator+ gated (env vars and stdout often carry secrets); audit-headed
// so each open shows up as a `container.logs` row at the proxy.
//
// Wire format per message:
//
//	id: <nanos>
//	data: {"stream":"stdout","line":"hello world","ts":"2026-05-18T..."}
//
// `id` is the line's wall-clock time in nanoseconds since epoch so a
// reconnecting client passes Last-Event-ID back and we resume from
// just after that point via docker's `since=<seconds.nanos>` param.
//
// Per-request write deadline disabled via ResponseController; the
// global srv.WriteTimeout would close the long-lived stream otherwise
// (same trick as the dashboard /stream endpoint).
func containerLogsHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "container.logs")
		id := r.PathValue("id")
		w.Header().Set(auditTargetHeader, id)

		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		if id == "" {
			writeErr(w, http.StatusBadRequest, "missing container id")
			return
		}

		// Inspect once to learn the TTY flag — the wire format depends on
		// it. The single extra docker call is cheap relative to the
		// long-lived stream that follows.
		inspectCtx, inspectCancel := context.WithTimeout(r.Context(), 5*time.Second)
		insp, err := m.docker.inspectContainer(inspectCtx, id)
		inspectCancel()
		if err != nil {
			if errors.Is(err, ErrDockerNotFound) {
				writeErr(w, http.StatusNotFound, "container not found")
				return
			}
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		// Tailing a stopped container is fine — docker returns the
		// historical logs and the stream closes immediately. Useful for
		// post-mortem debugging, so we don't gate on insp.State.Running.
		//
		// The TTY flag isn't surfaced in the inspect projection (only
		// State + Image + Mounts + Networks + a few others), but Docker's
		// /logs endpoint actually handles both wire formats transparently
		// when the container wasn't TTY-allocated. The handful of containers
		// that ARE TTY would be misparsed by the framed scanner; this is an
		// accepted limitation for v1 — TTY-allocated long-running services
		// are vanishingly rare.
		_ = insp

		// Parse opts from the URL.
		q := r.URL.Query()
		opts := LogStreamOpts{
			Follow: q.Get("follow") != "0", // default true
			Stdout: q.Get("stdout") != "0", // default true
			Stderr: q.Get("stderr") != "0", // default true
		}
		if tailStr := q.Get("tail"); tailStr != "" {
			if tailStr == "all" {
				opts.Tail = -1
			} else if n, err := strconv.Atoi(tailStr); err == nil {
				opts.Tail = n
			}
		}

		// Last-Event-ID resume: client sends the last seen nano timestamp
		// as Last-Event-ID; we hand docker a fractional `since=` so it
		// skips everything we already showed.
		if hdr := r.Header.Get("Last-Event-ID"); hdr != "" {
			if nanos, err := strconv.ParseInt(hdr, 10, 64); err == nil && nanos > 0 {
				opts.SinceSeconds = float64(nanos) / 1e9
				// When resuming we don't want to send the tail prefetch
				// again — the resume should be exactly the gap.
				opts.Tail = -1
			}
		}

		rc := http.NewResponseController(w)
		_ = rc.SetWriteDeadline(time.Time{})

		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		h.Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)

		// Keepalive comments every 25s so idle proxies don't drop the
		// connection between log lines (a quiet container would otherwise
		// look dead to nginx after its read timeout).
		keepalive := time.NewTicker(25 * time.Second)
		defer keepalive.Stop()
		stopKeepalive := make(chan struct{})
		go func() {
			for {
				select {
				case <-stopKeepalive:
					return
				case <-keepalive.C:
					_, _ = io.WriteString(w, ": keepalive\n\n")
					_ = rc.Flush()
				}
			}
		}()
		defer close(stopKeepalive)

		ctx := r.Context()
		err = m.docker.streamLogs(ctx, id, opts, func(line LogLine) error {
			// Encode as one JSON object per SSE message. The `ts` field is
			// the docker-emitted wall-clock time; the SSE id is the
			// nano-precision form so reconnects can resume exactly.
			ts := line.Timestamp
			if ts.IsZero() {
				ts = time.Now()
			}
			payload, _ := json.Marshal(map[string]string{
				"stream": line.Stream,
				"line":   line.Line,
				"ts":     ts.Format(time.RFC3339Nano),
			})
			if _, err := fmt.Fprintf(w, "id: %d\ndata: ", ts.UnixNano()); err != nil {
				return err
			}
			if _, err := w.Write(payload); err != nil {
				return err
			}
			if _, err := io.WriteString(w, "\n\n"); err != nil {
				return err
			}
			return rc.Flush()
		})
		if err != nil && !errors.Is(err, context.Canceled) {
			// Best effort: try to emit a final error frame. If the
			// connection is already torn we just bail.
			payload, _ := json.Marshal(map[string]string{
				"stream": "_error",
				"line":   err.Error(),
			})
			_, _ = fmt.Fprintf(w, "event: error\ndata: ")
			_, _ = w.Write(payload)
			_, _ = io.WriteString(w, "\n\n")
			_ = rc.Flush()
		}
	}
}

// streamHandler serves the snapshot as an SSE stream. The wire format is one
// "id: <version>\ndata: <json>\n\n" frame per push, plus periodic ": keepalive"
// comments to defeat idle proxies. The server pushes a frame only when the
// Manager's version actually advances — no traffic on truly idle ticks.
//
// Lifecycle:
//   - Subscribe BEFORE reading the initial snapshot so a version bump in the
//     gap leaves a pending signal that the select picks up next iteration.
//   - r.Context().Done() fires on client disconnect (handler returns, deferred
//     cancel removes us from the subscriber set).
//   - Last-Event-ID lets a reconnecting client skip the initial snapshot when
//     they already have the current version cached.
//
// The endpoint runs without a write deadline (ResponseController disables it
// per-request); the global srv.WriteTimeout would otherwise kill the
// long-lived connection within 15 seconds.
func streamHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}

		rc := http.NewResponseController(w)
		// SSE is long-lived. The global WriteTimeout would close us; clear it
		// for this request only. If the underlying ResponseWriter doesn't
		// support deadlines we keep going — the client will reconnect when
		// the server forcibly closes, which is the SSE contract anyway.
		_ = rc.SetWriteDeadline(time.Time{})

		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		// nginx buffers proxied responses by default; without this it would
		// hold the stream until its buffer fills and the browser sees
		// nothing for many seconds.
		h.Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)

		send := func(version uint64, payload []byte) error {
			if _, err := fmt.Fprintf(w, "id: %d\ndata: ", version); err != nil {
				return err
			}
			if _, err := w.Write(payload); err != nil {
				return err
			}
			if _, err := io.WriteString(w, "\n\n"); err != nil {
				return err
			}
			return rc.Flush()
		}

		// Resume: skip the initial snapshot if the client already has the
		// current version. The browser EventSource sends Last-Event-ID
		// automatically on auto-reconnect.
		var lastSeen uint64
		if hdr := r.Header.Get("Last-Event-ID"); hdr != "" {
			if v, err := strconv.ParseUint(hdr, 10, 64); err == nil {
				lastSeen = v
			}
		}

		sigCh, cancel := m.Subscribe()
		defer cancel()

		snap, version := m.SnapshotWithVersion()
		if version != lastSeen {
			buf, err := json.Marshal(snap)
			if err != nil {
				return
			}
			if err := send(version, buf); err != nil {
				return
			}
			lastSeen = version
		}

		keepalive := time.NewTicker(25 * time.Second)
		defer keepalive.Stop()

		ctx := r.Context()
		for {
			select {
			case <-ctx.Done():
				return
			case <-keepalive.C:
				if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
					return
				}
				if err := rc.Flush(); err != nil {
					return
				}
			case <-sigCh:
				snap, version := m.SnapshotWithVersion()
				if version == lastSeen {
					continue
				}
				buf, err := json.Marshal(snap)
				if err != nil {
					return
				}
				if err := send(version, buf); err != nil {
					return
				}
				lastSeen = version
			}
		}
	}
}

// localMux returns the handlers for this outpost's own monitoring data —
// the snapshot endpoints, settings, and Cloudflare refresh. The dashboard's
// gate-service proxy forwards calls here under the bare /api/* prefix
// (with the X-Vantage-Outpost-Token header attached server-side).
func localMux() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{
			"status":     "ok",
			"collectors": manager.Errors(),
		})
	})

	mux.HandleFunc("/version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{
			"service": "outpost",
			"version": vantageVersion(),
		})
	})

	mux.HandleFunc("/dashboard", dashboardHandler(manager))
	mux.HandleFunc("/stream", streamHandler(manager))

	mux.HandleFunc("/system", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, manager.Snapshot().System)
	})
	mux.HandleFunc("/headline", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, manager.Snapshot().Headline)
	})
	mux.HandleFunc("/sensors", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, manager.Snapshot().Sensors)
	})
	mux.HandleFunc("/disks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, manager.Snapshot().Disks)
	})
	mux.HandleFunc("/filesystems", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, manager.Snapshot().Filesystems)
	})
	mux.HandleFunc("/network", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, manager.Snapshot().Network)
	})
	mux.HandleFunc("/tunnels", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, manager.Snapshot().Tunnels)
	})
	mux.HandleFunc("/containers", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, manager.Snapshot().Containers)
	})
	// Container lifecycle commands. Go 1.22 enhanced mux pattern matches
	// method + path with an {id} placeholder retrieved via r.PathValue.
	mux.HandleFunc("POST /containers/{id}/start", containerCommandHandler(manager, "start"))
	mux.HandleFunc("POST /containers/{id}/stop", containerCommandHandler(manager, "stop"))
	mux.HandleFunc("POST /containers/{id}/restart", containerCommandHandler(manager, "restart"))
	mux.HandleFunc("GET /containers/{id}/inspect", containerInspectHandler(manager))
	mux.HandleFunc("DELETE /containers/{id}", containerRemoveHandler(manager))
	mux.HandleFunc("POST /containers", containerCreateHandler(manager))

	// Stacks (compose) — see container-roadmap.md Phase 5b.
	mux.HandleFunc("GET /stacks", stacksListHandler(manager))
	mux.HandleFunc("POST /stacks", stackCreateHandler(manager))
	mux.HandleFunc("GET /stacks/{name}", stackGetHandler(manager))
	mux.HandleFunc("PUT /stacks/{name}", stackUpdateHandler(manager))
	mux.HandleFunc("DELETE /stacks/{name}", stackDeleteHandler(manager))
	mux.HandleFunc("GET /stacks/{name}/derive-yaml", stackDeriveHandler(manager))

	// Per-container log stream (SSE).
	mux.HandleFunc("GET /containers/{id}/logs/stream", containerLogsHandler(manager))

	// Reclaim — per-card list + bulk delete + build-cache prune.
	mux.HandleFunc("GET /reclaim/images", reclaimListImagesHandler(manager))
	mux.HandleFunc("POST /reclaim/images", reclaimApplyImagesHandler(manager))
	mux.HandleFunc("GET /reclaim/containers", reclaimListContainersHandler(manager))
	mux.HandleFunc("POST /reclaim/containers", reclaimApplyContainersHandler(manager))
	mux.HandleFunc("GET /reclaim/volumes", reclaimListVolumesHandler(manager))
	mux.HandleFunc("POST /reclaim/volumes", reclaimApplyVolumesHandler(manager))
	mux.HandleFunc("POST /reclaim/build-cache", reclaimBuildCacheHandler(manager))
	mux.HandleFunc("/services", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, manager.Snapshot().Services)
	})
	mux.HandleFunc("/ports", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, manager.Snapshot().Ports)
	})

	// Firewall — list/add/delete host firewall rules through the host's
	// systemd (transient unit). When no supported firewall backend is detected the
	// GET returns available=false; mutating endpoints return 503.
	mux.HandleFunc("GET /firewall", firewallStatusHandler(manager))
	mux.HandleFunc("POST /firewall/rules", firewallAddHandler(manager))
	mux.HandleFunc("DELETE /firewall/rules", firewallDeleteHandler(manager))

	// File manager — per-server host filesystem operations. All paths are
	// host-relative; the outpost maps them through /hostfs internally.
	// Every handler funnels through openat2(RESOLVE_BENEATH) via the
	// safe* helpers in fs_safety_at.go, which also apply the denylist
	// and role rules.
	mux.HandleFunc("GET /fs/list", fsListHandler())
	mux.HandleFunc("GET /fs/stat", fsStatHandler())
	mux.HandleFunc("GET /fs/read", fsReadHandler())
	mux.HandleFunc("GET /fs/download", fsDownloadHandler())
	mux.HandleFunc("POST /fs/write", fsWriteHandler())
	mux.HandleFunc("POST /fs/mkdir", fsMkdirHandler())
	mux.HandleFunc("POST /fs/rename", fsRenameHandler())
	mux.HandleFunc("POST /fs/copy", fsCopyHandler())
	mux.HandleFunc("POST /fs/move", fsMoveHandler())
	mux.HandleFunc("DELETE /fs/entry", fsDeleteHandler())
	mux.HandleFunc("POST /fs/upload", fsUploadHandler())
	mux.HandleFunc("POST /fs/receive", fsReceiveHandler())
	// Trash management — listing + restore are operator+; permanent
	// delete is admin (no undo once it leaves the trash root).
	mux.HandleFunc("GET /fs/trash", fsTrashListHandler())
	mux.HandleFunc("POST /fs/trash/restore", fsTrashRestoreHandler())
	mux.HandleFunc("DELETE /fs/trash/{id}", fsTrashPermanentDeleteHandler())
	// Permission ops — admin-only.
	mux.HandleFunc("POST /fs/chmod", fsChmodHandler())
	mux.HandleFunc("POST /fs/chown", fsChownHandler())

	// settings — local-only; each outpost owns its own Cloudflare creds, etc.
	mux.HandleFunc("/settings", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if !roleAtLeast(roleViewer, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		if manager.settings == nil {
			writeErr(w, http.StatusServiceUnavailable, "settings store unavailable")
			return
		}
		view, err := manager.settings.View()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, view)
	})

	mux.HandleFunc("/settings/cloudflare", func(w http.ResponseWriter, r *http.Request) {
		// Cloudflare credentials are the keys to the user's DNS / tunnel
		// account; rotating or clearing them is admin-only.
		if !roleAtLeast(roleAdmin, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "admin role required")
			return
		}
		if manager.settings == nil {
			writeErr(w, http.StatusServiceUnavailable, "settings store unavailable")
			return
		}
		switch r.Method {
		case http.MethodPut, http.MethodPost:
			var body struct {
				APIToken    string `json:"apiToken"`
				AccountID   string `json:"accountId"`
				TunnelID    string `json:"tunnelId"`
				RefreshSecs int    `json:"refreshSecs"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil {
				writeErr(w, http.StatusBadRequest, "invalid JSON")
				return
			}
			if body.RefreshSecs != 0 &&
				(body.RefreshSecs < MinCloudflareRefreshSecs ||
					body.RefreshSecs > MaxCloudflareRefreshSecs) {
				writeErr(w, http.StatusBadRequest,
					fmt.Sprintf("refreshSecs must be between %d and %d",
						MinCloudflareRefreshSecs, MaxCloudflareRefreshSecs))
				return
			}
			if err := manager.settings.Update(StoredSettings{
				CloudflareAPIToken:    body.APIToken,
				CloudflareAccountID:   body.AccountID,
				CloudflareTunnelID:    body.TunnelID,
				CloudflareRefreshSecs: body.RefreshSecs,
			}); err != nil {
				writeErr(w, http.StatusInternalServerError, err.Error())
				return
			}
			refreshErr := manager.RefreshTunnelsNow(r.Context())
			// Wake the tunnel loop so the next scheduled fetch picks up
			// the new interval (or new creds, since they may have changed).
			manager.NotifyTunnelSettingsChanged()
			view, _ := manager.settings.View()
			writeJSON(w, map[string]any{
				"ok":      true,
				"view":    view,
				"refresh": errString(refreshErr),
			})

		case http.MethodDelete:
			if err := manager.settings.ClearCloudflare(); err != nil {
				writeErr(w, http.StatusInternalServerError, err.Error())
				return
			}
			writeJSON(w, map[string]any{"ok": true})

		default:
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	})

	// Manual tunnel refresh — bypasses the scheduled interval. Used by the
	// refresh button on the Network tab. Operator+ so a viewer can't burn
	// our Cloudflare API quota by spamming this endpoint, but still
	// reachable without admin (no credential change).
	mux.HandleFunc("/settings/cloudflare/refresh", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		err := manager.RefreshTunnelsNow(r.Context())
		// Also wake the loop — if the user fires manual refresh, they almost
		// certainly want the cadence clock to reset too, so the next auto
		// refresh starts counting from now.
		manager.NotifyTunnelSettingsChanged()
		writeJSON(w, map[string]any{
			"ok":      err == nil,
			"refresh": errString(err),
		})
	})

	return mux
}

func main() {
	// 127.0.0.1 by default — outposts never expose themselves publicly.
	// Reach them via Docker DNS (gate → outpost in the same network),
	// Tailscale, WireGuard, or set --addr=0.0.0.0:8080 explicitly to
	// expose on the LAN. The gate service stores the URL each user
	// adds via the SPA and proxies requests with the shared-secret
	// token, so the outpost itself only needs to listen where the
	// control plane can reach it.
	addr := flag.String("addr", "127.0.0.1:8080", "listen address")
	flag.Parse()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	go manager.Run(ctx)

	// Trash sweep: hourly tick, default 7-day retention. Override via
	// VANTAGE_TRASH_TTL_HOURS (an integer number of hours) for testing or
	// stricter retention. Sweep is its own goroutine, owned by ctx so it
	// terminates on SIGINT/SIGTERM with the rest.
	trashTTLHours := 24 * 7
	if v := os.Getenv("VANTAGE_TRASH_TTL_HOURS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			trashTTLHours = n
		}
	}
	startTrashSweep(ctx, time.Duration(trashTTLHours)*time.Hour, time.Hour)

	local := localMux()

	root := http.NewServeMux()
	// The SPA no longer talks to this outpost directly; the gate-service
	// proxy hits /api/<resource> with the X-Vantage-Outpost-Token header.
	// Per-resource handlers live in localMux().
	root.Handle("/api/", http.StripPrefix("/api", local))

	// Self-documentation. /openapi.json is the embedded spec; /swaggerui
	// is the static HTML shell that loads it. nginx routes both behind
	// the same auth_request gate the rest of /api/* uses.
	root.HandleFunc("/openapi.json", openapiSpecHandler)
	root.HandleFunc("/swaggerui", swaggerUIHandler)
	root.HandleFunc("/swaggerui/", swaggerUIHandler)
	root.HandleFunc("/swaggerui/static/", swaggerUIAssetHandler)

	if outpostToken == "" {
		log.Fatal("VANTAGE_OUTPOST_TOKEN must be set; refusing to start")
	}
	// Open the rooted handle every file op funnels through. Fails on
	// kernels without openat2 (Linux <5.6) — we'd rather refuse to start
	// than silently fall back to the racy EvalSymlinks path.
	initHostRoot()

	srv := &http.Server{
		Addr:         *addr,
		Handler:      requireToken(root),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shCtx, shCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shCancel()
		_ = srv.Shutdown(shCtx)
	}()

	log.Printf("vantage-dashboard API listening on %s", *addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
