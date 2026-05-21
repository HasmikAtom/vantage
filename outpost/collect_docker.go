package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// dockerClient is a tiny HTTP client over the docker.sock unix socket.
// `http` is for reads (5s overall budget — keeps a slow stats call from
// stalling a collector tick). `cmd` is for write commands (start/stop/etc.)
// and intentionally has no Timeout so the caller's context is authoritative
// — `docker stop -t 30` can legitimately take 30+ seconds.
type dockerClient struct {
	http *http.Client
	cmd  *http.Client
	sock string
}

// ErrDockerNotFound is the sentinel error from a write command when the
// container ID doesn't exist (HTTP 404 from the docker socket). Lets
// handlers map cleanly to a 404 response instead of a generic 502.
var ErrDockerNotFound = errors.New("container not found")

// ErrContainerRunning is returned by removeContainer when the target is
// still running and force=false. Handlers map this to a 409 + helpful
// message so the UI can surface a "stop first or use force?" prompt.
var ErrContainerRunning = errors.New("container is running")

// ErrImageInUse / ErrVolumeInUse: docker returns 409 when we try to
// remove an image that's referenced by another tag/container, or a
// volume that's still mounted. The reclaim flow surfaces these per-item
// in the result list so the user sees "skipped: in use" rather than
// "everything failed".
var ErrImageInUse = errors.New("image is in use")
var ErrVolumeInUse = errors.New("volume is in use")

func newDockerClient() *dockerClient {
	sock := os.Getenv("DOCKER_SOCK")
	if sock == "" {
		sock = "/var/run/docker.sock"
	}
	dial := func(_ context.Context, _, _ string) (net.Conn, error) {
		return net.Dial("unix", sock)
	}
	return &dockerClient{
		sock: sock,
		http: &http.Client{
			Transport: &http.Transport{
				DialContext:     dial,
				IdleConnTimeout: 30 * time.Second,
			},
			Timeout: 5 * time.Second,
		},
		cmd: &http.Client{
			Transport: &http.Transport{
				DialContext:     dial,
				IdleConnTimeout: 30 * time.Second,
			},
			// Timeout deliberately unset — see struct comment.
		},
	}
}

func (c *dockerClient) available() bool {
	_, err := os.Stat(c.sock)
	return err == nil
}

// post issues a POST against the docker socket and consumes the response
// body. Treats 204 (No Content) and 304 (Not Modified — "already in target
// state") as success no-ops; returns ErrDockerNotFound on 404; surfaces
// other non-2xx as a generic error with status code and trimmed body.
func (c *dockerClient) post(ctx context.Context, path string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.cmd.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNoContent, http.StatusNotModified:
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	case http.StatusNotFound:
		_, _ = io.Copy(io.Discard, resp.Body)
		return ErrDockerNotFound
	default:
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("docker %s: %d: %s", path, resp.StatusCode, strings.TrimSpace(string(b)))
	}
}

// startContainer issues docker start. Idempotent — starting a running
// container returns 304 from docker, which post() flattens to success.
func (c *dockerClient) startContainer(ctx context.Context, id string) error {
	return c.post(ctx, "/containers/"+id+"/start")
}

// stopContainer issues docker stop with a graceful shutdown timeout (seconds
// to SIGTERM before docker escalates to SIGKILL). Idempotent on
// already-stopped containers (docker returns 304).
func (c *dockerClient) stopContainer(ctx context.Context, id string, timeoutSecs int) error {
	return c.post(ctx, fmt.Sprintf("/containers/%s/stop?t=%d", id, timeoutSecs))
}

// restartContainer issues docker restart. timeoutSecs governs the
// SIGTERM → SIGKILL window for the stop phase.
func (c *dockerClient) restartContainer(ctx context.Context, id string, timeoutSecs int) error {
	return c.post(ctx, fmt.Sprintf("/containers/%s/restart?t=%d", id, timeoutSecs))
}

// splitImageTag separates a Docker image reference into its name and tag.
// "nginx" → ("nginx", "latest"); "nginx:1.25" → ("nginx", "1.25");
// "ghcr.io/user/repo:dev" → ("ghcr.io/user/repo", "dev");
// "registry.local:5000/repo:v1" → ("registry.local:5000/repo", "v1") —
// only splits on the last ':' that follows the last '/' so registry ports
// don't get mistaken for tags.
func splitImageTag(image string) (name, tag string) {
	lastSlash := strings.LastIndex(image, "/")
	lastColon := strings.LastIndex(image, ":")
	if lastColon > lastSlash {
		return image[:lastColon], image[lastColon+1:]
	}
	return image, "latest"
}

