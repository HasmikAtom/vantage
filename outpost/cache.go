package main

import (
	"context"
	"log"
	"math"
	"slices"
	"sync"
	"time"
)

const sparkLen = 24

// errTTL bounds how long a collector error sticks in the errs map after
// being set. Stale errors are pruned lazily when Errors() is read so the
// dashboard's "errors" panel stops showing entries from collectors that
// have since recovered or gone quiet.
const errTTL = 5 * time.Minute

// Manager owns the live snapshot. Background goroutines refresh different
// sections on their own cadence; HTTP handlers read a copy under RLock.
// errEntry is a collector error paired with the time it was last set, so
// Errors() can lazily prune stale entries (see errTTL).
type errEntry struct {
	msg string
	at  time.Time
}

type Manager struct {
	mu      sync.RWMutex
	snap    DashboardSnapshot
	errs    map[string]errEntry
	version uint64 // bumps under mu every time snap is replaced; used by ETag
	// historyMu guards `history` only. Split out from mu so per-sensor
	// pushHistory writes (called for every metric sample on the fast tick)
	// don't block HTTP readers calling Snapshot().
	historyMu sync.Mutex
	history   map[string][]float64 // sensorID -> ring buffer (len <= sparkLen)
	docker    *dockerClient
	cf        *cloudflareClient
	settings  *SettingsStore
	// firewall is nil when no supported backend was detected on the host;
	// the HTTP layer turns that into a clear "unsupported" response so the
	// UI can grey out controls instead of returning 500s.
	firewall  FirewallProvider
	started   time.Time
	// tunnelTick is a buffered channel the settings handler sends to when the
	// Cloudflare refresh interval (or credentials) change, asking the tunnel
	// loop to reset its timer so the next fetch uses the new cadence.
	tunnelTick chan struct{}
	// medSignal / slowSignal coalesce out-of-band refresh requests. Each
	// is a buffered-size-1 channel: handlers signal non-blockingly after
	// a mutation, and a single background loop pulls and runs the
	// refresh serialised with the regular ticker. Duplicate signals
	// collapse into one — no goroutine pile-up.
	medSignal  chan struct{}
	slowSignal chan struct{}
	// subsMu guards subs. Kept separate from mu so notify() does not have to
	// wait for HTTP readers holding mu.RLock on Snapshot().
	subsMu sync.Mutex
	subs   map[*subscription]struct{}
	// alerts holds threshold-crossing event state across collector ticks.
	// Self-locking; lock order if both are held: m.mu first, then alerts.mu.
	alerts *alertEngine
}

// subscription is a single SSE (or other long-lived) client's update channel.
// The channel is buffered with cap 1 and notify() uses a non-blocking send,
// so a slow consumer drops to "latest only" — they will still see every
// version eventually because each receive triggers a fresh snapshot read.
type subscription struct {
	ch chan struct{}
}

// Subscribe registers a listener that receives a signal every time the
// snapshot is replaced. The returned cancel must be called to release the
// slot — typically deferred when an SSE handler returns.
//
// Usage contract: subscribe FIRST, then read the initial snapshot. That
// ordering guarantees no version bump is missed — a bump between subscribe
// and the first snapshot read will leave a pending signal in the buffered
// channel, and the consumer loop picks it up on the first select.
func (m *Manager) Subscribe() (<-chan struct{}, func()) {
	s := &subscription{ch: make(chan struct{}, 1)}
	m.subsMu.Lock()
	if m.subs == nil {
		m.subs = map[*subscription]struct{}{}
	}
	m.subs[s] = struct{}{}
	m.subsMu.Unlock()
	return s.ch, func() {
		m.subsMu.Lock()
		delete(m.subs, s)
		m.subsMu.Unlock()
	}
}

// notify wakes every subscriber. The send is non-blocking: if a subscriber's
// buffer is full they already have a pending signal and will see this update
// when they next read SnapshotWithVersion(), so dropping the send is correct.
func (m *Manager) notify() {
	m.subsMu.Lock()
	for s := range m.subs {
		select {
		case s.ch <- struct{}{}:
		default:
		}
	}
	m.subsMu.Unlock()
}

