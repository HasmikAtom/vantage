package main

type Container struct {
	// ID is the full Docker container ID (64-char hex). vantage-prime truncates
	// for display; we keep the full value so command endpoints can address the
	// container unambiguously even when names collide (rare but possible across
	// docker contexts) or get renamed.
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Status string   `json:"status"`
	Uptime string   `json:"uptime"`
	CPU    *float64 `json:"cpu"`
	Mem    *float64 `json:"mem"`
	Image  string   `json:"image"`
	Ports  []string `json:"ports"`
	// Per-container live throughput rates, computed as deltas against the
	// previous stats sample for the same container. nil until a second
	// sample arrives (no baseline → no rate). Bytes/sec.
	BlkReadBps  *float64 `json:"blkReadBps"`
	BlkWriteBps *float64 `json:"blkWriteBps"`
	NetRxBps    *float64 `json:"netRxBps"`
	NetTxBps    *float64 `json:"netTxBps"`
	// Stack is the compose project name this container belongs to, taken from
	// the `com.docker.compose.project` label. Empty for containers created
	// outside compose (e.g. `docker run` or the Phase 5a form). Used by the
	// Stacks tab to group + link members back to their stack.
	Stack string `json:"stack"`
	// StackWorkingDir is the host-side directory where the compose file
	// lives, taken from the `com.docker.compose.project.working_dir` label.
	// Only populated for compose-managed containers; used by the Stacks
	// list to surface where a "discovered" stack's YAML lives on the host.
	StackWorkingDir string `json:"stackWorkingDir"`
	// StackConfigFiles mirrors com.docker.compose.project.config_files —
	// a comma-separated list of the exact compose files this stack was
	// launched with (e.g. "docker-compose.prod.yml" or two stacked files).
	// Source of truth for the edit-discovered flow; without this we'd be
	// guessing filenames in working_dir, which fails for any stack that
	// uses a custom compose file name.
	StackConfigFiles string `json:"stackConfigFiles"`
}

// ContainerInspect is the typed subset of Docker's /containers/{id}/json
// response we surface through the inspect endpoint. Deliberately a subset
// rather than passthrough — the raw Docker shape is large, unstable across
// versions, and exposes plumbing (LogPath, SandboxKey, ProcessLabel) that
// isn't useful to a dashboard user.
type ContainerInspect struct {
	ID          string                      `json:"id"`
	Name        string                      `json:"name"`
	Image       string                      `json:"image"`       // tag-form, e.g. "nginx:latest"
	ImageDigest string                      `json:"imageDigest"` // sha256:...
	Created     string                      `json:"created"`     // ISO-8601
	Platform    string                      `json:"platform"`
	Driver      string                      `json:"driver"`
	State       ContainerInspectState       `json:"state"`
	Config      ContainerInspectConfig      `json:"config"`
	HostConfig  ContainerInspectHost        `json:"hostConfig"`
	Mounts      []ContainerMount            `json:"mounts"`
	Networks    map[string]ContainerNetwork `json:"networks"`
}

type ContainerInspectState struct {
	Status       string `json:"status"`
	Running      bool   `json:"running"`
	Paused       bool   `json:"paused"`
	Restarting   bool   `json:"restarting"`
	OOMKilled    bool   `json:"oomKilled"`
	ExitCode     int    `json:"exitCode"`
	Error        string `json:"error"`
	StartedAt    string `json:"startedAt"`
	FinishedAt   string `json:"finishedAt"`
	Health       string `json:"health,omitempty"` // healthy | unhealthy | starting | "" (no healthcheck)
	Pid          int    `json:"pid"`
	RestartCount int    `json:"restartCount"`
}

type ContainerInspectConfig struct {
	Cmd        []string          `json:"cmd"`
	Entrypoint []string          `json:"entrypoint"`
	Env        []string          `json:"env"` // "KEY=value" pairs
	Labels     map[string]string `json:"labels"`
	WorkingDir string            `json:"workingDir"`
	User       string            `json:"user"`
	Hostname   string            `json:"hostname"`
}

type ContainerInspectHost struct {
	RestartPolicy string `json:"restartPolicy"` // "always" | "no" | "on-failure" | "unless-stopped"
	NetworkMode   string `json:"networkMode"`
	Privileged    bool   `json:"privileged"`
	AutoRemove    bool   `json:"autoRemove"`
	MemoryLimit   int64  `json:"memoryLimit"` // bytes, 0 = unlimited
	NanoCpus      int64  `json:"nanoCpus"`    // 1e9 == 1 CPU, 0 = unlimited
}

type ContainerMount struct {
	Type        string `json:"type"` // bind | volume | tmpfs
	Source      string `json:"source"`
	Destination string `json:"destination"`
	Mode        string `json:"mode"`
	RW          bool   `json:"rw"`
}

type ContainerNetwork struct {
	IPAddress  string `json:"ipAddress"`
	Gateway    string `json:"gateway"`
	MacAddress string `json:"macAddress"`
	NetworkID  string `json:"networkId"`
}