// imageExists returns true if the image is present locally. False on a 404
// from the docker socket; any other error is propagated so callers can
// distinguish "missing → pull" from "socket broken → bail".
func (c *dockerClient) imageExists(ctx context.Context, name string) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/images/"+name+"/json", nil)
	if err != nil {
		return false, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	switch resp.StatusCode {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("image check: docker returned %d", resp.StatusCode)
	}
}

// pullImage issues `docker pull` against the socket. Docker streams JSONL
// progress events ({"status":"Downloading","progress":"..."}); we drain
// the stream until EOF and surface any {"error":"..."} line as the
// returned error. The cmd client has no timeout — caller's context bounds
// the call, which is appropriate for pulls that can legitimately take
// minutes on a cold registry.
func (c *dockerClient) pullImage(ctx context.Context, image string) error {
	name, tag := splitImageTag(image)
	path := fmt.Sprintf("/images/create?fromImage=%s&tag=%s", name, tag)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.cmd.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pull %s: docker returned %d: %s", image, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	// Docker streams one JSON object per line. Most are progress/status
	// updates we ignore; an {"error":"..."} line means the pull failed
	// mid-stream (auth failure, manifest not found, etc.).
	dec := json.NewDecoder(resp.Body)
	for dec.More() {
		var ev struct {
			Error string `json:"error"`
		}
		if err := dec.Decode(&ev); err != nil {
			// Mid-stream JSON parse error usually means the connection was
			// torn or docker emitted something unexpected — treat as failure
			// rather than silently truncating the pull.
			return fmt.Errorf("pull %s: stream decode: %w", image, err)
		}
		if ev.Error != "" {
			return fmt.Errorf("pull %s: %s", image, ev.Error)
		}
	}
	return nil
}

// createContainer issues docker create. The request body mirrors Docker's
// /containers/create shape so we can pass through without re-validating
// every field. Returns the new container ID and any warnings docker
// reported (image platform mismatch, etc.).
type dockerCreateBody struct {
	Image        string              `json:"Image"`
	Cmd          []string            `json:"Cmd,omitempty"`
	Env          []string            `json:"Env,omitempty"`
	ExposedPorts map[string]struct{} `json:"ExposedPorts,omitempty"`
	HostConfig   struct {
		PortBindings  map[string][]dockerPortBinding `json:"PortBindings,omitempty"`
		Binds         []string                       `json:"Binds,omitempty"`
		RestartPolicy struct {
			Name string `json:"Name,omitempty"`
		} `json:"RestartPolicy,omitempty"`
	} `json:"HostConfig"`
}

type dockerPortBinding struct {
	HostIP   string `json:"HostIp,omitempty"`
	HostPort string `json:"HostPort"`
}