func NewManager() *Manager {
	store, err := NewSettingsStore()
	if err != nil {
		log.Printf("settings store init failed: %v (settings will be unavailable)", err)
	}
	fw := detectFirewallProvider()
	if fw != nil {
		log.Printf("firewall: provider=%s", fw.Name())
	} else {
		log.Printf("firewall: no supported backend detected (ufw not on host or systemd-run missing); firewall controls will be unavailable")
	}
	return &Manager{
		errs:       map[string]errEntry{},
		history:    map[string][]float64{},
		docker:     newDockerClient(),
		cf:         newCloudflareClient(store),
		settings:   store,
		firewall:   fw,
		started:    time.Now(),
		tunnelTick: make(chan struct{}, 1),
		medSignal:  make(chan struct{}, 1),
		slowSignal: make(chan struct{}, 1),
		alerts:     newAlertEngine(),
		// Initialise every slice to non-nil so Go's json.Marshal emits "[]"
		// instead of "null". The frontend doesn't expect nullable arrays.
		snap: DashboardSnapshot{
			Sensors:     []Sensor{},
			Disks:       []Disk{},
			Filesystems: []Filesystem{},
			Tunnels:     []Tunnel{},
			Containers:  []Container{},
			Services:    []Service{},
			Ports:       []Port{},
			Network:     Network{Interfaces: []NetInterface{}, Sparkline: []int{}},
			Processes:   []ProcessInfo{},
			Cores:       []CoreUsage{},
			DiskIO:      []DiskIO{},
			Connections: []Connection{},
			Journal:     []JournalEntry{},
			Updates:     UpdateInfo{RebootPkgs: []string{}},
			Users:       UsersInfo{Users: []User{}, Groups: []Group{}},
			Alerts:      []AlertEvent{},
		},
	}
}

// Snapshot returns the current dashboard snapshot. The struct is returned
// by value but slice/map headers inside still alias the manager's backing
// arrays — this is safe by contract, not by deep-copy. See note below.
//
// Snapshot/collector contract:
//   - Collectors NEVER mutate the slices currently stored in m.snap. Every
//     refresh tick builds new slices locally and assigns them under m.mu,
//     replacing the old headers wholesale.
//   - pushHistory returns a fresh copy on every call (see slices.Clone there),
//     so per-sensor History slices stored in m.snap are not aliased back
//     into the ring buffer that the next tick will mutate.
//   - Callers of Snapshot() therefore get a consistent view for the duration
//     of one tick, even though slice backing arrays are shared. Mutating the
//     returned slices would corrupt the live snapshot — don't.
func (m *Manager) Snapshot() DashboardSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.snap
}

// SnapshotWithVersion returns the current snapshot and its version atomically
// under a single RLock so the ETag the handler emits exactly matches the bytes
// it serializes. Version is incremented every time a refresh replaces snap.
func (m *Manager) SnapshotWithVersion() (DashboardSnapshot, uint64) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.snap, m.version
}

// Errors returns a snapshot of live collector errors. Entries older than
// errTTL are pruned lazily on the way out — cheap GC piggybacked on reads.
//
// Lock pattern: take RLock to scan for staleness. If anything looks stale,
// release the RLock, take the write Lock, and re-check + delete + build the
// result map in one pass. The re-check under the write lock is what keeps
// the upgrade safe: between RUnlock and Lock, another goroutine may have
// refreshed an entry via setErr() (which updates e.at to time.Now()), so we
// re-evaluate staleness with a fresh `now` rather than the one captured
// before any contention.
func (m *Manager) Errors() map[string]string {
	m.mu.RLock()
	stale := false
	now := time.Now()
	for _, e := range m.errs {
		if now.Sub(e.at) > errTTL {
			stale = true
			break
		}
	}
	if !stale {
		out := make(map[string]string, len(m.errs))
		for k, e := range m.errs {
			out[k] = e.msg
		}
		m.mu.RUnlock()
		return out
	}
	m.mu.RUnlock()

	m.mu.Lock()
	defer m.mu.Unlock()
	now = time.Now() // refresh so a long lock-wait doesn't make us over- or under-prune
	out := make(map[string]string, len(m.errs))
	for k, e := range m.errs {
		if now.Sub(e.at) > errTTL {
			delete(m.errs, k)
			continue
		}
		out[k] = e.msg
	}
	return out
}

func (m *Manager) setErr(key string, err error) {
	m.mu.Lock()
	if err == nil {
		delete(m.errs, key)
	} else {
		m.errs[key] = errEntry{msg: err.Error(), at: time.Now()}
	}
	m.mu.Unlock()
}

// pushHistory appends v to the ring for key and returns a copy of the ring.
// Uses its own historyMu so per-sensor pushes don't contend with HTTP readers
// holding mu.RLock on Snapshot().
//
// The copy is deliberate: the returned slice ends up stored in m.snap (via
// Sensor.History, Headline sparks, etc.) and remains live for HTTP readers
// until the next refresh tick replaces it. Returning the shared ring would
// let the next pushHistory mutate the previous tick's still-served buffer.
func (m *Manager) pushHistory(key string, v float64) []float64 {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()
	buf := append(m.history[key], v)
	if len(buf) > sparkLen {
		buf = buf[len(buf)-sparkLen:]
	}
	m.history[key] = buf
	return slices.Clone(buf)
}

