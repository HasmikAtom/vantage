package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// blockDisk is the minimal info we need to drive a per-disk SMART probe.
type blockDisk struct {
	id        string // e.g. "nvme0n1"
	devPath   string // e.g. "/dev/nvme0n1"
	mount     string // first real mount point under this disk (if any)
	fstype    string
	sizeBytes uint64
	tempC     int // best-effort, set later from hwmon match
}

// discoverBlockDisks lists physical disks (no partitions, no virtuals) from /sys/block.
func discoverBlockDisks() ([]blockDisk, error) {
	root := sysPath("block")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}

	mounts := readMountsByDev() // device path -> (mount, fstype)
	var out []blockDisk
	for _, e := range entries {
		name := e.Name()
		// skip ram/loop/dm- virtuals
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") ||
			strings.HasPrefix(name, "dm-") || strings.HasPrefix(name, "zram") {
			continue
		}
		dir := filepath.Join(root, name)
		// "device" symlink only exists for real backing devices.
		if _, err := os.Stat(filepath.Join(dir, "device")); err != nil {
			continue
		}
		sectors, _ := readSysFloat(filepath.Join(dir, "size"))
		d := blockDisk{
			id:        name,
			devPath:   "/dev/" + name,
			sizeBytes: uint64(sectors) * 512,
		}
		// Match a partition's mount as the disk's "primary mount" (largest).
		for dev, mf := range mounts {
			if strings.HasPrefix(dev, "/dev/"+name) {
				if d.mount == "" || len(mf.mount) < len(d.mount) {
					d.mount = mf.mount
					d.fstype = mf.fstype
				}
			}
		}
		out = append(out, d)
	}
	// Annotate temps from hwmon (nvme, sda/sdb via drive temps from /sys/class/block/*/device/hwmon).
	annotateDiskTemps(out)
	return out, nil
}

type mountFs struct{ mount, fstype string }

func readMountsByDev() map[string]mountFs {
	out := map[string]mountFs{}
	f, err := os.Open(hostMountsPath())
	if err != nil {
		return out
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 3 {
			continue
		}
		dev := fields[0]
		if !strings.HasPrefix(dev, "/dev/") {
			continue
		}
		// Prefer the shortest mount string per dev so "/" beats "/var/snap/...".
		cur, ok := out[dev]
		if !ok || len(fields[1]) < len(cur.mount) {
			out[dev] = mountFs{mount: fields[1], fstype: fields[2]}
		}
	}
	return out
}