func (c *dockerClient) createContainer(ctx context.Context, name string, body dockerCreateBody) (id string, warnings []string, err error) {
	jsonBody, err := json.Marshal(body)
	if err != nil {
		return "", nil, err
	}
	path := "/containers/create"
	if name != "" {
		path += "?name=" + name
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://docker"+path, bytes.NewReader(jsonBody))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.cmd.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		// Docker error bodies look like {"message":"..."} — surface that
		// directly when present, else the raw body.
		var msg struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(b, &msg) == nil && msg.Message != "" {
			return "", nil, fmt.Errorf("create container: %s", msg.Message)
		}
		return "", nil, fmt.Errorf("create container: docker returned %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var out struct {
		ID       string   `json:"Id"`
		Warnings []string `json:"Warnings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", nil, err
	}
	return out.ID, out.Warnings, nil
}

// ---------------------------------------------------------------------------
// docker logs streaming
// ---------------------------------------------------------------------------

// maxLogLine caps any single emitted line. Containers that spit out giant
// blobs (raw JSON traces, base64-encoded payloads) shouldn't be able to
// blow up the SSE consumer's memory — we truncate with a visible marker.
const maxLogLine = 16 * 1024

// LogStreamOpts mirrors the docker /containers/{id}/logs query params we
// care about. Caller fills in tail/follow/stdout/stderr; the handler
// translates query string + Last-Event-ID into these fields.
type LogStreamOpts struct {
	Tail         int     // <0 = "all", 0 = treated as 200 (sane default), >0 = N lines
	Follow       bool
	Stdout       bool
	Stderr       bool
	SinceSeconds float64 // 0 = no since filter
	TTY          bool    // when true, the container allocated a TTY → no framing
}

// LogLine is one decoded line ready to be emitted as an SSE message.
type LogLine struct {
	Stream    string // "stdout" | "stderr"
	Timestamp time.Time
	Line      string
}

// streamLogs opens /containers/{id}/logs and invokes onLine for every
// complete line decoded from docker's wire format. Returns when the
// underlying stream closes (container exited, follow=false done, client
// disconnected — context cancel propagates).
//
// Two wire formats live behind one endpoint:
//
//   - Non-TTY containers: multiplexed binary frames. 8-byte header
//     (stream byte at [0], length BE uint32 at [4:8]) + payload. Each
//     frame can carry multiple lines or a fragment of one line; we
//     accumulate per-stream buffers so partial lines reassemble across
//     frames.
//
//   - TTY containers: the body is raw text, all treated as stdout (the
//     TTY merged the two FDs at allocation). Line-split with bufio.
//
// timestamps=1 is always set so onLine receives per-line wall-clock times,
// which the SSE handler uses as the message id (for Last-Event-ID resume).
func (c *dockerClient) streamLogs(ctx context.Context, id string, opts LogStreamOpts, onLine func(LogLine) error) error {
	q := url.Values{}
	if opts.Stdout {
		q.Set("stdout", "1")
	}
	if opts.Stderr {
		q.Set("stderr", "1")
	}
	if opts.Follow {
		q.Set("follow", "1")
	}
	switch {
	case opts.Tail < 0:
		q.Set("tail", "all")
	case opts.Tail == 0:
		q.Set("tail", "200")
	default:
		q.Set("tail", strconv.Itoa(opts.Tail))
	}
	if opts.SinceSeconds > 0 {
		q.Set("since", strconv.FormatFloat(opts.SinceSeconds, 'f', -1, 64))
	}
	q.Set("timestamps", "1")

	path := "/containers/" + id + "/logs?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.cmd.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return ErrDockerNotFound
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("docker logs: %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	if opts.TTY {
		return scanTTYLogs(resp.Body, onLine)
	}
	return scanFramedLogs(resp.Body, onLine)
}

// scanFramedLogs decodes docker's multiplexed framing for non-TTY containers.
// Per-stream buffers accumulate bytes across frames; complete lines (split
// on '\n') get flushed as they're identified.
func scanFramedLogs(r io.Reader, onLine func(LogLine) error) error {
	streamNames := map[byte]string{1: "stdout", 2: "stderr"}
	bufs := map[byte][]byte{1: nil, 2: nil}
	header := make([]byte, 8)

	for {
		if _, err := io.ReadFull(r, header); err != nil {
			// EOF / unexpected EOF means the docker stream closed normally
			// (container exited, follow finished, client disconnected).
			// Flush any trailing partial lines first so we don't drop the
			// last write of a container that didn't end with '\n'.
			for stream, name := range streamNames {
				if len(bufs[stream]) > 0 {
					if e := emitOne(name, bufs[stream], onLine); e != nil {
						return e
					}
				}
			}
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return nil
			}
			return err
		}
		stream := header[0]
		length := binary.BigEndian.Uint32(header[4:8])
		if length == 0 {
			continue
		}
		// Sanity cap on individual frames. Docker rarely emits frames larger
		// than 32 KB; anything massively bigger likely indicates a desync
		// (we slipped out of frame boundaries) — bail rather than read
		// nonsense into memory.
		if length > 16*1024*1024 {
			return fmt.Errorf("docker logs: frame length %d implausible", length)
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(r, payload); err != nil {
			return err
		}
		name, ok := streamNames[stream]
		if !ok {
			continue // unknown stream byte (stdin = 0, shouldn't see in logs)
		}
		bufs[stream] = append(bufs[stream], payload...)
		// Flush complete lines.
		for {
			nl := bytes.IndexByte(bufs[stream], '\n')
			if nl < 0 {
				break
			}
			line := bufs[stream][:nl]
			bufs[stream] = bufs[stream][nl+1:]
			if err := emitOne(name, line, onLine); err != nil {
				return err
			}
		}
	}
}

// scanTTYLogs handles containers started with -t / tty:true. No framing.
// Single stream, surfaced as "stdout" since the TTY merges both FDs.
func scanTTYLogs(r io.Reader, onLine func(LogLine) error) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), maxLogLine*2)
	for scanner.Scan() {
		if err := emitOne("stdout", scanner.Bytes(), onLine); err != nil {
			return err
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// emitOne strips docker's RFC3339Nano timestamp prefix (added because we
// always set timestamps=1), truncates the remainder to maxLogLine, and
// invokes the caller's onLine callback.
func emitOne(stream string, raw []byte, onLine func(LogLine) error) error {
	ts, rest := splitTimestamp(raw)
	if len(rest) > maxLogLine {
		// Truncate to give the consumer a visible boundary rather than a
		// silent cut. The marker is short so it won't push us back over
		// the cap.
		rest = append(rest[:maxLogLine:maxLogLine], []byte("…[TRUNCATED]")...)
	}
	return onLine(LogLine{
		Stream:    stream,
		Timestamp: ts,
		Line:      string(rest),
	})
}

// splitTimestamp parses the "RFC3339Nano line" prefix docker emits when
// timestamps=1 is set. Returns (zero-time, original) if the line doesn't
// look timestamped — defensive, since the timestamps query param is
// supposed to be authoritative but docker has been known to drift.
func splitTimestamp(raw []byte) (time.Time, []byte) {
	sp := bytes.IndexByte(raw, ' ')
	if sp <= 0 || sp > 40 {
		return time.Time{}, raw
	}
	t, err := time.Parse(time.RFC3339Nano, string(raw[:sp]))
	if err != nil {
		return time.Time{}, raw
	}
	return t, raw[sp+1:]
}

// removeContainer issues docker rm. `force` SIGKILLs a running container
// before removal (Docker returns 409 if it's running and force is false).
// `removeVolumes` deletes anonymous volumes attached to the container — it
// does NOT remove named volumes (those would require an explicit volume rm
// since they're independent objects).
func (c *dockerClient) removeContainer(ctx context.Context, id string, force, removeVolumes bool) error {
	path := fmt.Sprintf("/containers/%s?force=%t&v=%t", id, force, removeVolumes)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.cmd.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNoContent:
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	case http.StatusNotFound:
		_, _ = io.Copy(io.Discard, resp.Body)
		return ErrDockerNotFound
	case http.StatusConflict:
		// 409 in this path almost always means "container is running". Drain
		// the body for the connection pool but discard — the sentinel is
		// enough for handlers to map to a useful UX.
		_, _ = io.Copy(io.Discard, resp.Body)
		return ErrContainerRunning
	default:
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("docker remove: %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
}

// dockerInspectRaw mirrors the subset of /containers/{id}/json fields we
// project into the typed ContainerInspect response. Anything not listed here
// is dropped on the floor — keeps the surface area small and shields
// callers from Docker API drift.
type dockerInspectRaw struct {
	ID       string `json:"Id"`
	Name     string `json:"Name"`
	Image    string `json:"Image"` // sha256:...
	Created  string `json:"Created"`
	Platform string `json:"Platform"`
	Driver   string `json:"Driver"`
	State    struct {
		Status     string `json:"Status"`
		Running    bool   `json:"Running"`
		Paused     bool   `json:"Paused"`
		Restarting bool   `json:"Restarting"`
		OOMKilled  bool   `json:"OOMKilled"`
		Pid        int    `json:"Pid"`
		ExitCode   int    `json:"ExitCode"`
		Error      string `json:"Error"`
		StartedAt  string `json:"StartedAt"`
		FinishedAt string `json:"FinishedAt"`
		Health     *struct {
			Status string `json:"Status"`
		} `json:"Health,omitempty"`
	} `json:"State"`
	RestartCount int `json:"RestartCount"`
	Config       struct {
		Hostname   string            `json:"Hostname"`
		User       string            `json:"User"`
		Env        []string          `json:"Env"`
		Cmd        []string          `json:"Cmd"`
		Image      string            `json:"Image"` // tag form: "nginx:latest"
		WorkingDir string            `json:"WorkingDir"`
		Entrypoint []string          `json:"Entrypoint"`
		Labels     map[string]string `json:"Labels"`
	} `json:"Config"`
	HostConfig struct {
		NetworkMode   string `json:"NetworkMode"`
		Privileged    bool   `json:"Privileged"`
		AutoRemove    bool   `json:"AutoRemove"`
		Memory        int64  `json:"Memory"`
		NanoCpus      int64  `json:"NanoCpus"`
		RestartPolicy struct {
			Name string `json:"Name"`
		} `json:"RestartPolicy"`
	} `json:"HostConfig"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"` // present for named volumes
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		Mode        string `json:"Mode"`
		RW          bool   `json:"RW"`
	} `json:"Mounts"`
	NetworkSettings struct {
		Networks map[string]struct {
			IPAddress  string `json:"IPAddress"`
			Gateway    string `json:"Gateway"`
			MacAddress string `json:"MacAddress"`
			NetworkID  string `json:"NetworkID"`
		} `json:"Networks"`
	} `json:"NetworkSettings"`
}

// inspectContainer fetches /containers/{id}/json and projects it onto the
// typed ContainerInspect shape we expose. Returns ErrDockerNotFound on a
// 404 so handlers can map to the right HTTP status.
func (c *dockerClient) inspectContainer(ctx context.Context, id string) (*ContainerInspect, error) {
	// Build the request manually so we can distinguish 404 from other errors;
	// the existing get() helper collapses every non-2xx into a generic error.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/containers/"+id+"/json", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrDockerNotFound
	}
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("docker inspect: %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var raw dockerInspectRaw
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}

	// Project raw → typed view. Names start with '/' in Docker's response;
	// strip it so the UI gets a bare name. Default nil slices/maps to empty
	// so the JSON output is "[]" / "{}" rather than null (the frontend
	// doesn't expect nullable arrays — same convention used in NewManager).
	mounts := make([]ContainerMount, 0, len(raw.Mounts))
	for _, m := range raw.Mounts {
		src := m.Source
		if m.Type == "volume" && m.Name != "" {
			// For named volumes the host-side mountpoint isn't useful; the
			// volume name is what users actually configured.
			src = m.Name
		}
		mounts = append(mounts, ContainerMount{
			Type:        m.Type,
			Source:      src,
			Destination: m.Destination,
			Mode:        m.Mode,
			RW:          m.RW,
		})
	}

	networks := make(map[string]ContainerNetwork, len(raw.NetworkSettings.Networks))
	for name, n := range raw.NetworkSettings.Networks {
		networks[name] = ContainerNetwork{
			IPAddress:  n.IPAddress,
			Gateway:    n.Gateway,
			MacAddress: n.MacAddress,
			NetworkID:  n.NetworkID,
		}
	}

	cmd := raw.Config.Cmd
	if cmd == nil {
		cmd = []string{}
	}
	entrypoint := raw.Config.Entrypoint
	if entrypoint == nil {
		entrypoint = []string{}
	}
	env := raw.Config.Env
	if env == nil {
		env = []string{}
	}
	labels := raw.Config.Labels
	if labels == nil {
		labels = map[string]string{}
	}

	health := ""
	if raw.State.Health != nil {
		health = raw.State.Health.Status
	}

	return &ContainerInspect{
		ID:          raw.ID,
		Name:        strings.TrimPrefix(raw.Name, "/"),
		Image:       raw.Config.Image,
		ImageDigest: raw.Image,
		Created:     raw.Created,
		Platform:    raw.Platform,
		Driver:      raw.Driver,
		State: ContainerInspectState{
			Status:       raw.State.Status,
			Running:      raw.State.Running,
			Paused:       raw.State.Paused,
			Restarting:   raw.State.Restarting,
			OOMKilled:    raw.State.OOMKilled,
			ExitCode:     raw.State.ExitCode,
			Error:        raw.State.Error,
			StartedAt:    raw.State.StartedAt,
			FinishedAt:   raw.State.FinishedAt,
			Health:       health,
			Pid:          raw.State.Pid,
			RestartCount: raw.RestartCount,
		},
		Config: ContainerInspectConfig{
			Cmd:        cmd,
			Entrypoint: entrypoint,
			Env:        env,
			Labels:     labels,
			WorkingDir: raw.Config.WorkingDir,
			User:       raw.Config.User,
			Hostname:   raw.Config.Hostname,
		},
		HostConfig: ContainerInspectHost{
			RestartPolicy: raw.HostConfig.RestartPolicy.Name,
			NetworkMode:   raw.HostConfig.NetworkMode,
			Privileged:    raw.HostConfig.Privileged,
			AutoRemove:    raw.HostConfig.AutoRemove,
			MemoryLimit:   raw.HostConfig.Memory,
			NanoCpus:      raw.HostConfig.NanoCpus,
		},
		Mounts:   mounts,
		Networks: networks,
	}, nil
}