// Run blocks, refreshing the snapshot on tickers until ctx is cancelled.
//
// Medium and slow refreshes run in their own dedicated loop goroutines.
// That gives every cadence a single-flight guarantee — at most one
// in-flight refresh at a time — and out-of-band poke requests from
// handlers (RequestRefreshMedium / RequestRefreshSlow) coalesce through
// a size-1 buffered channel rather than spawning a goroutine each.
func (m *Manager) Run(ctx context.Context) {
	// Warm up so the first /api/dashboard hit returns real data, not zeros.
	m.refreshFast(ctx)
	m.refreshMedium(ctx)
	go m.refreshSlow(ctx)
	go m.runMediumLoop(ctx)
	go m.runSlowLoop(ctx)
	go m.runTunnelLoop(ctx)

	fast := time.NewTicker(2 * time.Second)
	defer fast.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-fast.C:
			m.refreshFast(ctx)
		}
	}
}

// runMediumLoop serializes every medium-cadence refresh — both the
// regular 15 s tick and out-of-band pokes from mutating handlers. While
// a refresh is running, additional ticks or pokes collapse into a
// single follow-up: the select pulls one event, the buffered channel
// drops any extras.
func (m *Manager) runMediumLoop(ctx context.Context) {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.refreshMedium(ctx)
		case <-m.medSignal:
			m.refreshMedium(ctx)
		}
	}
}

// runSlowLoop is the slow-cadence counterpart. Same single-flight
// guarantee: a 5-minute tick that lands while a previous slow refresh
// is still running (e.g. a 12-disk SMART sweep) is dropped rather than
// spawning a second smartctl barrage.
func (m *Manager) runSlowLoop(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.refreshSlow(ctx)
		case <-m.slowSignal:
			m.refreshSlow(ctx)
		}
	}
}

// RequestRefreshMedium asks the medium-cadence loop to run a refresh
// as soon as possible. Non-blocking; if a request is already pending
// it is silently coalesced (a single follow-up covers any number of
// pokes that land while a refresh is in flight).
func (m *Manager) RequestRefreshMedium() {
	select {
	case m.medSignal <- struct{}{}:
	default:
	}
}

// RequestRefreshSlow is the slow-cadence equivalent of
// RequestRefreshMedium. Currently used by no handler — but symmetry
// keeps the API obvious.
func (m *Manager) RequestRefreshSlow() {
	select {
	case m.slowSignal <- struct{}{}:
	default:
	}
}

// ---- fast: 2s ----
// CPU/mem/load/sensors/network/per-core/pressure/diskio — light reads, cheap.
// ctx is propagated for the rare shell-out paths (e.g. lspciModel from the
// GPU headline) so a hung subprocess can be cancelled on shutdown.
func (m *Manager) refreshFast(ctx context.Context) {
	// Open /proc/stat and /proc/meminfo ONCE per fast tick — they're each
	// consumed by two downstream collectors (CPU headline + per-core; mem
	// headline + swap headline). Sharing the parsed data halves the I/O and
	// cuts a substantial amount of allocation on the 2s cadence.
	cpuStat := readCPUStats()
	meminfo := readMeminfo()

	sys := collectSystem()
	head, headSparks := m.collectHeadline(ctx, cpuStat, meminfo)
	sensors := m.collectSensors()
	network := m.collectNetwork()
	cores := collectPerCoreCPU(cpuStat)
	pressure := collectPressure()
	diskIO := collectDiskIO()

	m.mu.Lock()
	m.snap.System = sys
	m.snap.Headline = head
	m.snap.Headline.CPUSpark = headSparks.cpu
	m.snap.Headline.GPUSpark = headSparks.gpu
	m.snap.Headline.MemSpark = headSparks.mem
	m.snap.Headline.StorageSpark = headSparks.storage
	m.snap.Sensors = sensors
	m.snap.Network = network
	m.snap.Cores = cores
	m.snap.Pressure = pressure
	m.snap.DiskIO = diskIO
	// Overlay live throughput onto the slow-collected disks so the Storage
	// tab's Disk struct carries fresh writes/reads alongside its SMART data.
	ioByID := make(map[string]DiskIO, len(diskIO))
	for _, io := range diskIO {
		ioByID[io.ID] = io
	}
	for i := range m.snap.Disks {
		if io, ok := ioByID[m.snap.Disks[i].ID]; ok {
			m.snap.Disks[i].Reads = roundTo(io.ReadBps/1024/1024, 2)
			m.snap.Disks[i].Writes = roundTo(io.WriteBps/1024/1024, 2)
		}
	}
	// Threshold evaluation runs against the snapshot we just committed.
	// Locking order: m.mu (already held) → alerts.mu (acquired inside).
	m.snap.Alerts = m.alerts.Evaluate(&m.snap)
	m.version++
	m.mu.Unlock()
	m.notify()
}