func annotateDiskTemps(disks []blockDisk) {
	chips := listHwmonChips()
	for i := range disks {
		// nvme: look for a hwmon chip whose `device` symlink resolves under the disk's sysfs node.
		want := sysPath("block", disks[i].id)
		for _, c := range chips {
			devLink, err := os.Readlink(filepath.Join(c.dir, "device"))
			if err != nil {
				continue
			}
			full := filepath.Clean(filepath.Join(c.dir, devLink))
			if strings.HasPrefix(full, want) || strings.Contains(full, "/"+disks[i].id+"/") {
				if t, ok := readSysFloat(filepath.Join(c.dir, "temp1_input")); ok {
					disks[i].tempC = int(t / 1000)
					break
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// SMART via smartctl -aj (JSON). Optional — degrades gracefully without root.
// ---------------------------------------------------------------------------

type smartctlOutput struct {
	Smartctl struct {
		ExitStatus int `json:"exit_status"`
		Messages   []struct {
			String   string `json:"string"`
			Severity string `json:"severity"`
		} `json:"messages"`
	} `json:"smartctl"`
	ModelName       string `json:"model_name"`
	ModelFamily     string `json:"model_family"`
	SerialNumber    string `json:"serial_number"`
	FirmwareVersion string `json:"firmware_version"`
	UserCapacity    struct {
		Bytes uint64 `json:"bytes"`
	} `json:"user_capacity"`
	RotationRate int `json:"rotation_rate"`
	FormFactor   struct {
		Name string `json:"name"`
	} `json:"form_factor"`
	InterfaceSpeed struct {
		Current struct {
			String string `json:"string"`
		} `json:"current"`
		Max struct {
			String string `json:"string"`
		} `json:"max"`
	} `json:"interface_speed"`
	Temperature struct {
		Current int `json:"current"`
	} `json:"temperature"`
	SmartStatus struct {
		Passed bool `json:"passed"`
	} `json:"smart_status"`
	PowerOnTime struct {
		Hours int `json:"hours"`
	} `json:"power_on_time"`
	PowerCycleCount uint64 `json:"power_cycle_count"`
	// SATA attribute table
	AtaSmartAttributes struct {
		Table []struct {
			ID         int    `json:"id"`
			Name       string `json:"name"`
			Value      int    `json:"value"`
			Worst      int    `json:"worst"`
			Threshold  int    `json:"thresh"`
			WhenFailed string `json:"when_failed"`
			Flags      struct {
				Prefailure bool `json:"prefailure"`
			} `json:"flags"`
			Raw struct {
				Value  uint64 `json:"value"`
				String string `json:"string"`
			} `json:"raw"`
		} `json:"table"`
	} `json:"ata_smart_attributes"`
	// NVMe health log
	NvmeSmartHealthInformationLog struct {
		CriticalWarning         int    `json:"critical_warning"`
		Temperature             int    `json:"temperature"`
		AvailableSpare          int    `json:"available_spare"`
		AvailableSpareThreshold int    `json:"available_spare_threshold"`
		PercentageUsed          int    `json:"percentage_used"`
		DataUnitsRead           uint64 `json:"data_units_read"`
		DataUnitsWritten        uint64 `json:"data_units_written"`
		HostReads               uint64 `json:"host_reads"`
		HostWrites              uint64 `json:"host_writes"`
		ControllerBusyTime      uint64 `json:"controller_busy_time"`
		PowerCycles             uint64 `json:"power_cycles"`
		PowerOnHours            uint64 `json:"power_on_hours"`
		UnsafeShutdowns         uint64 `json:"unsafe_shutdowns"`
		MediaErrors             uint64 `json:"media_errors"`
		NumErrLogEntries        uint64 `json:"num_err_log_entries"`
		WarningTempTime         int    `json:"warning_temp_time"`
		CriticalCompTime        int    `json:"critical_comp_time"`
		TemperatureSensors      []int  `json:"temperature_sensors"`
	} `json:"nvme_smart_health_information_log"`
}

func runSmartctl(ctx context.Context, devPath string) (*smartctlOutput, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "smartctl", "-aj", devPath)
	out, err := cmd.Output()
	// smartctl uses a bitmask exit code; bit 0/1 mean fatal, bits 2+ are info.
	// We accept any output that parses, even with non-zero exit.
	if len(out) == 0 {
		if err != nil {
			return nil, fmt.Errorf("smartctl %s: %w", devPath, err)
		}
		return nil, fmt.Errorf("smartctl %s: empty output", devPath)
	}
	var parsed smartctlOutput
	if jerr := json.Unmarshal(out, &parsed); jerr != nil {
		return nil, fmt.Errorf("smartctl %s: parse: %w", devPath, jerr)
	}
	// smartctl exit-status bits 0 (cmd-line parse) and 1 (open/access failed)
	// are fatal — anything we get back is just diagnostic noise.
	if parsed.Smartctl.ExitStatus&0x03 != 0 {
		msg := "open failed"
		for _, m := range parsed.Smartctl.Messages {
			if m.Severity == "error" {
				msg = m.String
				break
			}
		}
		return nil, fmt.Errorf("smartctl %s: %s", devPath, msg)
	}
	return &parsed, nil
}

func diskTypeFor(id string) string {
	if strings.HasPrefix(id, "nvme") {
		return "NVMe"
	}
	if strings.HasPrefix(id, "sd") {
		return "HDD"
	}
	return "Disk"
}

func collectDisks(ctx context.Context) ([]Disk, error) {
	bd, err := discoverBlockDisks()
	if err != nil {
		return nil, err
	}
	var out []Disk
	for _, d := range bd {
		disk := Disk{
			ID:    d.id,
			Label: d.id,
			Mount: d.mount,
			Type:  diskTypeFor(d.id),
			Total: roundTo(float64(d.sizeBytes)/1024/1024/1024, 0),
			TempC: d.tempC,
		}
		// Real "used" from statfs of the primary mount.
		if d.mount != "" {
			var st syscall.Statfs_t
			if err := syscall.Statfs(hostFsPath(d.mount), &st); err == nil {
				total := float64(st.Blocks) * float64(st.Bsize) / 1024 / 1024 / 1024
				free := float64(st.Bavail) * float64(st.Bsize) / 1024 / 1024 / 1024
				disk.Used = roundTo(total-free, 1)
				if disk.Total == 0 {
					disk.Total = roundTo(total, 0)
				}
			}
		}

		// SMART (best effort).
		if sm, err := runSmartctl(ctx, d.devPath); err == nil && sm != nil {
			disk.Model = sm.ModelName
			disk.Health = healthFromSmart(sm)
			disk.PowerOnHours = sm.PowerOnTime.Hours
			disk.Smart = Smart{
				Passed:      sm.SmartStatus.Passed,
				Reallocated: nvmeOrSataReallocated(sm),
				Pending:     nvmeOrSataPending(sm),
				LifeLeft:    nvmeOrSataLifeLeft(sm),
			}
			if sm.Temperature.Current > 0 && disk.TempC == 0 {
				disk.TempC = sm.Temperature.Current
			}
			disk.Detail = buildSmartDetail(sm)
		} else {
			disk.Health = "unknown"
			disk.Smart = Smart{Passed: false, LifeLeft: 0}
		}
		out = append(out, disk)
	}
	return out, nil
}

func healthFromSmart(sm *smartctlOutput) string {
	if !sm.SmartStatus.Passed {
		return "failing"
	}
	if sm.NvmeSmartHealthInformationLog.AvailableSpare > 0 &&
		sm.NvmeSmartHealthInformationLog.AvailableSpare < 20 {
		return "watch"
	}
	for _, a := range sm.AtaSmartAttributes.Table {
		if a.Name == "Reallocated_Sector_Ct" && a.Raw.Value > 0 {
			return "watch"
		}
		if a.Name == "Current_Pending_Sector" && a.Raw.Value > 0 {
			return "watch"
		}
	}
	return "healthy"
}

func nvmeOrSataReallocated(sm *smartctlOutput) int {
	for _, a := range sm.AtaSmartAttributes.Table {
		if a.Name == "Reallocated_Sector_Ct" {
			return int(a.Raw.Value)
		}
	}
	return int(sm.NvmeSmartHealthInformationLog.MediaErrors)
}

// nvmeOrSataPending: sectors the drive has earmarked for reallocation but
// hasn't yet rewritten. SATA exposes this as attribute 197; NVMe doesn't have
// a direct equivalent so we return 0 there.
func nvmeOrSataPending(sm *smartctlOutput) int {
	for _, a := range sm.AtaSmartAttributes.Table {
		if a.Name == "Current_Pending_Sector" {
			return int(a.Raw.Value)
		}
	}
	return 0
}

func nvmeOrSataLifeLeft(sm *smartctlOutput) int {
	// NVMe: spec gives "percentage_used" (0-100, lower is better; spare also tells you).
	if sm.NvmeSmartHealthInformationLog.PercentageUsed > 0 || sm.NvmeSmartHealthInformationLog.AvailableSpare > 0 {
		used := sm.NvmeSmartHealthInformationLog.PercentageUsed
		left := 100 - used
		if left < 0 {
			left = 0
		}
		return left
	}
	// SATA: attribute 231 / 233 is "Wear_Leveling_Count" — value is life left.
	for _, a := range sm.AtaSmartAttributes.Table {
		if strings.Contains(a.Name, "Wear_Leveling_Count") || strings.Contains(a.Name, "SSD_Life_Left") {
			return a.Value
		}
	}
	return 0
}

// unused but kept handy in case we later want absolute integer parsing.
var _ = strconv.Atoi

// buildSmartDetail flattens the noisy smartctl JSON into the trimmed shape
// the frontend consumes, runs the Scrutiny-style scorer over it, and returns
// a pointer ready to drop straight into Disk.Detail.
func buildSmartDetail(sm *smartctlOutput) *SmartDetail {
	d := &SmartDetail{
		Serial:         sm.SerialNumber,
		Firmware:       sm.FirmwareVersion,
		ModelFamily:    sm.ModelFamily,
		FormFactor:     sm.FormFactor.Name,
		RotationRate:   sm.RotationRate,
		InterfaceSpeed: sm.InterfaceSpeed.Current.String,
		MaxInterface:   sm.InterfaceSpeed.Max.String,
		PowerCycles:    sm.PowerCycleCount,
		AtaAttrs:       []SmartAttr{},
	}
	// SATA: copy the full attribute table verbatim.
	for _, a := range sm.AtaSmartAttributes.Table {
		d.AtaAttrs = append(d.AtaAttrs, SmartAttr{
			ID:         a.ID,
			Name:       a.Name,
			Value:      a.Value,
			Worst:      a.Worst,
			Threshold:  a.Threshold,
			RawValue:   a.Raw.Value,
			RawString:  a.Raw.String,
			Prefailure: a.Flags.Prefailure,
			WhenFailed: a.WhenFailed,
		})
	}
	// NVMe: copy the whole health log when there's a non-zero signal that the
	// drive actually filled it in. PowerOnHours==0 *and* PercentageUsed==0 *and*
	// no temp ⇒ SATA disk, leave nil.
	nv := sm.NvmeSmartHealthInformationLog
	if nv.PowerOnHours > 0 || nv.PercentageUsed > 0 || nv.Temperature > 0 || nv.AvailableSpareThreshold > 0 {
		// Fall back to PowerCycles from the dedicated key if the NVMe block
		// didn't carry one (rare but seen on some firmware).
		if d.PowerCycles == 0 {
			d.PowerCycles = nv.PowerCycles
		}
		d.NvmeLog = &NvmeHealthLog{
			CriticalWarning:         nv.CriticalWarning,
			Temperature:             nv.Temperature,
			AvailableSpare:          nv.AvailableSpare,
			AvailableSpareThreshold: nv.AvailableSpareThreshold,
			PercentageUsed:          nv.PercentageUsed,
			DataUnitsRead:           nv.DataUnitsRead,
			DataUnitsWritten:        nv.DataUnitsWritten,
			HostReads:               nv.HostReads,
			HostWrites:              nv.HostWrites,
			ControllerBusyTime:      nv.ControllerBusyTime,
			PowerCycles:             nv.PowerCycles,
			PowerOnHours:            nv.PowerOnHours,
			UnsafeShutdowns:         nv.UnsafeShutdowns,
			MediaErrors:             nv.MediaErrors,
			NumErrLogEntries:        nv.NumErrLogEntries,
			WarningTempTime:         nv.WarningTempTime,
			CriticalCompTime:        nv.CriticalCompTime,
			TemperatureSensors:      append([]int{}, nv.TemperatureSensors...),
		}
	}
	d.Score = scoreSmart(sm, d)
	return d
}

// scoreSmart applies a lenient, Backblaze-inspired ruleset to the current
// snapshot. It never claims to predict failure — it surfaces the same
// attributes Backblaze identified as correlated with imminent death, but
// with thresholds set forgivingly enough that an otherwise-healthy drive
// won't trip on a single cable hiccup or one momentary controller stall.
//
// "lenient" choices (versus a strict "any non-zero ⇒ warning" reading):
//   - UDMA CRC errors below 100 ignored — usually cable, not drive
//   - Command timeouts below 100 ignored — momentary bus issues
//   - Unsafe NVMe shutdowns not flagged — common on power-cycled desktops
//   - NVMe error-log entries flagged only past 100
func scoreSmart(sm *smartctlOutput, d *SmartDetail) ScrutinyScore {
	score := ScrutinyScore{Rating: "healthy", Reasons: []string{}}

	bump := func(toRating, reason string) {
		// "failed" outranks "warning"; once failed we never downgrade.
		if score.Rating == "failed" {
			score.Reasons = append(score.Reasons, reason)
			return
		}
		if toRating == "failed" || (toRating == "warning" && score.Rating != "warning") {
			score.Rating = toRating
		}
		score.Reasons = append(score.Reasons, reason)
	}

	// Universal: drive's own pass bit overrules everything.
	if !sm.SmartStatus.Passed {
		bump("failed", "Drive SMART self-assessment: FAIL")
	}

	// SATA attribute rules. Names follow smartctl's standard convention.
	for _, a := range d.AtaAttrs {
		// `when_failed` tells us the drive itself has historically failed this
		// attribute against its threshold. Trust the drive.
		if a.WhenFailed == "FAILING_NOW" {
			bump("failed", "Attribute "+a.Name+" failing now (drive-reported)")
			continue
		}
		if a.WhenFailed == "in_the_past" && a.Prefailure {
			bump("warning", "Attribute "+a.Name+" failed in the past")
		}
		switch a.Name {
		case "Reallocated_Sector_Ct", "Reallocated_Event_Count":
			if a.RawValue > 0 {
				bump("warning", a.Name+": "+a.RawString+" (any non-zero is a yellow flag)")
			}
		case "Current_Pending_Sector":
			if a.RawValue > 0 {
				bump("warning", "Current_Pending_Sector: "+a.RawString+" (sectors awaiting reallocation)")
			}
		case "Offline_Uncorrectable":
			if a.RawValue > 0 {
				bump("warning", "Offline_Uncorrectable: "+a.RawString)
			}
		case "Reported_Uncorrect":
			if a.RawValue > 0 {
				bump("warning", "Reported_Uncorrect: "+a.RawString+" (data has been lost)")
			}
		case "UDMA_CRC_Error_Count":
			if a.RawValue > 100 {
				bump("warning", "UDMA_CRC_Error_Count: "+a.RawString+" (cable/connector likely)")
			}
		case "Command_Timeout":
			if a.RawValue > 100 {
				bump("warning", "Command_Timeout: "+a.RawString)
			}
		case "Spin_Retry_Count":
			if a.RawValue > 0 {
				bump("warning", "Spin_Retry_Count: "+a.RawString+" (motor having trouble starting)")
			}
		}
	}

	// NVMe rules. The drive's available-spare threshold is the manufacturer's
	// own line in the sand — when actual spare falls below it, the controller
	// is telling us the cells are exhausted, not us.
	if d.NvmeLog != nil {
		nv := d.NvmeLog
		if nv.CriticalWarning != 0 {
			bump("failed", "NVMe critical_warning bits set: 0x"+strconv.FormatInt(int64(nv.CriticalWarning), 16))
		}
		if nv.AvailableSpareThreshold > 0 && nv.AvailableSpare < nv.AvailableSpareThreshold {
			bump("failed", "Available spare "+strconv.Itoa(nv.AvailableSpare)+"% below drive's own threshold of "+strconv.Itoa(nv.AvailableSpareThreshold)+"%")
		}
		if nv.PercentageUsed >= 90 {
			bump("failed", "NVMe percentage_used: "+strconv.Itoa(nv.PercentageUsed)+"% — at end of rated write life")
		} else if nv.PercentageUsed >= 80 {
			bump("warning", "NVMe percentage_used: "+strconv.Itoa(nv.PercentageUsed)+"% — approaching rated write life")
		}
		if nv.MediaErrors > 0 {
			bump("warning", "NVMe media_errors: "+strconv.FormatUint(nv.MediaErrors, 10))
		}
		if nv.NumErrLogEntries > 100 {
			bump("warning", "NVMe num_err_log_entries: "+strconv.FormatUint(nv.NumErrLogEntries, 10))
		}
		for _, t := range nv.TemperatureSensors {
			if t > 80 {
				bump("warning", "NVMe sensor at "+strconv.Itoa(t)+"°C (>80°C is the spec critical line)")
				break
			}
		}
	}

	return score
}