func (c *dockerClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("docker %s: %d: %s", path, resp.StatusCode, b)
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// /containers/json
type containerListItem struct {
	ID     string `json:"Id"`
	Names  []string
	Image  string
	State  string // "running", "exited", "restarting", ...
	Status string // "Up 2 days", "Restarting (1) 5 seconds ago"
	Labels map[string]string
	Ports  []struct {
		IP          string `json:"IP"`
		PrivatePort int    `json:"PrivatePort"`
		PublicPort  int    `json:"PublicPort"`
		Type        string `json:"Type"`
	}
}

// /containers/{id}/stats?stream=false
type dockerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64 `json:"usage"`
		Stats struct {
			Cache         uint64 `json:"cache"`
			InactiveFile  uint64 `json:"inactive_file"`
		} `json:"stats"`
	} `json:"memory_stats"`
}

func (s *dockerStats) cpuPercent() float64 {
	cpuDelta := float64(s.CPUStats.CPUUsage.TotalUsage) - float64(s.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(s.CPUStats.SystemCPUUsage) - float64(s.PreCPUStats.SystemCPUUsage)
	cpus := float64(s.CPUStats.OnlineCPUs)
	if cpus == 0 {
		cpus = 1
	}
	if sysDelta > 0 && cpuDelta >= 0 {
		return (cpuDelta / sysDelta) * cpus * 100
	}
	return 0
}

func (s *dockerStats) memMB() float64 {
	used := s.MemoryStats.Usage
	// Subtract cache (matches `docker stats` displayed value).
	if s.MemoryStats.Stats.Cache > 0 && s.MemoryStats.Stats.Cache <= used {
		used -= s.MemoryStats.Stats.Cache
	} else if s.MemoryStats.Stats.InactiveFile > 0 && s.MemoryStats.Stats.InactiveFile <= used {
		used -= s.MemoryStats.Stats.InactiveFile
	}
	return float64(used) / 1024 / 1024
}

func (c *dockerClient) listContainers(ctx context.Context) ([]containerListItem, error) {
	var out []containerListItem
	if err := c.get(ctx, "/containers/json?all=1", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// /system/df shape. We pull a larger field set than the cards' aggregate
// numbers strictly need so the reclaim flows can list per-item details
// (names, ages, sizes) without a second round trip per category.
type dockerSystemDF struct {
	LayersSize int64 `json:"LayersSize"`
	Images     []struct {
		ID         string   `json:"Id"`
		RepoTags   []string `json:"RepoTags"`
		Created    int64    `json:"Created"` // unix seconds
		Size       int64    `json:"Size"`
		SharedSize int64    `json:"SharedSize"`
		Containers int      `json:"Containers"`
	} `json:"Images"`
	Containers []struct {
		ID         string   `json:"Id"`
		Names      []string `json:"Names"`
		Image      string   `json:"Image"`
		Created    int64    `json:"Created"` // unix seconds
		SizeRw     int64    `json:"SizeRw"`
		SizeRootFs int64    `json:"SizeRootFs"`
		State      string   `json:"State"`
		Status     string   `json:"Status"`
	} `json:"Containers"`
	Volumes []struct {
		Name      string `json:"Name"`
		CreatedAt string `json:"CreatedAt"` // RFC3339; "" if older docker
		UsageData struct {
			Size     int64 `json:"Size"`
			RefCount int   `json:"RefCount"`
		} `json:"UsageData"`
	} `json:"Volumes"`
	BuildCache []struct {
		ID         string `json:"ID"`
		Size       int64  `json:"Size"`
		InUse      bool   `json:"InUse"`
		CreatedAt  string `json:"CreatedAt"`
		LastUsedAt string `json:"LastUsedAt"`
	} `json:"BuildCache"`
}

func (c *dockerClient) systemDF(ctx context.Context) (*dockerSystemDF, error) {
	var out dockerSystemDF
	if err := c.get(ctx, "/system/df", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// collectDockerDF compresses /system/df into our flat schema.
func (m *Manager) collectDockerDF(ctx context.Context) DockerDF {
	if !m.docker.available() {
		return DockerDF{}
	}
	df, err := m.docker.systemDF(ctx)
	if err != nil {
		return DockerDF{}
	}

	var images DockerDFCategory
	for _, i := range df.Images {
		images.Count++
		images.SizeBytes += i.Size
		if i.Containers == 0 {
			images.ReclaimBytes += i.Size
		} else {
			images.Active++
		}
	}

	var containers DockerDFCategory
	for _, c := range df.Containers {
		containers.Count++
		containers.SizeBytes += c.SizeRw
		if c.State == "running" {
			containers.Active++
		} else {
			containers.ReclaimBytes += c.SizeRw
		}
	}

	var volumes DockerDFCategory
	for _, v := range df.Volumes {
		volumes.Count++
		volumes.SizeBytes += v.UsageData.Size
		if v.UsageData.RefCount > 0 {
			volumes.Active++
		} else {
			volumes.ReclaimBytes += v.UsageData.Size
		}
	}

	var bc DockerDFCategory
	for _, b := range df.BuildCache {
		bc.Count++
		bc.SizeBytes += b.Size
		if b.InUse {
			bc.Active++
		} else {
			bc.ReclaimBytes += b.Size
		}
	}

	return DockerDF{
		Images:     images,
		Containers: containers,
		Volumes:    volumes,
		BuildCache: bc,
	}
}

// ---------------------------------------------------------------------------
// Reclaim — list per-item reclaimables + remove/prune
// ---------------------------------------------------------------------------
//
// /system/df is the one source of truth. We re-query it on every list call
// (rather than reading the cached snapshot) so the modal shows the user
// what's reclaimable right now — between the medium-tick cache and a
// click, containers can stop or start and the in-use/orphan status flips.

// listReclaimableImages returns images with zero container references
// (running OR stopped). Repo tag picked as the first entry; "<none>" when
// the image is dangling (lost its tag, e.g. after a rebuild).
func (c *dockerClient) listReclaimableImages(ctx context.Context) ([]ReclaimableImage, error) {
	df, err := c.systemDF(ctx)
	if err != nil {
		return nil, err
	}
	out := []ReclaimableImage{}
	for _, im := range df.Images {
		if im.Containers > 0 {
			continue
		}
		tag := "<none>"
		if len(im.RepoTags) > 0 {
			tag = im.RepoTags[0]
		}
		out = append(out, ReclaimableImage{
			ID:        im.ID,
			RepoTag:   tag,
			SizeBytes: im.Size,
			CreatedAt: time.Unix(im.Created, 0).UTC().Format(time.RFC3339),
		})
	}
	return out, nil
}

// listReclaimableContainers returns non-running containers (exited,
// dead, created-but-never-started). Includes stopped containers' writable
// layer size so the user sees what they'd actually free.
func (c *dockerClient) listReclaimableContainers(ctx context.Context) ([]ReclaimableContainer, error) {
	df, err := c.systemDF(ctx)
	if err != nil {
		return nil, err
	}
	out := []ReclaimableContainer{}
	for _, ct := range df.Containers {
		if ct.State == "running" {
			continue
		}
		name := ""
		if len(ct.Names) > 0 {
			name = strings.TrimPrefix(ct.Names[0], "/")
		}
		out = append(out, ReclaimableContainer{
			ID:        ct.ID,
			Name:      name,
			Image:     ct.Image,
			State:     ct.State,
			Status:    ct.Status,
			SizeBytes: ct.SizeRw,
			CreatedAt: time.Unix(ct.Created, 0).UTC().Format(time.RFC3339),
		})
	}
	return out, nil
}

// listReclaimableVolumes returns volumes with refCount == 0. Includes
// CreatedAt from docker (older daemons may report empty string — frontend
// renders "—" in that case).
func (c *dockerClient) listReclaimableVolumes(ctx context.Context) ([]ReclaimableVolume, error) {
	df, err := c.systemDF(ctx)
	if err != nil {
		return nil, err
	}
	out := []ReclaimableVolume{}
	for _, v := range df.Volumes {
		if v.UsageData.RefCount > 0 {
			continue
		}
		out = append(out, ReclaimableVolume{
			Name:      v.Name,
			SizeBytes: v.UsageData.Size,
			CreatedAt: v.CreatedAt,
		})
	}
	return out, nil
}

// removeImage deletes one image. `force` is required when an image is
// referenced by multiple tags or by stopped containers' image ID.
func (c *dockerClient) removeImage(ctx context.Context, id string, force bool) error {
	path := fmt.Sprintf("/images/%s?force=%t", id, force)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.cmd.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	case http.StatusNotFound:
		_, _ = io.Copy(io.Discard, resp.Body)
		return ErrDockerNotFound
	case http.StatusConflict:
		_, _ = io.Copy(io.Discard, resp.Body)
		return ErrImageInUse
	default:
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("docker rmi: %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
}

// removeVolume deletes one volume. force is rarely needed for unreferenced
// volumes; included for symmetry with the other remove helpers.
func (c *dockerClient) removeVolume(ctx context.Context, name string, force bool) error {
	path := fmt.Sprintf("/volumes/%s?force=%t", name, force)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.cmd.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNoContent:
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	case http.StatusNotFound:
		_, _ = io.Copy(io.Discard, resp.Body)
		return ErrDockerNotFound
	case http.StatusConflict:
		_, _ = io.Copy(io.Discard, resp.Body)
		return ErrVolumeInUse
	default:
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("docker volume rm: %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
}

// pruneBuildCache is the one no-per-item helper — build-cache layers
// don't have human-meaningful identifiers so we skip the list flow and
// just prune. Docker returns the freed byte total.
//
// `all=1` is required so we actually clear every cache entry whose
// InUse=false (which is exactly what the dashboard's "reclaimable"
// number sums up — see collectDockerDF). Without it, Docker defaults to
// pruning only "dangling" cache, a strict subset; the prune would
// succeed but report SpaceReclaimed=0 and the dashboard's count
// wouldn't move. The user already opted in by clicking Reclaim, so we
// respect the displayed number.
func (c *dockerClient) pruneBuildCache(ctx context.Context) (freedBytes int64, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://docker/build/prune?all=1", nil)
	if err != nil {
		return 0, err
	}
	resp, err := c.cmd.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return 0, fmt.Errorf("docker build prune: %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var out struct {
		SpaceReclaimed int64 `json:"SpaceReclaimed"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, err
	}
	return out.SpaceReclaimed, nil
}

func (c *dockerClient) statsOnce(ctx context.Context, id string) (*dockerStats, error) {
	var out dockerStats
	if err := c.get(ctx, "/containers/"+id+"/stats?stream=false&one-shot=true", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// (m *Manager).collectContainers fetches all containers and their live stats.
// Stats are queried in parallel with a bounded pool to keep refresh fast.
func (m *Manager) collectContainers(ctx context.Context) ([]Container, error) {
	if !m.docker.available() {
		return nil, errors.New("docker socket not available")
	}
	list, err := m.docker.listContainers(ctx)
	if err != nil {
		return nil, err
	}

	type result struct {
		i  int
		st *dockerStats
	}
	results := make(chan result, len(list))
	sem := make(chan struct{}, 8) // up to 8 concurrent stats calls
	for i, it := range list {
		if it.State != "running" {
			results <- result{i: i, st: nil}
			continue
		}
		sem <- struct{}{}
		go func(i int, id string) {
			defer func() { <-sem }()
			st, err := m.docker.statsOnce(ctx, id)
			if err != nil {
				st = nil
			}
			results <- result{i: i, st: st}
		}(i, it.ID)
	}
	stats := make([]*dockerStats, len(list))
	for range list {
		r := <-results
		stats[r.i] = r.st
	}

	hostPortToContainer := map[int]string{}
	out := make([]Container, 0, len(list))
	for i, it := range list {
		name := "?"
		if len(it.Names) > 0 {
			name = strings.TrimPrefix(it.Names[0], "/")
		}
		var cpuPtr, memPtr *float64
		if stats[i] != nil {
			c := roundTo(stats[i].cpuPercent(), 1)
			mem := roundTo(stats[i].memMB(), 1)
			cpuPtr, memPtr = &c, &mem
		}
		// Docker lists ports per protocol-family (v4 + v6) so the same
		// publication shows up twice; dedupe on the canonical "public:private".
		seenP := map[string]bool{}
		ports := []string{}
		for _, p := range it.Ports {
			var s string
			if p.PublicPort != 0 {
				s = fmt.Sprintf("%d:%d", p.PublicPort, p.PrivatePort)
				hostPortToContainer[p.PublicPort] = name
			} else if p.PrivatePort != 0 {
				s = fmt.Sprintf("%d", p.PrivatePort)
			} else {
				continue
			}
			if seenP[s] {
				continue
			}
			seenP[s] = true
			ports = append(ports, s)
		}
		out = append(out, Container{
			ID:     it.ID,
			Name:   name,
			Status: it.State,
			Uptime: humanUptime(it.Status),
			CPU:    cpuPtr,
			Mem:    memPtr,
			Image:  it.Image,
			Ports:  ports,
			// Compose tags every container it creates with these labels —
			// empty strings when the container was started outside compose.
			Stack:            it.Labels["com.docker.compose.project"],
			StackWorkingDir:  it.Labels["com.docker.compose.project.working_dir"],
			StackConfigFiles: it.Labels["com.docker.compose.project.config_files"],
		})
	}
	setDockerHostPortMap(hostPortToContainer)
	return out, nil
}

// humanUptime extracts the relative uptime suffix from a docker Status string
// like "Up 2 days (healthy)".
func humanUptime(status string) string {
	s := strings.TrimSpace(status)
	if !strings.HasPrefix(s, "Up ") {
		return "—"
	}
	s = strings.TrimPrefix(s, "Up ")
	// strip trailing "(healthy)" / "(unhealthy)" annotations
	if i := strings.Index(s, " ("); i > 0 {
		s = s[:i]
	}
	return s
}