// ---- medium: 15s ----
// Filesystems (statfs), listening ports, docker containers + df,
// systemd services, established connections, top processes, updates,
// recent journal warnings.
func (m *Manager) refreshMedium(ctx context.Context) {
	fs := collectFilesystems()
	ports := collectPorts()

	containers, cerr := m.collectContainers(ctx)
	m.setErr("containers", cerr)
	services, serr := collectServices(ctx)
	m.setErr("services", serr)

	dockerDF := m.collectDockerDF(ctx)

	// Build a local-port → service map from the freshly-collected ports list
	// so the connections collector can label flows nicely.
	servicesByPort := make(map[int]string, len(ports))
	for _, p := range ports {
		servicesByPort[p.Port] = p.Service
	}
	connections := collectConnections(servicesByPort)

	processes := collectTopProcesses(10)
	updates := collectUpdates()

	journal, jerr := collectJournal(ctx, 50)
	m.setErr("journal", jerr)

	m.mu.Lock()
	m.snap.Filesystems = fs
	m.snap.Ports = ports
	if cerr == nil {
		m.snap.Containers = containers
	}
	if serr == nil {
		m.snap.Services = services
	}
	m.snap.DockerDF = dockerDF
	m.snap.Connections = connections
	m.snap.Processes = processes
	m.snap.Updates = updates
	if jerr == nil {
		m.snap.Journal = journal
	}
	m.snap.Alerts = m.alerts.Evaluate(&m.snap)
	m.version++
	m.mu.Unlock()
	m.notify()
}

// RefreshTunnelsNow forces an immediate tunnel re-fetch — useful right after
// the user saves new Cloudflare credentials so they don't wait 5 minutes for
// the slow tick.
func (m *Manager) RefreshTunnelsNow(ctx context.Context) error {
	tunnels, err := m.cf.fetchTunnels(ctx)
	m.setErr("tunnels", err)
	if err != nil {
		return err
	}
	m.mu.Lock()
	if tunnels == nil {
		tunnels = []Tunnel{}
	}
	m.snap.Tunnels = tunnels
	m.version++
	m.mu.Unlock()
	m.notify()
	return nil
}

// ---- slow: 5min ----
// SMART (spawns smartctl) + system users/groups inventory (parses /etc/passwd
// and /etc/group, both effectively static). Cloudflare tunnels live on their
// own configurable loop in runTunnelLoop so the user can change the cadence
// from the Settings page without restarting the backend.
func (m *Manager) refreshSlow(ctx context.Context) {
	disks, derr := collectDisks(ctx)
	m.setErr("disks", derr)

	users := collectUsers()

	m.mu.Lock()
	if derr == nil {
		m.snap.Disks = disks
	}
	m.snap.Users = users
	m.snap.Alerts = m.alerts.Evaluate(&m.snap)
	m.version++
	m.mu.Unlock()
	m.notify()

	if derr != nil {
		log.Printf("disks: %v", derr)
	}
}

// runTunnelLoop refreshes Cloudflare tunnels on a user-configurable
// interval. The settings handler signals tunnelTick whenever the stored
// interval (or the credentials) change, which resets the timer so the
// next fetch uses the new cadence immediately.
func (m *Manager) runTunnelLoop(ctx context.Context) {
	// Warm up — fetch once on startup if creds are available.
	_ = m.RefreshTunnelsNow(ctx)

	for {
		d := m.tunnelInterval()
		t := time.NewTimer(d)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
			_ = m.RefreshTunnelsNow(ctx)
		case <-m.tunnelTick:
			if !t.Stop() {
				select {
				case <-t.C:
				default:
				}
			}
			// loop continues; new interval read at the top
		}
	}
}

// tunnelInterval returns the user-configured cadence for Cloudflare tunnel
// fetches, falling back to DefaultCloudflareRefreshSecs when unset or out
// of bounds.
func (m *Manager) tunnelInterval() time.Duration {
	dflt := time.Duration(DefaultCloudflareRefreshSecs) * time.Second
	if m.settings == nil {
		return dflt
	}
	s, err := m.settings.Get()
	if err != nil {
		return dflt
	}
	if s.CloudflareRefreshSecs < MinCloudflareRefreshSecs ||
		s.CloudflareRefreshSecs > MaxCloudflareRefreshSecs {
		return dflt
	}
	return time.Duration(s.CloudflareRefreshSecs) * time.Second
}

// NotifyTunnelSettingsChanged kicks the tunnel loop so it re-reads the
// interval. Non-blocking — duplicate signals coalesce in the buffered
// channel.
func (m *Manager) NotifyTunnelSettingsChanged() {
	select {
	case m.tunnelTick <- struct{}{}:
	default:
	}
}

// roundTo keeps numbers compact in JSON without surprising the frontend.
func roundTo(v float64, places int) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	m := math.Pow(10, float64(places))
	return math.Round(v*m) / m
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
