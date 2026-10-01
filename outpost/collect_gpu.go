package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// PCI address discovery
// ---------------------------------------------------------------------------

// gpuPCIAddress returns the BDF (bus:device.function) of the first card with
// a DRM node, e.g. "0000:01:00.0". Reads the `device` symlink under
// /sys/class/drm/cardN/.
func gpuPCIAddress() string {
	root := sysPath("class", "drm")
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		name := e.Name()
		// Skip card1-DP-1, renderD128, etc — only consider cardN itself.
		if !strings.HasPrefix(name, "card") || strings.ContainsRune(name, '-') {
			continue
		}
		if name == "card" {
			continue
		}
		// /sys/class/drm/card1/device -> ../../../0000:01:00.0
		target, err := os.Readlink(filepath.Join(root, name, "device"))
		if err != nil {
			continue
		}
		base := filepath.Base(target)
		if pciBDF.MatchString(base) {
			return base
		}
	}
	return ""
}

var pciBDF = regexp.MustCompile(`^[0-9a-fA-F]{4}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}\.[0-9]$`)

// ---------------------------------------------------------------------------
// lspci → friendly chip model
// ---------------------------------------------------------------------------

var (
	lspciCacheMu   sync.RWMutex
	lspciCacheVal  string
	lspciCacheKey  string
	lspciCacheUntil time.Time
)

// lspciModel runs `lspci -vmm -s <addr>` once per hour and returns a short
// display name such as "AMD Radeon RX 570 Armor 8G OC" (see gpuNameFromVmm).
func lspciModel(ctx context.Context, addr string) string {
	lspciCacheMu.RLock()
	if lspciCacheKey == addr && time.Now().Before(lspciCacheUntil) {
		v := lspciCacheVal
		lspciCacheMu.RUnlock()
		return v
	}
	lspciCacheMu.RUnlock()

	if _, err := exec.LookPath("lspci"); err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "lspci", "-vmm", "-s", addr).Output()
	if err != nil {
		return ""
	}
	model := gpuNameFromVmm(string(out))

	lspciCacheMu.Lock()
	lspciCacheKey = addr
	lspciCacheVal = model
	lspciCacheUntil = time.Now().Add(1 * time.Hour)
	lspciCacheMu.Unlock()

	return model
}

