package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ---------------------------------------------------------------------------
// /proc/stat — CPU breakdown
// ---------------------------------------------------------------------------

type cpuJiffies struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

func (c cpuJiffies) total() uint64 {
	return c.user + c.nice + c.system + c.idle + c.iowait + c.irq + c.softirq + c.steal
}

func (c cpuJiffies) busy() uint64 {
	return c.user + c.nice + c.system + c.irq + c.softirq + c.steal
}

// cpuStats holds everything we need from a single /proc/stat read: the
// aggregate "cpu " line, ctx/intr/softirq counters, and per-core jiffies.
// Sharing one parse across cpuUsage and collectPerCoreCPU halves the I/O
// on the fast tick.
type cpuStats struct {
	aggregate cpuJiffies
	ctx       uint64
	intr      uint64
	soft      uint64
	perCore   []coreJiffies // sorted by core index
}

type coreJiffies struct {
	core int
	j    cpuJiffies
}

// readCPUStats opens /proc/stat once and pulls every field we use on the fast
// tick (both headline CPU and per-core breakdown). Returns a zero value if
// /proc/stat can't be opened.
func readCPUStats() cpuStats {
	var s cpuStats
	f, err := os.Open(procPath("stat"))
	if err != nil {
		return s
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "cpu"):
			// Distinguish "cpu " (aggregate) from "cpu0", "cpu1", ...
			rest := line[3:]
			fields := strings.Fields(line)
			if len(fields) < 8 {
				continue
			}
			var c cpuJiffies
			c.user, _ = strconv.ParseUint(fields[1], 10, 64)
			c.nice, _ = strconv.ParseUint(fields[2], 10, 64)
			c.system, _ = strconv.ParseUint(fields[3], 10, 64)
			c.idle, _ = strconv.ParseUint(fields[4], 10, 64)
			c.iowait, _ = strconv.ParseUint(fields[5], 10, 64)
			c.irq, _ = strconv.ParseUint(fields[6], 10, 64)
			c.softirq, _ = strconv.ParseUint(fields[7], 10, 64)
			if len(fields) > 8 {
				c.steal, _ = strconv.ParseUint(fields[8], 10, 64)
			}
			if len(rest) > 0 && rest[0] == ' ' {
				s.aggregate = c
				continue
			}
			// rest is "0", "1", ... terminated by whitespace
			id := strings.TrimPrefix(fields[0], "cpu")
			n, err := strconv.Atoi(id)
			if err != nil {
				continue
			}
			s.perCore = append(s.perCore, coreJiffies{core: n, j: c})
		case strings.HasPrefix(line, "ctxt "):
			s.ctx, _ = strconv.ParseUint(strings.TrimPrefix(line, "ctxt "), 10, 64)
		case strings.HasPrefix(line, "intr "):
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				s.intr, _ = strconv.ParseUint(fields[1], 10, 64)
			}
		case strings.HasPrefix(line, "softirq "):
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				s.soft, _ = strconv.ParseUint(fields[1], 10, 64)
			}
		}
	}
	return s
}

var (
	cpuLastMu       sync.Mutex
	cpuLastJ        cpuJiffies
	cpuLastCtx      uint64
	cpuLastIntr     uint64
	cpuLastSoftIntr uint64
	cpuLastReadAt   time.Time
)

// cpuUsage returns CPU breakdown + rates of context switches, hard IRQs, and
// soft IRQs (all per-second). First call after start returns zeros. The caller
// passes pre-parsed cpuStats so the fast tick only opens /proc/stat once.
func cpuUsage(s cpuStats) (pct, user, sys, idle, iowait float64, ctxRate, intrRate, softIntrRate int) {
	cur := s.aggregate
	ctx, intr, soft := s.ctx, s.intr, s.soft
	if cur.total() == 0 {
		return
	}
	now := time.Now()

	cpuLastMu.Lock()
	defer cpuLastMu.Unlock()

	prev := cpuLastJ
	prevCtx := cpuLastCtx
	prevIntr := cpuLastIntr
	prevSoft := cpuLastSoftIntr
	prevAt := cpuLastReadAt

	cpuLastJ = cur
	cpuLastCtx = ctx
	cpuLastIntr = intr
	cpuLastSoftIntr = soft
	cpuLastReadAt = now

	if prev.total() == 0 {
		return
	}
	dt := float64(cur.total() - prev.total())
	if dt <= 0 {
		return
	}
	pct = clampPct(100 * float64(cur.busy()-prev.busy()) / dt)
	user = clampPct(100 * float64(cur.user-prev.user) / dt)
	sys = clampPct(100 * float64(cur.system-prev.system) / dt)
	idle = clampPct(100 * float64(cur.idle-prev.idle) / dt)
	iowait = clampPct(100 * float64(cur.iowait-prev.iowait) / dt)

	if !prevAt.IsZero() {
		elapsed := now.Sub(prevAt).Seconds()
		if elapsed > 0 {
			ctxRate = int(float64(ctx-prevCtx) / elapsed)
			intrRate = int(float64(intr-prevIntr) / elapsed)
			softIntrRate = int(float64(soft-prevSoft) / elapsed)
		}
	}
	return
}

