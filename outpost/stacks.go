package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Stack storage + docker compose shell-out helpers.
//
// Design (see container-roadmap.md Phase 5b for the rationale):
//
//   - Each stack is one directory under `<VANTAGE_DATA_DIR>/stacks/<name>/`
//     containing a single `docker-compose.yml`. Files live on the host that
//     runs the containers, not in the central gate-service DB, because
//     `docker compose` requires the file on local disk and the stack is a
//     per-host artifact.
//
//   - Stack names are restricted to `^[a-z0-9][a-z0-9_-]*$` (max 64 chars).
//     That's a strict subset of Docker's project-name rules; rejecting up
//     front guarantees the on-disk dir name is sane and immunises us
//     against path-traversal attempts in any name reaching this module.
//
//   - We shell out to `docker compose` (v2 plugin). Reimplementing compose
//     semantics over the raw Docker API would be a multi-week rabbit hole.

const (
	stacksSubdir    = "stacks"
	composeFilename = "docker-compose.yml"
	maxStackNameLen = 64
	// 256 KB is a generous ceiling for a hand-edited compose file. Anything
	// larger is almost certainly a paste mistake or hostile input.
	maxComposeBytes = 256 * 1024
)

var stackNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

var (
	ErrInvalidStackName = errors.New("invalid stack name")
	ErrStackNotFound    = errors.New("stack not found")
	ErrStackExists      = errors.New("stack already exists")
	ErrComposeTooLarge  = errors.New("compose file too large")
)

// stacksDir resolves the on-disk parent directory for stack subdirs. Reuses
// the same VANTAGE_DATA_DIR convention as settings.go; the dev fallback to
// "./data" is intentional so the binary works without `/data` outside of
// Docker.
func stacksDir() string {
	dir := os.Getenv("VANTAGE_DATA_DIR")
	if dir == "" {
		dir = "/data"
	}
	return filepath.Join(dir, stacksSubdir)
}

func validStackName(name string) bool {
	if name == "" || len(name) > maxStackNameLen {
		return false
	}
	return stackNameRe.MatchString(name)
}

// stackComposePath returns the absolute compose file path for a stack.
// Validates the name first; ErrInvalidStackName guards every caller that
// might pass user-controlled input.
func stackComposePath(name string) (string, error) {
	if !validStackName(name) {
		return "", ErrInvalidStackName
	}
	return filepath.Join(stacksDir(), name, composeFilename), nil
}

// StackEntry is the on-disk view of one stack — just the metadata we can
// derive from the filesystem without invoking docker.
type StackEntry struct {
	Name      string
	UpdatedAt time.Time
}

