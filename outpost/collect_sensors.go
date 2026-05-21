package main

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// hwmonChip enumerates the chip directories under /sys/class/hwmon.
type hwmonChip struct {
	dir  string
	name string
}

// hwmonChipsTTL bounds how long we serve a cached chip list. 30s is a
// compromise between never re-scanning (which would miss hot-plug — Corsair
// pumps, USB sensors, freshly-attached drives) and re-scanning every tick
// (the call gets hit 3× per fast tick across sensors/CPU temp/GPU headline).
const hwmonChipsTTL = 30 * time.Second

var (
	hwmonChipsMu    sync.Mutex
	hwmonChipsCache []hwmonChip
	hwmonChipsAt    time.Time
)

// listHwmonChips returns the chip directories under /sys/class/hwmon. The
// result is cached for hwmonChipsTTL: chip enumeration changes only on
// driver load/unload (rare) or hot-plug (~minutes), and the immediate
// callers — collectSensors / readCPUTemp / collectGPUHeadline — fire on the
// same 2s tick, so caching collapses 3 sysfs walks into 1.
//
// Callers must NOT mutate the returned slice; entries are shared.
func listHwmonChips() []hwmonChip {
	hwmonChipsMu.Lock()
	defer hwmonChipsMu.Unlock()
	if !hwmonChipsAt.IsZero() && time.Since(hwmonChipsAt) < hwmonChipsTTL {
		return hwmonChipsCache
	}
	entries, err := os.ReadDir(sysPath("class", "hwmon"))
	if err != nil {
		// Don't poison the cache on a transient ReadDir error — return the
		// previous list (possibly nil) without bumping the timestamp, so the
		// next call will retry.
		return hwmonChipsCache
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	out := make([]hwmonChip, 0, len(entries))
	for _, e := range entries {
		dir := filepath.Join(sysPath("class", "hwmon"), e.Name())
		out = append(out, hwmonChip{dir: dir, name: readSysString(filepath.Join(dir, "name"))})
	}
	hwmonChipsCache = out
	hwmonChipsAt = time.Now()
	return out
}

// isGPUChip identifies known GPU hwmon driver names so the same set can be
// reused by groupForChip, collectGPUHeadline, and gpuPrettyName.
func isGPUChip(name string) bool {
	switch name {
	case "nouveau", "amdgpu", "nvidia", "i915", "xe":
		return true
	}
	return false
}

func groupForChip(name string) string {
	switch name {
	case "coretemp", "k10temp", "k8temp", "zenpower":
		return "cpu"
	case "nvme", "drivetemp":
		return "storage"
	}
	if isGPUChip(name) {
		return "gpu"
	}
	return "board"
}

// collectSensors walks every hwmon chip and emits one Sensor per temp/fan
// channel, picking labels where the kernel provides them.
func (m *Manager) collectSensors() []Sensor {
	var out []Sensor
	chips := listHwmonChips()
	for _, chip := range chips {
		group := groupForChip(chip.name)
		entries, err := os.ReadDir(chip.dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			n := e.Name()

			switch {
			case strings.HasPrefix(n, "temp") && strings.HasSuffix(n, "_input"):
				idx := strings.TrimSuffix(strings.TrimPrefix(n, "temp"), "_input")
				raw, ok := readSysFloat(filepath.Join(chip.dir, n))
				if !ok {
					continue
				}
				label := readSysString(filepath.Join(chip.dir, "temp"+idx+"_label"))
				if label == "" {
					label = "temp" + idx
				}
				max, ok := readSysFloat(filepath.Join(chip.dir, "temp"+idx+"_max"))
				if !ok || max > 200000 { // some drivers report sentinels (>200 °C); ignore
					ok = false
				}
				if !ok {
					if crit, okc := readSysFloat(filepath.Join(chip.dir, "temp"+idx+"_crit")); okc && crit < 200000 {
						max = crit
					} else {
						max = 100000
					}
				}
				id := chip.name + ".t" + idx
				s := Sensor{
					ID:    id,
					Label: prettyLabel(chip.name, label),
					Group: group,
					Value: roundTo(raw/1000, 1),
					Unit:  "°C",
					Max:   roundTo(max/1000, 0),
				}
				s.History = m.pushHistory("sensor."+id, s.Value)
				out = append(out, s)

			case strings.HasPrefix(n, "fan") && strings.HasSuffix(n, "_input"):
				idx := strings.TrimSuffix(strings.TrimPrefix(n, "fan"), "_input")
				raw, ok := readSysFloat(filepath.Join(chip.dir, n))
				if !ok {
					continue
				}
				label := readSysString(filepath.Join(chip.dir, "fan"+idx+"_label"))
				if label == "" {
					label = "Fan " + idx
				}
				maxVal := 3500.0
				if v, ok := readSysFloat(filepath.Join(chip.dir, "fan"+idx+"_max")); ok {
					maxVal = v
				}
				id := chip.name + ".f" + idx
				s := Sensor{
					ID:    id,
					Label: prettyLabel(chip.name, label),
					Group: group,
					Value: roundTo(raw, 0),
					Unit:  "RPM",
					Max:   roundTo(maxVal, 0),
				}
				s.History = m.pushHistory("sensor."+id, s.Value)
				out = append(out, s)
			}
		}
	}
	return out
}

// prettyLabel turns kernel labels like "Core 0", "Package id 0", "Composite"
// into the "Group · Label" form the design uses.
func prettyLabel(chip, label string) string {
	switch chip {
	case "coretemp", "k10temp", "k8temp", "zenpower":
		if strings.HasPrefix(label, "Package") {
			return "CPU · Package"
		}
		return "CPU · " + label
	case "nvme":
		return "NVMe " + label
	case "drivetemp":
		return "Disk · " + label
	case "acpitz":
		return "ACPI · Zone " + strings.TrimPrefix(label, "temp")
	case "asus":
		return "Mobo · " + label
	}
	if isGPUChip(chip) {
		if strings.HasPrefix(label, "fan") || strings.HasPrefix(label, "Fan") {
			return "GPU · Fan"
		}
		return "GPU · " + chip
	}
	return chip + " · " + label
}

// readCPUTemp returns the package temp from coretemp, falling back to the
// max core temp.
func readCPUTemp() int {
	for _, c := range listHwmonChips() {
		if c.name != "coretemp" {
			continue
		}
		entries, _ := os.ReadDir(c.dir)
		maxC := 0
		for _, e := range entries {
			n := e.Name()
			if !strings.HasPrefix(n, "temp") || !strings.HasSuffix(n, "_input") {
				continue
			}
			idx := strings.TrimSuffix(strings.TrimPrefix(n, "temp"), "_input")
			label := readSysString(filepath.Join(c.dir, "temp"+idx+"_label"))
			val, _ := readSysFloat(filepath.Join(c.dir, n))
			t := int(val / 1000)
			if strings.HasPrefix(label, "Package") {
				return t
			}
			if t > maxC {
				maxC = t
			}
		}
		return maxC
	}
	return 0
}

// collectGPUHeadline reads everything Nouveau (and amdgpu, where applicable)
// exposes through sysfs and debugfs. util/VRAM stay zero on Nouveau by design.
// ctx is forwarded to the one shell-out (lspciModel → `lspci`) so a stuck
// invocation can be cancelled on shutdown.
func collectGPUHeadline(ctx context.Context) GPUHeadline {
	out := GPUHeadline{Name: "Unknown GPU", VRAM: VRAM{Unit: "GB"}}
	for _, c := range listHwmonChips() {
		if !isGPUChip(c.name) {
			continue
		}
		out.Driver = c.name
		if temp, ok := readSysFloat(filepath.Join(c.dir, "temp1_input")); ok {
			out.Temp = int(temp / 1000)
		}
		// Fan PWM as percentage (0–255 → 0–100).
		if pwm, ok := readSysFloat(filepath.Join(c.dir, "pwm1")); ok {
			out.Fan = int(roundTo(100*pwm/255, 0))
		}
		// Power draw — hwmon reports microwatts.
		if p, ok := readSysFloat(filepath.Join(c.dir, "power1_input")); ok {
			out.PowerW = roundTo(p/1_000_000, 1)
		}
		// Core voltage — millivolts.
		if v, ok := readSysFloat(filepath.Join(c.dir, "in0_input")); ok {
			out.VoltageV = roundTo(v/1000, 3)
		}
		break
	}

	// Friendly chip name via lspci.
	if addr := gpuPCIAddress(); addr != "" {
		if model := lspciModel(ctx, addr); model != "" {
			out.Name = model
		} else {
			out.Name = gpuPrettyName(out.Driver)
		}
		// PCIe link state lives under /sys/class/drm/cardN/device.
		out.PCIe = readPCIeLink(addr)
	} else {
		out.Name = gpuPrettyName(out.Driver)
	}

	// GPU clocks + active p-state via Nouveau's debugfs interface (root-only).
	if cm, mm, ps := readGPUClocks(); cm > 0 || mm > 0 {
		out.CoreMHz = cm
		out.MemMHz = mm
		out.PState = ps
	}

	// Processes with /dev/dri/* open. Bounded by the same proc-walk we already
	// use for sockets.
	out.Processes = listGPUProcesses()
	if out.Processes == nil {
		out.Processes = []GPUProcess{}
	}

	return out
}

func gpuPrettyName(chipName string) string {
	switch chipName {
	case "nouveau":
		return "Nouveau"
	case "amdgpu":
		return "AMDGPU"
	case "nvidia":
		return "NVIDIA"
	case "i915":
		return "Intel (i915)"
	case "xe":
		return "Intel Arc (xe)"
	}
	if chipName == "" {
		return "Unknown GPU"
	}
	return chipName
}