// gpuNameFromVmm builds a display name from `lspci -vmm` output: a short
// vendor plus the board model from the subsystem line ("Radeon RX 570 Armor
// 8G OC"), or else the marketing name in the device line's brackets
// ("Ellesmere [Radeon RX 470/480/570…]" → "Radeon RX 470/480/570…"), or
// else the device line itself. lspci prints "Device 341b" for a subsystem
// it doesn't know; that is skipped.
func gpuNameFromVmm(out string) string {
	fields := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok {
			fields[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	vendor := shortGPUVendor(fields["Vendor"])
	model := fields["SDevice"]
	if model == "" || unknownPCIName.MatchString(model) {
		model = fields["Device"]
		if i, j := strings.Index(model, "["), strings.LastIndex(model, "]"); i >= 0 && j > i {
			model = model[i+1 : j]
		}
	}
	if model == "" || unknownPCIName.MatchString(model) {
		return ""
	}
	if vendor == "" || strings.HasPrefix(strings.ToLower(model), strings.ToLower(vendor)) {
		return model
	}
	return vendor + " " + model
}

var unknownPCIName = regexp.MustCompile(`^Device [0-9a-fA-F]{4}$`)

func shortGPUVendor(v string) string {
	switch {
	case strings.Contains(v, "AMD"), strings.Contains(v, "ATI"):
		return "AMD"
	case strings.Contains(v, "NVIDIA"):
		return "NVIDIA"
	case strings.Contains(v, "Intel"):
		return "Intel"
	}
	return ""
}

// ---------------------------------------------------------------------------
// PCIe link state — /sys/bus/pci/devices/<addr>/{current,max}_link_{speed,width}
// ---------------------------------------------------------------------------

func readPCIeLink(addr string) PCIeLink {
	base := sysPath("bus", "pci", "devices", addr)
	return PCIeLink{
		CurrentSpeed: readSysString(filepath.Join(base, "current_link_speed")),
		CurrentWidth: atoiOr0(readSysString(filepath.Join(base, "current_link_width"))),
		MaxSpeed:     readSysString(filepath.Join(base, "max_link_speed")),
		MaxWidth:     atoiOr0(readSysString(filepath.Join(base, "max_link_width"))),
	}
}

func atoiOr0(s string) int {
	v, _ := strconv.Atoi(strings.TrimSpace(s))
	return v
}

// ---------------------------------------------------------------------------
// GPU clocks via debugfs (Nouveau pstate)
// ---------------------------------------------------------------------------
//
// Format on Kepler (Ubuntu kernel 6.x):
//
//   07: core 324 MHz memory 648 MHz
//   0a: core 324-862 MHz memory 1620 MHz
//   AC: core 324 MHz memory 648 MHz
//
// The "AC:" line is the dashboard's source of truth — it tracks the current
// clocks as they change. No "*" marker on this driver build. Some other
// builds put the active p-state ID at the end with a "*" suffix; we accept
// both shapes.

var pstateLine = regexp.MustCompile(
	`^([0-9a-fA-FACDC*-]+):\s+core\s+(\d+)(?:-(\d+))?\s*(?:MHz)?\s+memory\s+(\d+)\s*(?:MHz)?`,
)

func readGPUClocks() (coreMHz, memMHz int, pstate string) {
	// debugfs sits under the regular / mount, accessible via /hostfs.
	// Path varies by kernel: dri/0, dri/1, dri/128, or PCI-BDF folder.
	candidates := []string{
		"/sys/kernel/debug/dri/0/pstate",
		"/sys/kernel/debug/dri/1/pstate",
		"/sys/kernel/debug/dri/128/pstate",
	}
	if addr := gpuPCIAddress(); addr != "" {
		candidates = append(candidates, "/sys/kernel/debug/dri/"+addr+"/pstate")
	}
	var b []byte
	var err error
	for _, p := range candidates {
		b, err = os.ReadFile(hostFsPath(p))
		if err == nil {
			break
		}
	}
	if err != nil || len(b) == 0 {
		return
	}

	var acCore, acMem int
	for _, line := range strings.Split(string(b), "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		starred := strings.HasSuffix(t, "*")
		m := pstateLine.FindStringSubmatch(strings.TrimSuffix(t, "*"))
		if m == nil {
			continue
		}
		id := m[1]
		core, _ := strconv.Atoi(m[2])
		// m[3] is the upper bound of a range (e.g. "862" in "324-862");
		// when present, prefer the upper bound for "max sustained" feel.
		if m[3] != "" {
			if hi, _ := strconv.Atoi(m[3]); hi > core {
				core = hi
			}
		}
		mem, _ := strconv.Atoi(m[4])

		if id == "AC" {
			acCore, acMem = core, mem
			pstate = "AC"
		}
		if starred {
			return core, mem, id
		}
	}
	if acCore > 0 || acMem > 0 {
		return acCore, acMem, pstate
	}
	return
}

// ---------------------------------------------------------------------------
// Processes with /dev/dri/* open
// ---------------------------------------------------------------------------

func listGPUProcesses() []GPUProcess {
	procRoot := procPath()
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return nil
	}
	seen := map[int]GPUProcess{}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		fdDir := procPath(strconv.Itoa(pid), "fd")
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			continue
		}
		for _, fd := range fds {
			target, err := os.Readlink(filepath.Join(fdDir, fd.Name()))
			if err != nil {
				continue
			}
			if !strings.HasPrefix(target, "/dev/dri/") {
				continue
			}
			// First device-open per PID wins so we don't list a process twice
			// for opening both card1 and renderD128 (very common).
			if _, taken := seen[pid]; taken {
				continue
			}
			seen[pid] = GPUProcess{
				PID:    pid,
				Name:   readProcessName(pid),
				Device: target,
			}
		}
	}
	out := make([]GPUProcess, 0, len(seen))
	for _, p := range seen {
		out = append(out, p)
	}
	return out
}