// ---------------------------------------------------------------------------
// /proc/meminfo
// ---------------------------------------------------------------------------

// Meminfo holds the /proc/meminfo fields we actually consume. Values are kB,
// matching the kernel's reporting units. Parsing straight into a struct saves
// ~130 allocations per read vs. the map[string]uint64 we used to build.
type Meminfo struct {
	MemTotal     uint64
	MemAvailable uint64
	MemFree      uint64
	Active       uint64
	Inactive     uint64
	Buffers      uint64
	Cached       uint64
	SwapTotal    uint64
	SwapFree     uint64
}

// readMeminfo parses /proc/meminfo into a Meminfo. Allocation-light: only the
// scanner's internal line buffer plus the struct itself.
func readMeminfo() Meminfo {
	var m Meminfo
	f, err := os.Open(procPath("meminfo"))
	if err != nil {
		return m
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	want := 9
	for s.Scan() && want > 0 {
		line := s.Bytes()
		colon := bytes.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		var dst *uint64
		// switch string(b) on a []byte is a documented compiler optimization
		// (no allocation for the conversion in a switch tag) — the way to
		// dispatch on a key without paying for a string copy.
		switch string(line[:colon]) {
		case "MemTotal":
			dst = &m.MemTotal
		case "MemAvailable":
			dst = &m.MemAvailable
		case "MemFree":
			dst = &m.MemFree
		case "Active":
			dst = &m.Active
		case "Inactive":
			dst = &m.Inactive
		case "Buffers":
			dst = &m.Buffers
		case "Cached":
			dst = &m.Cached
		case "SwapTotal":
			dst = &m.SwapTotal
		case "SwapFree":
			dst = &m.SwapFree
		default:
			continue
		}
		// Parse digits directly out of the line bytes — no substring, no
		// strconv allocation. /proc/meminfo digits are always ASCII.
		rest := line[colon+1:]
		i := 0
		for i < len(rest) && rest[i] == ' ' {
			i++
		}
		var v uint64
		for i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
			v = v*10 + uint64(rest[i]-'0')
			i++
		}
		*dst = v
		want--
	}
	return m
}

func collectMem(m Meminfo) MemHeadline {
	toGB := func(kb uint64) float64 { return float64(kb) / 1024 / 1024 }
	total := toGB(m.MemTotal)
	available := toGB(m.MemAvailable)
	used := total - available
	out := MemHeadline{
		Unit:     "GB",
		Total:    roundTo(total, 1),
		Used:     roundTo(used, 2),
		Free:     roundTo(toGB(m.MemFree), 2),
		Active:   roundTo(toGB(m.Active), 2),
		Inactive: roundTo(toGB(m.Inactive), 2),
		Buffers:  roundTo(toGB(m.Buffers), 2),
		Cached:   roundTo(toGB(m.Cached), 2),
	}
	if total > 0 {
		out.Pct = roundTo(100*used/total, 1)
	}
	return out
}

func collectSwap(m Meminfo) SwapHeadline {
	toGB := func(kb uint64) float64 { return float64(kb) / 1024 / 1024 }
	total := toGB(m.SwapTotal)
	free := toGB(m.SwapFree)
	used := total - free
	out := SwapHeadline{
		Unit:  "GB",
		Total: roundTo(total, 2),
		Free:  roundTo(free, 2),
		Used:  roundTo(used, 3),
	}
	if total > 0 {
		out.Pct = roundTo(100*used/total, 2)
	}
	return out
}

// ---------------------------------------------------------------------------
// loadavg / uptime / cpuinfo / os / kernel / hostname
// ---------------------------------------------------------------------------

