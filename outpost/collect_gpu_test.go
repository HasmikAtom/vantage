package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Captured from the RX 570 (MSI Armor) on the dev host, 2026-10-01.
const rx570Vmm = `Slot:	01:00.0
Class:	VGA compatible controller
Vendor:	Advanced Micro Devices, Inc. [AMD/ATI]
Device:	Ellesmere [Radeon RX 470/480/570/570X/580/580X/590]
SVendor:	Micro-Star International Co., Ltd. [MSI]
SDevice:	Radeon RX 570 Armor 8G OC
Rev:	ef
ProgIf:	00
IOMMUGroup:	1
`

func TestGPUNameFromLspci(t *testing.T) {
	cases := []struct {
		name, vmm, want string
	}{
		{"board model from the subsystem", rx570Vmm, "AMD Radeon RX 570 Armor 8G OC"},
		{"chip family when the subsystem is unknown", `Vendor:	Advanced Micro Devices, Inc. [AMD/ATI]
Device:	Ellesmere [Radeon RX 470/480/570/570X/580/580X/590]
SVendor:	Micro-Star International Co., Ltd. [MSI]
SDevice:	Device 341b
`, "AMD Radeon RX 470/480/570/570X/580/580X/590"},
		{"no subsystem lines at all", `Vendor:	NVIDIA Corporation
Device:	GK106 [GeForce GTX 660]
`, "NVIDIA GeForce GTX 660"},
		{"subsystem already names the vendor", `Vendor:	NVIDIA Corporation
Device:	GK106 [GeForce GTX 660]
SDevice:	NVIDIA GeForce GTX 660 OC
`, "NVIDIA GeForce GTX 660 OC"},
		{"device without a bracketed name", `Vendor:	Intel Corporation
Device:	Alder Lake-S GT1
`, "Intel Alder Lake-S GT1"},
		{"nothing usable", ``, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := gpuNameFromVmm(c.vmm); got != c.want {
				t.Fatalf("gpuNameFromVmm = %q, want %q", got, c.want)
			}
		})
	}
}

func TestParseDPM(t *testing.T) {
	sclk := "0: 300Mhz *\n1: 588Mhz \n2: 976Mhz \n3: 1065Mhz \n4: 1130Mhz \n5: 1192Mhz \n6: 1233Mhz \n7: 1268Mhz \n"
	mhz, level, levels := parseDPM(sclk)
	if mhz != 300 || level != 0 || levels != 8 {
		t.Fatalf("idle sclk = %d MHz level %d of %d, want 300 level 0 of 8", mhz, level, levels)
	}
	mhz, level, levels = parseDPM("0: 300Mhz \n1: 1000Mhz \n2: 1750Mhz *\n")
	if mhz != 1750 || level != 2 || levels != 3 {
		t.Fatalf("busy mclk = %d MHz level %d of %d, want 1750 level 2 of 3", mhz, level, levels)
	}
	if mhz, _, _ := parseDPM("0: 300Mhz \n1: 588Mhz \n"); mhz != 0 {
		t.Fatalf("no active level should read 0 MHz, got %d", mhz)
	}
}

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestReadAMDGPUStats(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"gpu_busy_percent":    "37\n",
		"mem_info_vram_used":  "2147483648\n",
		"mem_info_vram_total": "8589934592\n",
		"pp_dpm_sclk":         "0: 300Mhz \n1: 588Mhz \n2: 976Mhz \n3: 1065Mhz \n4: 1130Mhz \n5: 1192Mhz \n6: 1233Mhz *\n7: 1268Mhz \n",
		"pp_dpm_mclk":         "0: 300Mhz \n1: 1000Mhz \n2: 1750Mhz *\n",
	})
	var g GPUHeadline
	applyAMDGPU(&g, dir)
	if g.Pct != 37 {
		t.Errorf("Pct = %v, want 37", g.Pct)
	}
	if g.VRAM.Used != 2 || g.VRAM.Total != 8 || g.VRAM.Unit != "GB" {
		t.Errorf("VRAM = %+v, want 2/8 GB", g.VRAM)
	}
	if g.CoreMHz != 1233 || g.MemMHz != 1750 {
		t.Errorf("clocks = %d/%d, want 1233/1750", g.CoreMHz, g.MemMHz)
	}
	if g.PState != "6 of 7" {
		t.Errorf("PState = %q, want %q", g.PState, "6 of 7")
	}
}

func TestReadAMDGPUStatsMissingFiles(t *testing.T) {
	// Not an amdgpu card (or an old kernel): nothing is touched.
	g := GPUHeadline{VRAM: VRAM{Unit: "GB"}, PState: "07"}
	applyAMDGPU(&g, t.TempDir())
	if g.Pct != 0 || g.VRAM.Total != 0 || g.CoreMHz != 0 || g.PState != "07" {
		t.Fatalf("missing files changed the headline: %+v", g)
	}
}

func TestApplyGPUHwmon(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"temp1_input":    "52000\n",
		"pwm1":           "64\n",
		"pwm1_max":       "255\n",
		"fan1_input":     "1209\n",
		"power1_average": "48250000\n",
		"power1_input":   "10234000\n",
		"power1_cap":     "120000000\n",
		"in0_input":      "750\n",
	})
	var g GPUHeadline
	applyGPUHwmon(&g, dir)
	if g.Temp != 52 || g.Fan != 25 || g.FanRPM != 1209 {
		t.Errorf("temp/fan = %d °C %d%% %d rpm, want 52 °C 25%% 1209 rpm", g.Temp, g.Fan, g.FanRPM)
	}
	if g.PowerW != 48.3 || g.PowerCapW != 120 {
		t.Errorf("power = %v W of %v W, want the average 48.3 of 120", g.PowerW, g.PowerCapW)
	}
	if g.VoltageV != 0.75 {
		t.Errorf("VoltageV = %v, want 0.75", g.VoltageV)
	}
}

func TestApplyGPUHwmonFallsBackToInstantPower(t *testing.T) {
	// amdgpu on newer kernels has power1_input only; pwm1_max may be absent.
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"power1_input": "10234000\n",
		"pwm1":         "255\n",
	})
	var g GPUHeadline
	applyGPUHwmon(&g, dir)
	if g.PowerW != 10.2 || g.Fan != 100 {
		t.Fatalf("power/fan = %v W %d%%, want 10.2 W 100%%", g.PowerW, g.Fan)
	}
}

func TestBusyWindowAverages(t *testing.T) {
	// gpu_busy_percent is instantaneous; one read per 2 s tick jumps between
	// 0 and 94 under bursty load. The window smooths it.
	w := newBusyWindow(4)
	if _, ok := w.avg(); ok {
		t.Fatal("an empty window has no average")
	}
	for _, v := range []float64{0, 94, 0, 10} {
		w.add(v)
	}
	if got, _ := w.avg(); got != 26 {
		t.Fatalf("avg = %v, want 26", got)
	}
	w.add(50) // the oldest sample (0) drops out
	if got, _ := w.avg(); got != 38.5 {
		t.Fatalf("avg after wrap = %v, want 38.5", got)
	}
}
