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

// lspciModel runs `lspci -nn -s <addr>` once per hour and extracts the
// human chip name (the text inside the first `[...]` after the colon).
// Example raw line:
//   01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GK106 [GeForce GTX 660] [10de:11c0] (rev a1)
// We return "NVIDIA Corporation GK106 [GeForce GTX 660]" — the device-class
// bracket gets stripped, the vendor:device bracket is dropped.
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
	out, err := exec.CommandContext(ctx, "lspci", "-nn", "-s", addr).Output()
	if err != nil {
		return ""
	}
	model := parseLspciModel(string(out))

	lspciCacheMu.Lock()
	lspciCacheKey = addr
	lspciCacheVal = model
	lspciCacheUntil = time.Now().Add(1 * time.Hour)
	lspciCacheMu.Unlock()

	return model
}

// parseLspciModel pulls the friendly name out of an `lspci -nn -s` line.
// Strips the device-class brackets (after the slot), then drops the trailing
// vendor:device bracket and "(rev XX)" suffix.
func parseLspciModel(line string) string {
	line = strings.TrimSpace(line)
	// drop everything up to the first ": "
	if i := strings.Index(line, ": "); i > 0 {
		line = line[i+2:]
	}
	// drop trailing vendor:device bracket "[10de:11c0]" and rev
	if i := strings.LastIndex(line, " ["); i > 0 {
		line = line[:i]
	}
	if i := strings.Index(line, " (rev "); i > 0 {
		line = line[:i]
	}
	return strings.TrimSpace(line)
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