// listStacks returns every directory under stacksDir that holds a valid
// compose file. Stale/empty dirs are skipped silently. Sorted by name.
func listStacks() ([]StackEntry, error) {
	entries, err := os.ReadDir(stacksDir())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := []StackEntry{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if !validStackName(name) {
			continue
		}
		info, err := os.Stat(filepath.Join(stacksDir(), name, composeFilename))
		if err != nil {
			continue
		}
		out = append(out, StackEntry{Name: name, UpdatedAt: info.ModTime()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func readStackYAML(name string) (string, error) {
	path, err := stackComposePath(name)
	if err != nil {
		return "", err
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", ErrStackNotFound
	}
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// writeStackYAML persists the compose YAML atomically (write-temp + rename).
// Creates the stack subdir on first write with 0700 perms; the file lands
// at 0600. Caller is responsible for running composeValidate first; we
// don't second-guess YAML correctness here.
func writeStackYAML(name, yaml string) error {
	if !validStackName(name) {
		return ErrInvalidStackName
	}
	if len(yaml) > maxComposeBytes {
		return ErrComposeTooLarge
	}
	dir := filepath.Join(stacksDir(), name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	final := filepath.Join(dir, composeFilename)
	tmp := final + ".tmp"
	if err := os.WriteFile(tmp, []byte(yaml), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}

func stackExists(name string) bool {
	path, err := stackComposePath(name)
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}

// removeStackDir deletes the entire stack subdir. Caller MUST have already
// run composeDown — orphan containers + a missing compose file is a worse
// state to be in than just leaving the file there.
func removeStackDir(name string) error {
	if !validStackName(name) {
		return ErrInvalidStackName
	}
	return os.RemoveAll(filepath.Join(stacksDir(), name))
}

// ---------------------------------------------------------------------------
// Discovered stacks — read + write compose files that live on the HOST
// filesystem, accessed via the /hostfs bind mount.
// ---------------------------------------------------------------------------

// hostPath translates a host filesystem path into a path we can access
// from inside the container. When HOST_ROOT is set (typically "/hostfs"
// per docker-compose.prod.yml), "/home/hasmik/foo" becomes
// "/hostfs/home/hasmik/foo". Off the host (bare-metal binary) the
// translation is a no-op.
func hostPath(p string) string {
	base := os.Getenv("HOST_ROOT")
	if base == "" {
		return p
	}
	return filepath.Join(base, p)
}

// parseConfigFiles splits the comma-separated value of the
// com.docker.compose.project.config_files label. Compose stacks can be
// launched with multiple stacked files (e.g. "base.yml,override.yml"); we
// return them in declaration order. The first file is the primary one
// the edit-discovered UI lets users modify in v1.
func parseConfigFiles(label string) []string {
	if label == "" {
		return nil
	}
	parts := strings.Split(label, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// readDiscoveredYAML opens the primary compose file for a discovered
// stack via /hostfs. Returns the absolute HOST path alongside the YAML
// so callers can pass it back to composeUpInDir. The label-supplied path
// is routed through safeReadFile so a hostile container label cannot
// redirect this read at a denylisted file (e.g. /etc/shadow), outside
// the host root via an absolute path, or via a symlink swap (TOCTOU).
func readDiscoveredYAML(configFilesLabel, role string) (yaml, hostFilePath string, err error) {
	files := parseConfigFiles(configFilesLabel)
	if len(files) == 0 {
		return "", "", ErrStackNotFound
	}
	hostFilePath = files[0]
	b, _, err := safeReadFile(hostFilePath, role)
	if errors.Is(err, os.ErrNotExist) {
		return "", hostFilePath, ErrStackNotFound
	}
	if err != nil {
		return "", hostFilePath, err
	}
	return string(b), hostFilePath, nil
}

// ---------------------------------------------------------------------------
// Recreate-from-discovered: build a managed-stack YAML from inspect data
// ---------------------------------------------------------------------------

// serviceNameFromContainer extracts the compose service name from a
// container name, given the project prefix. Compose names containers
// `<project>-<service>-<replica>` (or `_` separators in older deploys);
// we strip the prefix and trailing -N to recover the service name.
func serviceNameFromContainer(project, containerName string) string {
	name := strings.TrimPrefix(containerName, project+"-")
	if name == containerName {
		name = strings.TrimPrefix(containerName, project+"_")
	}
	if dash := strings.LastIndexAny(name, "-_"); dash > 0 {
		suffix := name[dash+1:]
		if isDigits(suffix) {
			name = name[:dash]
		}
	}
	if name == "" {
		name = containerName
	}
	return name
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// yamlScalar formats a string as a safe YAML scalar. Plain (unquoted)
// form for simple identifiers/paths; double-quoted otherwise. Errs on
// the side of quoting — `8080:80`, env values with spaces, anything
// non-trivial gets quoted. Always-valid output is more important than
// pretty here, since the user reviews the generated YAML before saving.
func yamlScalar(s string) string {
	if s == "" {
		return `""`
	}
	plain := true
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-' || r == '_' || r == '.' || r == '/' || r == '=':
			// allowed in plain form
		default:
			plain = false
		}
	}
	// Don't emit plain for anything starting with characters that change
	// meaning at the start of a scalar.
	if plain && len(s) > 0 {
		switch s[0] {
		case '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`':
			plain = false
		}
		// Numeric-looking, boolean-looking, or null-looking values must
		// quote so YAML doesn't interpret them as those types.
		if plain {
			switch strings.ToLower(s) {
			case "true", "false", "null", "yes", "no", "on", "off", "~":
				plain = false
			}
		}
	}
	if plain {
		return s
	}
	esc := strings.ReplaceAll(s, "\\", "\\\\")
	esc = strings.ReplaceAll(esc, `"`, `\"`)
	return `"` + esc + `"`
}

// deriveComposeYAML reverse-engineers a docker-compose.yml from the
// members of a discovered stack. Best-effort — we can't tell
// image-baked-in defaults from explicit overrides via inspect alone, so
// we lean inclusive (everything goes in) and prefix the output with a
// header reminding the user to review and prune.
//
// `members` is the Container snapshot rows (gives us pre-formatted port
// strings). The inspect call enriches each with env vars, mounts,
// labels, command, restart policy.
func deriveComposeYAML(ctx context.Context, docker *dockerClient, projectName string, members []Container) (string, error) {
	type entry struct {
		serviceName   string
		containerName string
		ports         []string
		insp          *ContainerInspect
	}
	entries := make([]entry, 0, len(members))
	for _, m := range members {
		insp, err := docker.inspectContainer(ctx, m.ID)
		if err != nil {
			// Skip members we can't inspect — leave them out of the
			// generated YAML rather than failing the whole derivation.
			continue
		}
		entries = append(entries, entry{
			serviceName:   serviceNameFromContainer(projectName, m.Name),
			containerName: m.Name,
			ports:         m.Ports,
			insp:          insp,
		})
	}
	if len(entries) == 0 {
		return "", errors.New("no inspectable members in stack")
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].serviceName < entries[j].serviceName })

	var sb strings.Builder
	sb.WriteString("# Reverse-engineered from `docker inspect` of the discovered stack.\n")
	sb.WriteString("# Review and edit before deploying:\n")
	sb.WriteString("#  - env vars likely include image-baked-in defaults; trim what wasn't yours\n")
	sb.WriteString("#  - mounts list both bind paths and named volumes — verify named volumes exist\n")
	sb.WriteString("#  - depends_on / networks / healthchecks aren't inferred; add as needed\n")
	sb.WriteString("services:\n")

	for _, e := range entries {
		fmt.Fprintf(&sb, "  %s:\n", yamlScalar(e.serviceName))
		fmt.Fprintf(&sb, "    image: %s\n", yamlScalar(e.insp.Image))
		// container_name preserves the original — drop it if the user
		// wants compose's automatic naming.
		fmt.Fprintf(&sb, "    container_name: %s\n", yamlScalar(e.containerName))
		if rp := e.insp.HostConfig.RestartPolicy; rp != "" && rp != "no" {
			fmt.Fprintf(&sb, "    restart: %s\n", yamlScalar(rp))
		}
		if len(e.insp.Config.Cmd) > 0 {
			sb.WriteString("    command:\n")
			for _, c := range e.insp.Config.Cmd {
				fmt.Fprintf(&sb, "      - %s\n", yamlScalar(c))
			}
		}
		if len(e.insp.Config.Env) > 0 {
			sb.WriteString("    environment:\n")
			for _, env := range e.insp.Config.Env {
				fmt.Fprintf(&sb, "      - %s\n", yamlScalar(env))
			}
		}
		if len(e.ports) > 0 {
			sb.WriteString("    ports:\n")
			for _, p := range e.ports {
				// Container.Ports format is "host:container" or just
				// "container" — both valid compose port shorthand.
				fmt.Fprintf(&sb, "      - %s\n", yamlScalar(p))
			}
		}
		if len(e.insp.Mounts) > 0 {
			sb.WriteString("    volumes:\n")
			for _, mnt := range e.insp.Mounts {
				mode := "rw"
				if !mnt.RW {
					mode = "ro"
				}
				spec := fmt.Sprintf("%s:%s:%s", mnt.Source, mnt.Destination, mode)
				fmt.Fprintf(&sb, "      - %s\n", yamlScalar(spec))
			}
		}
		// Labels: drop compose-internal ones (they'll get re-added by
		// compose on deploy) and any blank values.
		labels := make([]string, 0, len(e.insp.Config.Labels))
		for k, v := range e.insp.Config.Labels {
			if strings.HasPrefix(k, "com.docker.compose.") {
				continue
			}
			if k == "" {
				continue
			}
			labels = append(labels, fmt.Sprintf("%s=%s", k, v))
		}
		if len(labels) > 0 {
			sort.Strings(labels)
			sb.WriteString("    labels:\n")
			for _, l := range labels {
				fmt.Fprintf(&sb, "      - %s\n", yamlScalar(l))
			}
		}
	}
	return sb.String(), nil
}

// composeUpInDir runs `docker compose up -d` against a host-side compose
// file. The trick: `--project-directory` MUST be the HOST path (not the
// /hostfs-prefixed one), because compose resolves relative paths in the
// YAML (`volumes: ./data:/data`) against the project directory and the
// daemon resolves bind-mount sources against the host filesystem. If we
// passed /hostfs paths, the daemon would look up "/hostfs/<dir>/data"
// which doesn't exist on the host's view.
func composeUpInDir(ctx context.Context, name, hostWorkingDir, hostFilePath string) error {
	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-p", name,
		"--project-directory", hostWorkingDir,
		"-f", hostPath(hostFilePath),
		"up", "-d")
	_, err := cmd.Output()
	return composeError("up", err)
}

// ---------------------------------------------------------------------------
// docker compose shell-out
// ---------------------------------------------------------------------------
//
// We invoke `docker compose` (v2 plugin, NOT the deprecated `docker-compose`
// v1 Python script) with explicit -p (project name) + -f (compose file)
// flags so the call is independent of the process's cwd and the project
// name doesn't get derived from the directory.
//
// All commands are context-bounded — callers pass a request context whose
// deadline kills the subprocess if compose hangs (rare, but a wedged pull
// inside `compose up` could otherwise outlive the handler).

func composeValidate(ctx context.Context, composePath string) error {
	cmd := exec.CommandContext(ctx, "docker", "compose", "-f", composePath, "config", "--quiet")
	_, err := cmd.Output()
	return composeError("validate", err)
}

// composeUp brings the stack up in detached mode, pulling images and
// recreating only the services whose config has changed (compose's default
// reconciliation behaviour).
func composeUp(ctx context.Context, name, composePath string) error {
	cmd := exec.CommandContext(ctx, "docker", "compose", "-p", name, "-f", composePath, "up", "-d")
	_, err := cmd.Output()
	return composeError("up", err)
}

// composeDown stops and removes the stack's containers + network.
// removeVolumes additionally drops anonymous volumes declared in the file;
// named volumes are left alone (independent objects).
func composeDown(ctx context.Context, name, composePath string, removeVolumes bool) error {
	args := []string{"compose", "-p", name, "-f", composePath, "down"}
	if removeVolumes {
		args = append(args, "--volumes")
	}
	cmd := exec.CommandContext(ctx, "docker", args...)
	_, err := cmd.Output()
	return composeError("down", err)
}

// composeError unwraps exec.ExitError to surface compose's actual stderr
// message instead of the generic "exit status 1". Returns nil if err is nil.
func composeError(action string, err error) error {
	if err == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		stderr := strings.TrimSpace(string(exitErr.Stderr))
		if stderr != "" {
			return fmt.Errorf("docker compose %s: %s", action, stderr)
		}
	}
	return fmt.Errorf("docker compose %s: %w", action, err)
}
