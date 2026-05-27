package main

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// Threshold tuples — warn first, crit second. Values match Glances'
// shipped defaults so an operator familiar with one dashboard reads the
// same severity in the other.
const (
	alertCPUWarn  = 70.0
	alertCPUCrit  = 90.0
	alertMemWarn  = 70.0
	alertMemCrit  = 90.0
	alertSwapWarn = 50.0
	alertSwapCrit = 90.0
	// loadavg is normalised by core count before comparison — a single
	// pegged core on a 32-thread box should not page the operator.
	alertLoadWarn = 0.70
	alertLoadCrit = 1.00
	// fs / disk percent thresholds — separate from mem because a 70% used
	// disk isn't worth a warning on most boxes (Glances default is 90/95).
	alertFSWarn = 90.0
	alertFSCrit = 95.0
	// sensor fraction (value / sensor.max) — covers CPU package, GPU,
	// NVMe, etc. uniformly. We only alert sensors that publish a Max so
	// the dashboard never invents a threshold for a fan-speed probe.
	alertSensorWarn = 0.85
	alertSensorCrit = 0.95
	// Hysteresis: re-arming the next alert window requires the metric to
	// drop AT LEAST this far below threshold first. Stops a metric that
	// hovers near the line from emitting an event every tick.
	alertHysteresis = 5.0
	// History ring buffer. Closed events older than this fall off so the
	// snapshot stays bounded — the UI shows the most recent N regardless.
	alertHistoryMax = 30
)

// alertEngine runs the threshold state machine across collector ticks.
// One instance per Manager; all access is serialised by mu so the SSE
// fanout doesn't need its own lock around the alerts slice.
type alertEngine struct {
	mu      sync.Mutex
	open    map[string]*AlertEvent // metric ID → currently-open window
	history []AlertEvent           // most-recent-first, capped at alertHistoryMax
	// dropped tracks metrics that recently closed below the line — used
	// to require a hysteresis margin before a fresh alert can re-arm.
	// Value is the threshold the metric was last alerted against, so we
	// can require it to fall to (threshold - alertHysteresis).
	dropped map[string]float64
}

func newAlertEngine() *alertEngine {
	return &alertEngine{
		open:    map[string]*AlertEvent{},
		dropped: map[string]float64{},
	}
}

// observe applies one threshold check against a metric and updates the
// engine's state. id is the stable metric key (e.g. "cpu", "fs:/data");
// label is the human-readable form for UI display.
func (e *alertEngine) observe(now time.Time, id, label, unit string, value, warn, crit float64) {
	var severity string
	var threshold float64
	switch {
	case value >= crit:
		severity = "critical"
		threshold = crit
	case value >= warn:
		severity = "warning"
		threshold = warn
	default:
		severity = ""
	}

	cur, isOpen := e.open[id]
	if severity == "" {
		// Metric is below the line. If a window was open, close it and
		// move it to history. Either way, record the threshold we last
		// alerted on so re-arming requires the hysteresis margin.
		if isOpen {
			cur.EndedAt = now.Format(time.RFC3339)
			e.history = prependCapped(e.history, *cur, alertHistoryMax)
			delete(e.open, id)
			e.dropped[id] = cur.Threshold
		}
		return
	}

	// Re-arm gate: if the metric was previously alerting and we still
	// haven't seen it fall below threshold-hysteresis since, skip — the
	// metric is just flapping near the line.
	if !isOpen {
		if prevThresh, suppressed := e.dropped[id]; suppressed {
			if value < prevThresh-alertHysteresis {
				// Metric had fallen meaningfully but came back. Allow.
				delete(e.dropped, id)
			} else if value < prevThresh {
				// Hasn't cleared the hysteresis band — don't re-open.
				return
			}
		}
	}

	if !isOpen {
		ev := AlertEvent{
			ID:        fmt.Sprintf("%s:%d", id, now.Unix()),
			Metric:    id,
			Label:     label,
			Severity:  severity,
			BeganAt:   now.Format(time.RFC3339),
			Threshold: threshold,
			Peak:      value,
			Unit:      unit,
		}
		e.open[id] = &ev
		return
	}

	// Window is already open. Update peak; promote warning→critical when
	// the metric crosses up (but never demote — that would lose the worst
	// state the operator should see).
	if value > cur.Peak {
		cur.Peak = value
	}
	if severity == "critical" && cur.Severity == "warning" {
		cur.Severity = "critical"
		cur.Threshold = crit
	}
}

