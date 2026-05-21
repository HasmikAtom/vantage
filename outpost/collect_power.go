package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// RAPL (Intel/AMD) power draw via /sys/class/powercap/intel-rapl
// ---------------------------------------------------------------------------
//
// Each domain exposes a monotonic energy_uj counter in microjoules. Watts =
// Δenergy / Δtime. The counter is root-only (mode 0400) — works inside our
// container because the backend runs as root with SYS_ADMIN. AMD systems
// expose the same interface via amd_energy on recent kernels.
//
// The counter wraps at max_energy_range_uj (typically every ~60s under load
// on consumer Intel), so a negative delta means we crossed the rollover.

type raplSample struct {
	energyUJ float64
	maxUJ    float64
	at       time.Time
}

var (
	raplMu   sync.Mutex
	raplLast = map[string]raplSample{}
)

// readRAPLPower returns CPU package + DRAM watts, summed across sockets.
// Returns zeros silently when RAPL isn't exposed. First call after start
// returns zeros for every domain — we need two samples to diff.
func readRAPLPower() (cpuW, dramW float64) {
	root := sysPath("class", "powercap")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, e := range entries {
		name := e.Name()
		// Top-level CPU packages are "intel-rapl:N". Sub-domains like
		// "intel-rapl:0:1" (core, dram, uncore) have two colon groups —
		// we descend into the package dir to find them.
		if !strings.HasPrefix(name, "intel-rapl:") || strings.Count(name, ":") != 1 {
			continue
		}
		dir := filepath.Join(root, name)
		if dn := readSysString(filepath.Join(dir, "name")); !strings.HasPrefix(dn, "package") {
			continue
		}
		if w, ok := sampleRAPL(dir); ok {
			cpuW += w
		}
		subs, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, sub := range subs {
			subName := sub.Name()
			if !strings.HasPrefix(subName, "intel-rapl:") {
				continue
			}
			subDir := filepath.Join(dir, subName)
			if readSysString(filepath.Join(subDir, "name")) != "dram" {
				continue
			}
			if w, ok := sampleRAPL(subDir); ok {
				dramW += w
			}
		}
	}
	return roundTo(cpuW, 1), roundTo(dramW, 1)
}

// sampleRAPL reads energy_uj for a single domain, diffs against the previous
// sample, returns watts. First call seeds the cache and returns (0, false).
func sampleRAPL(domainDir string) (float64, bool) {
	path := filepath.Join(domainDir, "energy_uj")
	raw, ok := readSysFloat(path)
	if !ok {
		return 0, false
	}
	now := time.Now()

	raplMu.Lock()
	defer raplMu.Unlock()

	prev, hasPrev := raplLast[path]
	maxUJ := prev.maxUJ
	if maxUJ == 0 {
		if m, ok := readSysFloat(filepath.Join(domainDir, "max_energy_range_uj")); ok {
			maxUJ = m
		}
	}
	raplLast[path] = raplSample{energyUJ: raw, maxUJ: maxUJ, at: now}

	if !hasPrev {
		return 0, false
	}
	dt := now.Sub(prev.at).Seconds()
	if dt <= 0 {
		return 0, false
	}
	delta := raw - prev.energyUJ
	if delta < 0 && maxUJ > 0 {
		delta = (maxUJ - prev.energyUJ) + raw
	}
	if delta < 0 {
		return 0, false
	}
	return delta / 1_000_000 / dt, true
}