// CreateContainerRequest is the structured body for POST /api/containers.
// Maps loosely onto Docker's /containers/create body but with friendlier
// shapes (ports as a list of typed records rather than the dual
// ExposedPorts + HostConfig.PortBindings dance Docker expects).
type CreateContainerRequest struct {
	Image         string             `json:"image"` // required, e.g. "nginx:latest"
	Name          string             `json:"name,omitempty"`
	Cmd           []string           `json:"cmd,omitempty"` // overrides image CMD
	Env           []string           `json:"env,omitempty"` // "KEY=value"
	Ports         []PortMapping      `json:"ports,omitempty"`
	Mounts        []VolumeMount      `json:"mounts,omitempty"`
	RestartPolicy string             `json:"restartPolicy,omitempty"` // no | on-failure | always | unless-stopped
}

type PortMapping struct {
	HostPort      int    `json:"hostPort"`
	ContainerPort int    `json:"containerPort"`
	Protocol      string `json:"protocol"` // tcp | udp; empty = tcp
}

type VolumeMount struct {
	HostPath      string `json:"hostPath"`      // host path or named volume
	ContainerPath string `json:"containerPath"`
	ReadOnly      bool   `json:"readOnly"`
}

type CreateContainerResponse struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Warnings []string `json:"warnings,omitempty"`
}

// StackSummary is the list-row view of one stack. Two kinds:
//
//   - "managed":    we deployed it through our own UI; YAML lives at
//                   <datadir>/stacks/<name>/docker-compose.yml. Full
//                   edit/remove operations are supported.
//   - "discovered": started outside Vantage (CLI, ansible, another
//                   tool). We only know about it because its containers
//                   carry the com.docker.compose.project label. Read-only
//                   in v1 — we don't own the YAML.
//
// WorkingDir is populated only for discovered stacks (from the
// com.docker.compose.project.working_dir label on a member container) so
// the UI can show where on the host the compose file actually lives.
type StackSummary struct {
	Name           string `json:"name"`
	Kind           string `json:"kind"`                 // "managed" | "discovered"
	UpdatedAt      string `json:"updatedAt"`            // ISO-8601; empty for discovered
	WorkingDir     string `json:"workingDir,omitempty"` // discovered only
	ContainerCount int    `json:"containerCount"`       // running + stopped, all states
	// HasFile: managed = always true (we own it on disk); discovered =
	// true if the compose file at the labeled config_files path still
	// exists. Lets the UI decide whether to show "Edit" (file present)
	// or steer the user toward "Recreate" (file gone).
	HasFile bool `json:"hasFile"`
}

// Stack is the detail view returned by GET /api/stacks/{name}.
// For managed stacks: YAML is the on-disk content.
// For discovered stacks: YAML is empty; WorkingDir points at the host
// path the compose file is at.
type Stack struct {
	Name       string      `json:"name"`
	Kind       string      `json:"kind"`
	UpdatedAt  string      `json:"updatedAt"`
	WorkingDir string      `json:"workingDir,omitempty"`
	YAML       string      `json:"yaml"`
	Containers []Container `json:"containers"`
}

// StackCreateRequest creates a new stack — name + YAML. POST /api/stacks
// rejects with 409 if the name is already in use.
type StackCreateRequest struct {
	Name string `json:"name"`
	YAML string `json:"yaml"`
}

// StackUpdateRequest swaps in new YAML for an existing stack. Re-applies
// with `docker compose up -d`, which reconciles only the services whose
// config has changed (compose's default behaviour).
type StackUpdateRequest struct {
	YAML string `json:"yaml"`
}

// Reclaim — per-item list rows for the disk-usage cards' "Reclaim..." flow.
// Each category has slightly different identifying fields, so they don't
// share a base struct; vantage-prime renders per-category columns anyway.
type ReclaimableImage struct {
	ID        string `json:"id"`
	RepoTag   string `json:"repoTag"` // "<none>" when dangling
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt string `json:"createdAt"` // ISO-8601
}

type ReclaimableContainer struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Image     string `json:"image"`
	State     string `json:"state"`  // exited | dead | created
	Status    string `json:"status"` // "Exited (0) 3 days ago"
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt string `json:"createdAt"`
}

type ReclaimableVolume struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt string `json:"createdAt"` // may be "" on older docker
}

// ReclaimRequest is the bulk-delete body for /api/reclaim/{images,containers,volumes}.
// `ids` for images + containers, `names` for volumes (volume API addresses
// by name, not ID).
type ReclaimRequest struct {
	IDs []string `json:"ids,omitempty"`
}

// ReclaimResult reports per-item outcome so partial failures surface
// clearly. status: "ok" | "skipped" | "error". `error` populated only for
// the error case; skipped (e.g. "in use") goes via status.
type ReclaimItemResult struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type ReclaimResult struct {
	Items          []ReclaimItemResult `json:"items"`
	FreedBytes     int64               `json:"freedBytes,omitempty"` // only build-cache
	SuccessCount   int                 `json:"successCount"`
	SkippedCount   int                 `json:"skippedCount"`
	ErrorCount     int                 `json:"errorCount"`
}

// ---------------------------------------------------------------------------
// New: docker system df
// ---------------------------------------------------------------------------

type DockerDFCategory struct {
	Count       int   `json:"count"`
	Active      int   `json:"active"`
	SizeBytes   int64 `json:"sizeBytes"`
	ReclaimBytes int64 `json:"reclaimBytes"`
}

type DockerDF struct {
	Images     DockerDFCategory `json:"images"`
	Containers DockerDFCategory `json:"containers"`
	Volumes    DockerDFCategory `json:"volumes"`
	BuildCache DockerDFCategory `json:"buildCache"`
}