func readLoadAvg() [3]float64 {
	var out [3]float64
	b, err := os.ReadFile(procPath("loadavg"))
	if err != nil {
		return out
	}
	parts := strings.Fields(string(b))
	for i := 0; i < 3 && i < len(parts); i++ {
		v, _ := strconv.ParseFloat(parts[i], 64)
		out[i] = roundTo(v, 2)
	}
	return out
}

func readUptimeSec() float64 {
	b, err := os.ReadFile(procPath("uptime"))
	if err != nil {
		return 0
	}
	parts := strings.Fields(string(b))
	if len(parts) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(parts[0], 64)
	return v
}

// readCPUModelCores walks /proc/cpuinfo for the model string and logical core
// count. These are immutable at runtime, so the caller is expected to memoise
// the result (see staticSystemOnce).
func readCPUModelCores() (model string, cores int) {
	f, err := os.Open(procPath("cpuinfo"))
	if err != nil {
		return
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := s.Text()
		kv := strings.SplitN(line, ":", 2)
		if len(kv) != 2 {
			continue
		}
		switch strings.TrimSpace(kv[0]) {
		case "model name":
			if model == "" {
				model = strings.TrimSpace(kv[1])
			}
		case "processor":
			cores++
		}
	}
	return
}

// readCPUPhysicalCores counts physical CPU cores (silicon execution units) by
// reading the per-CPU topology files exposed under
// /sys/devices/system/cpu/cpu*/topology. A physical core is identified by the
// unique (physical_package_id, core_id) pair, so SMT/HT siblings collapse
// into one count.
//
// Returns 0 if sysfs isn't readable (containerised setups without /sys
// passthrough, exotic kernels, etc.); callers should fall back to the
// logical count or display "—".
func readCPUPhysicalCores() int {
	entries, err := os.ReadDir(sysPath("devices", "system", "cpu"))
	if err != nil {
		return 0
	}
	type key struct {
		pkg, core string
	}
	seen := map[key]struct{}{}
	for _, e := range entries {
		name := e.Name()
		// Match cpu0, cpu1, ..., not cpufreq / cpuidle / etc.
		if !strings.HasPrefix(name, "cpu") {
			continue
		}
		idx := strings.TrimPrefix(name, "cpu")
		if idx == "" || !isAllDigits(idx) {
			continue
		}
		pkg, err := os.ReadFile(sysPath("devices", "system", "cpu", name, "topology", "physical_package_id"))
		if err != nil {
			continue
		}
		core, err := os.ReadFile(sysPath("devices", "system", "cpu", name, "topology", "core_id"))
		if err != nil {
			continue
		}
		seen[key{
			pkg:  strings.TrimSpace(string(pkg)),
			core: strings.TrimSpace(string(core)),
		}] = struct{}{}
	}
	return len(seen)
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// readCPUClock returns the first "cpu MHz" value from /proc/cpuinfo and stops
// scanning immediately. /proc/cpuinfo on multi-core boxes is large, but the
// first cpu0 block carries everything we need; bailing early avoids parsing
// the remaining 7-31 identical sections.
func readCPUClock() float64 {
	f, err := os.Open(procPath("cpuinfo"))
	if err != nil {
		return 0
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := s.Text()
		if !strings.HasPrefix(line, "cpu MHz") {
			continue
		}
		kv := strings.SplitN(line, ":", 2)
		if len(kv) == 2 {
			v, _ := strconv.ParseFloat(strings.TrimSpace(kv[1]), 64)
			return v
		}
	}
	return 0
}

func readOSPretty() string {
	f, err := os.Open(etcPath("os-release"))
	if err != nil {
		return ""
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := s.Text()
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
		}
	}
	return ""
}

func readKernel() string {
	var u syscall.Utsname
	if err := syscall.Uname(&u); err != nil {
		return ""
	}
	return "Linux " + utsToString(u.Release[:])
}

func utsToString(b []int8) string {
	out := make([]byte, 0, len(b))
	for _, c := range b {
		if c == 0 {
			break
		}
		out = append(out, byte(c))
	}
	return string(out)
}

func readHostname() string {
	if b, err := os.ReadFile(etcPath("hostname")); err == nil {
		return strings.TrimSpace(string(b))
	}
	h, _ := os.Hostname()
	return h
}