// ---------------------------------------------------------------------------
// hwmon: temperature, fan, power, voltage
// ---------------------------------------------------------------------------

// applyGPUHwmon fills the fields a GPU's hwmon directory reports. Files a
// driver doesn't provide leave their field at zero.
func applyGPUHwmon(out *GPUHeadline, dir string) {
	if temp, ok := readSysFloat(filepath.Join(dir, "temp1_input")); ok {
		out.Temp = int(temp / 1000)
	}
	// Fan PWM as a percentage of the driver's range (0–255 when unstated).
	if pwm, ok := readSysFloat(filepath.Join(dir, "pwm1")); ok {
		max, ok := readSysFloat(filepath.Join(dir, "pwm1_max"))
		if !ok || max <= 0 {
			max = 255
		}
		out.Fan = int(roundTo(100*pwm/max, 0))
	}
	if rpm, ok := readSysFloat(filepath.Join(dir, "fan1_input")); ok {
		out.FanRPM = int(rpm)
	}
	// Power in microwatts: the driver's average when it has one (amdgpu on
	// older kernels), else the instant reading.
	if p, ok := readSysFloat(filepath.Join(dir, "power1_average")); ok {
		out.PowerW = roundTo(p/1_000_000, 1)
	} else if p, ok := readSysFloat(filepath.Join(dir, "power1_input")); ok {
		out.PowerW = roundTo(p/1_000_000, 1)
	}
	if p, ok := readSysFloat(filepath.Join(dir, "power1_cap")); ok {
		out.PowerCapW = roundTo(p/1_000_000, 0)
	}
	// Core voltage — millivolts.
	if v, ok := readSysFloat(filepath.Join(dir, "in0_input")); ok {
		out.VoltageV = roundTo(v/1000, 3)
	}
}

// ---------------------------------------------------------------------------
// amdgpu: busy %, VRAM and DPM clocks from the PCI device directory
// ---------------------------------------------------------------------------

// applyAMDGPU reads amdgpu's sysfs files in devDir. On other drivers the
// files don't exist and nothing is changed.
func applyAMDGPU(out *GPUHeadline, devDir string) {
	if busy, ok := readSysFloat(filepath.Join(devDir, "gpu_busy_percent")); ok {
		out.Pct = busy
	}
	used, okU := readSysFloat(filepath.Join(devDir, "mem_info_vram_used"))
	total, okT := readSysFloat(filepath.Join(devDir, "mem_info_vram_total"))
	if okU && okT && total > 0 {
		const gb = 1 << 30
		out.VRAM = VRAM{Used: roundTo(used/gb, 2), Total: roundTo(total/gb, 2), Unit: "GB"}
	}
	if b, err := os.ReadFile(filepath.Join(devDir, "pp_dpm_sclk")); err == nil {
		if mhz, level, levels := parseDPM(string(b)); mhz > 0 {
			out.CoreMHz = mhz
			out.PState = strconv.Itoa(level) + " of " + strconv.Itoa(levels-1)
		}
	}
	if b, err := os.ReadFile(filepath.Join(devDir, "pp_dpm_mclk")); err == nil {
		if mhz, _, _ := parseDPM(string(b)); mhz > 0 {
			out.MemMHz = mhz
		}
	}
}

// parseDPM reads an amdgpu pp_dpm_* list ("0: 300Mhz *" per level, the
// active one starred) and returns the active clock, its level, and how many
// levels there are. mhz is 0 when no level is marked active.
func parseDPM(s string) (mhz, level, levels int) {
	for _, line := range strings.Split(s, "\n") {
		m := dpmLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		levels++
		if m[3] == "*" {
			level, _ = strconv.Atoi(m[1])
			mhz, _ = strconv.Atoi(m[2])
		}
	}
	return mhz, level, levels
}

var dpmLine = regexp.MustCompile(`^\s*(\d+):\s*(\d+)\s*[Mm][Hh]z\s*(\*?)`)