// snapshot returns the union of currently-open windows and recent
// history, freshest first. Safe to call from any goroutine.
func (e *alertEngine) snapshot() []AlertEvent {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]AlertEvent, 0, len(e.open)+len(e.history))
	for _, ev := range e.open {
		out = append(out, *ev)
	}
	out = append(out, e.history...)
	return out
}

// Evaluate runs every threshold check against the supplied snapshot and
// returns the alerts slice that should be persisted on it. The engine
// holds onto open-window state across ticks, so a metric that's been
// pegged for an hour shows up as a single long-running event rather
// than 3600 individual blips.
func (e *alertEngine) Evaluate(snap *DashboardSnapshot) []AlertEvent {
	now := time.Now()
	e.mu.Lock()
	defer e.mu.Unlock()

	e.observe(now, "cpu", "CPU", "%", snap.Headline.CPU.Pct, alertCPUWarn, alertCPUCrit)
	e.observe(now, "mem", "Memory", "%", snap.Headline.Mem.Pct, alertMemWarn, alertMemCrit)
	if snap.Headline.Swap.Total > 0 {
		e.observe(now, "swap", "Swap", "%", snap.Headline.Swap.Pct, alertSwapWarn, alertSwapCrit)
	}
	// Loadavg normalised by logical CPU count — see comment on
	// alertLoadWarn. cpuCores=0 only on collection failures; gate so we
	// don't divide by zero.
	if cores := float64(snap.System.CPUCores); cores > 0 {
		norm := snap.System.LoadAvg[0] / cores
		e.observe(now, "load", "Load (1m/core)", "", norm, alertLoadWarn, alertLoadCrit)
	}

	for _, fs := range snap.Filesystems {
		if fs.Total <= 0 {
			continue
		}
		pct := (fs.Used / fs.Total) * 100
		// Skip pseudo/synthetic mounts that legitimately run near full
		// (tmpfs at /run is often 100% by design). Only alert on
		// persistent filesystems where 95% used means trouble.
		if isAlertableFS(fs.Fstype) {
			e.observe(now, "fs:"+fs.Mount, "FS "+fs.Mount, "%", pct, alertFSWarn, alertFSCrit)
		}
	}

	for _, s := range snap.Sensors {
		if s.Max <= 0 {
			continue
		}
		frac := s.Value / s.Max
		e.observe(now, "sensor:"+s.ID, s.Label, s.Unit,
			frac*100, alertSensorWarn*100, alertSensorCrit*100)
	}

	out := make([]AlertEvent, 0, len(e.open)+len(e.history))
	for _, ev := range e.open {
		out = append(out, *ev)
	}
	out = append(out, e.history...)
	return out
}

// isAlertableFS filters out pseudo/synthetic filesystems whose usage
// number is a poor signal — tmpfs/overlay/etc. routinely report 100%
// without indicating a real problem.
func isAlertableFS(fstype string) bool {
	switch strings.ToLower(fstype) {
	case "tmpfs", "devtmpfs", "overlay", "overlayfs", "squashfs",
		"proc", "sysfs", "cgroup", "cgroup2", "bpf", "tracefs",
		"debugfs", "fusectl", "fuse.lxcfs", "binfmt_misc",
		"securityfs", "pstore", "autofs", "mqueue", "hugetlbfs",
		"ramfs":
		return false
	}
	return true
}

func prependCapped(hist []AlertEvent, ev AlertEvent, max int) []AlertEvent {
	out := make([]AlertEvent, 0, min(max, len(hist)+1))
	out = append(out, ev)
	for i := 0; i < len(hist) && len(out) < max; i++ {
		out = append(out, hist[i])
	}
	return out
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