func readMachineID() string {
	for _, p := range []string{etcPath("machine-id"), etcPath("..", "var", "lib", "dbus", "machine-id")} {
		if b, err := os.ReadFile(p); err == nil {
			s := strings.TrimSpace(string(b))
			if len(s) >= 12 {
				return s[:12]
			}
			return s
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// composite: SystemInfo
// ---------------------------------------------------------------------------

// Static (effectively immutable) system identity. Read once on the first
// collectSystem() call and reused — hostname, OS pretty name, kernel uname,
// machine-id, CPU model and logical-core count don't change at runtime.
// A user who renames their host or upgrades their kernel needs to restart the
// backend anyway; not worth re-reading these files every 2s.
var (
	staticSystemOnce sync.Once
	staticHostname   string
	staticFingerprint string
	staticOS         string
	staticKernel     string
	staticCPUModel          string
	staticCPUCores          int
	staticCPUPhysicalCores  int
)

func loadStaticSystem() {
	staticHostname = readHostname()
	staticFingerprint = readMachineID()
	staticOS = readOSPretty()
	staticKernel = readKernel()
	staticCPUModel, staticCPUCores = readCPUModelCores()
	staticCPUPhysicalCores = readCPUPhysicalCores()
	// On weird hardware / containerised setups where /sys topology isn't
	// available, fall back to the logical count so the UI doesn't render
	// "0 cores". The frontend can still infer SMT is absent from
	// physical == logical.
	if staticCPUPhysicalCores == 0 {
		staticCPUPhysicalCores = staticCPUCores
	}
}

func collectSystem() SystemInfo {
	staticSystemOnce.Do(loadStaticSystem)
	clock := readCPUClock()
	uptime := readUptimeSec()
	bootedAt := time.Now().Add(-time.Duration(uptime * float64(time.Second)))
	d := int(uptime / 86400)
	h := int(uptime/3600) % 24
	mn := int(uptime/60) % 60

	return SystemInfo{
		Hostname:    staticHostname,
		Fingerprint: staticFingerprint,
		OS:          staticOS,
		Kernel:      staticKernel,
		CPUModel:         staticCPUModel,
		CPUClock:         fmt.Sprintf("%.2f MHz observed", clock),
		CPUCores:         staticCPUCores,
		CPUPhysicalCores: staticCPUPhysicalCores,
		UptimeText:  fmt.Sprintf("%dd %02dh %02dm", d, h, mn),
		UptimeDays:  d,
		BootedAt:    bootedAt.Format("Jan 2, 2006 · 15:04 MST"),
		TimeText:    time.Now().Format("2006-01-02 · 15:04:05 MST"),
		LoadAvg:     readLoadAvg(),
	}
}

// collectHeadline composes the four hero metrics + their sparkline rings.
// Sparkline data lives in the Manager's history map, so we accept a setter.
type headlineSparks struct {
	cpu, gpu, mem, storage []float64
}

// collectHeadline takes the tick-shared cpuStats + Meminfo so /proc/stat and
// /proc/meminfo are each only opened once per refreshFast.
func (m *Manager) collectHeadline(ctx context.Context, cpu cpuStats, mi Meminfo) (Headline, headlineSparks) {
	pct, user, sys, idle, iowait, ctxRate, intrRate, softRate := cpuUsage(cpu)

	mem := collectMem(mi)
	swap := collectSwap(mi)
	gpu := collectGPUHeadline(ctx)
	cpuTemp := readCPUTemp()
	cpuW, dramW := readRAPLPower()
	mem.PowerW = dramW
	storageUsedPct, storageHottest := storagePoolSnapshot()

	headline := Headline{
		CPU: CPUHeadline{
			Pct:        roundTo(pct, 1),
			User:       roundTo(user, 1),
			System:     roundTo(sys, 1),
			Idle:       roundTo(idle, 1),
			Iowait:     roundTo(iowait, 1),
			CtxSwitch:  ctxRate,
			Interrupts: intrRate,
			SoftInt:    softRate,
			Temp:       cpuTemp,
			PowerW:     cpuW,
		},
		GPU:  gpu,
		Mem:  mem,
		Swap: swap,
	}

	sparks := headlineSparks{
		cpu:     m.pushHistory("h.cpu", headline.CPU.Pct),
		gpu:     m.pushHistory("h.gpu", headline.GPU.Pct),
		mem:     m.pushHistory("h.mem", headline.Mem.Pct),
		storage: m.pushHistory("h.storage", storageUsedPct),
	}

	_ = storageHottest // hottest disk temp is surfaced via the storage HeroMetric in the FE
	return headline, sparks
}
