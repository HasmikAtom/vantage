package main

import (
	"bufio"
	"os"
	"strings"
	"syscall"
)

// realFsTypes are mounts we care about — everything else (tmpfs, sysfs, proc,
// overlay, squashfs) is filtered out.
var realFsTypes = map[string]bool{
	"ext4": true, "ext3": true, "ext2": true,
	"btrfs": true, "xfs": true, "zfs": true, "f2fs": true,
	"vfat": true, "exfat": true, "ntfs": true,
	"overlay2": true,
}

func collectFilesystems() []Filesystem {
	f, err := os.Open(hostMountsPath())
	if err != nil {
		return nil
	}
	defer f.Close()

	seen := map[string]bool{}
	var out []Filesystem
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) < 3 {
			continue
		}
		mount := fields[1]
		fstype := fields[2]
		if !realFsTypes[fstype] {
			continue
		}
		if seen[mount] {
			continue
		}
		seen[mount] = true

		var st syscall.Statfs_t
		if err := syscall.Statfs(hostFsPath(mount), &st); err != nil {
			continue
		}
		total := float64(st.Blocks) * float64(st.Bsize) / 1024 / 1024 / 1024
		free := float64(st.Bavail) * float64(st.Bsize) / 1024 / 1024 / 1024
		used := total - free
		out = append(out, Filesystem{
			Mount:  mount,
			Fstype: fstype,
			Used:   roundTo(used, 2),
			Total:  roundTo(total, 2),
			Unit:   "GB",
		})
	}
	return out
}

// storagePoolSnapshot returns (used% across real block-backed disks, hottest temp).
// Used for the Storage hero card on the overview tab.
func storagePoolSnapshot() (usedPct float64, hottestC int) {
	disks, err := discoverBlockDisks()
	if err != nil || len(disks) == 0 {
		return 0, 0
	}
	totalB, usedB := 0.0, 0.0
	hottest := 0
	for _, d := range disks {
		var st syscall.Statfs_t
		if d.mount != "" {
			if err := syscall.Statfs(hostFsPath(d.mount), &st); err == nil {
				total := float64(st.Blocks) * float64(st.Bsize)
				free := float64(st.Bavail) * float64(st.Bsize)
				totalB += total
				usedB += total - free
			}
		}
		if d.tempC > hottest {
			hottest = d.tempC
		}
	}
	if totalB > 0 {
		usedPct = roundTo(100*usedB/totalB, 1)
	}
	hottestC = hottest
	return
}
