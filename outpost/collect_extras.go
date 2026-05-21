package main

import (
	"bufio"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Updates (Ubuntu update-notifier)
// ---------------------------------------------------------------------------

// Files we read are produced by `update-notifier-common` on every apt update.
// Format of /var/lib/update-notifier/updates-available is two human lines:
//   "12 updates can be applied immediately."
//   "5 of these updates are standard security updates."
func collectUpdates() UpdateInfo {
	out := UpdateInfo{RebootPkgs: []string{}}

	if b, err := os.ReadFile(hostFsPath("/var/lib/update-notifier/updates-available")); err == nil {
		text := string(b)
		out.Summary = strings.TrimSpace(text)
		// Pull the first number from the first non-blank line.
		for _, line := range strings.Split(text, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			out.UpgradableCount = firstInt(line)
			break
		}
		// Look for a "security" line; first int on it = security count.
		for _, line := range strings.Split(text, "\n") {
			lo := strings.ToLower(line)
			if strings.Contains(lo, "security") {
				out.SecurityCount = firstInt(line)
				break
			}
		}
	}
	if _, err := os.Stat(hostFsPath("/var/run/reboot-required")); err == nil {
		out.RebootRequired = true
	}
	if b, err := os.ReadFile(hostFsPath("/var/run/reboot-required.pkgs")); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if line != "" {
				out.RebootPkgs = append(out.RebootPkgs, line)
			}
		}
	}
	return out
}

func firstInt(s string) int {
	cur := 0
	have := false
	for _, r := range s {
		if r >= '0' && r <= '9' {
			cur = cur*10 + int(r-'0')
			have = true
		} else if have {
			return cur
		}
	}
	return cur
}

// ---------------------------------------------------------------------------
// PSI (/proc/pressure/*)
// ---------------------------------------------------------------------------

func collectPressure() Pressure {
	out := Pressure{}
	if _, err := os.Stat(procPath("pressure")); err != nil {
		return out
	}
	out.Available = true
	out.CPU = readPressure(procPath("pressure", "cpu"), "some")
	out.MemSome = readPressure(procPath("pressure", "memory"), "some")
	out.MemFull = readPressure(procPath("pressure", "memory"), "full")
	out.IOSome = readPressure(procPath("pressure", "io"), "some")
	out.IOFull = readPressure(procPath("pressure", "io"), "full")
	return out
}

func readPressure(path, prefix string) PressureLine {
	var out PressureLine
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := s.Text()
		if !strings.HasPrefix(line, prefix+" ") {
			continue
		}
		// e.g. "some avg10=0.04 avg60=0.05 avg300=0.06 total=12345"
		for _, kv := range strings.Fields(line)[1:] {
			eq := strings.IndexByte(kv, '=')
			if eq < 0 {
				continue
			}
			v, _ := strconv.ParseFloat(kv[eq+1:], 64)
			switch kv[:eq] {
			case "avg10":
				out.Avg10 = roundTo(v, 2)
			case "avg60":
				out.Avg60 = roundTo(v, 2)
			case "avg300":
				out.Avg300 = roundTo(v, 2)
			}
		}
		return out
	}
	return out
}

// ---------------------------------------------------------------------------
// Top processes  — walk /host/proc, sample twice for CPU%.
// ---------------------------------------------------------------------------

type procSample struct {
	utime uint64 // jiffies in user mode
	stime uint64 // jiffies in kernel mode
}

var (
	procSampleMu    sync.Mutex
	procLastSamples = map[int]procSample{}
	procLastSampleT time.Time
	clkTck          = float64(100) // kernel CLK_TCK; 100 on virtually every Linux build
)

// readProcStat returns (uid, utime, stime, threads, comm, rssKB) for a pid.
// /proc/[pid]/status is read once and scanned for BOTH Uid: and VmRSS:; the
// previous version opened it twice (once here for UID, once in readProcRSS
// for VmRSS), doubling syscalls per process on the medium tick.
func readProcStat(pid int) (uid uint32, sample procSample, threads int, comm string, rssKB int64, ok bool) {
	b, err := os.ReadFile(procPath(strconv.Itoa(pid), "stat"))
	if err != nil {
		return
	}
	// /proc/[pid]/stat layout: pid (comm) state ppid pgrp session tty_nr tpgid
	//   flags minflt cminflt majflt cmajflt utime stime ...
	// `comm` is wrapped in parentheses and may contain spaces. Split on the
	// last ")" so we only do field math on the post-comm tail.
	lp := strings.IndexByte(string(b), '(')
	rp := strings.LastIndexByte(string(b), ')')
	if lp < 0 || rp < 0 || rp <= lp {
		return
	}
	comm = string(b[lp+1 : rp])
	tail := strings.Fields(string(b[rp+2:]))
	if len(tail) < 20 {
		return
	}
	// tail[0]=state, [1]=ppid, [2]=pgrp ... [11]=utime, [12]=stime ... [17]=num_threads
	sample.utime, _ = strconv.ParseUint(tail[11], 10, 64)
	sample.stime, _ = strconv.ParseUint(tail[12], 10, 64)
	threads, _ = strconv.Atoi(tail[17])

	// One pass over /proc/[pid]/status pulls both the real UID and VmRSS.
	// Status lines aren't ordered relative to each other across kernel
	// versions, so we keep scanning until we've found both or hit EOF.
	if sb, err := os.ReadFile(procPath(strconv.Itoa(pid), "status")); err == nil {
		gotUID, gotRSS := false, false
		for _, line := range strings.Split(string(sb), "\n") {
			switch {
			case !gotUID && strings.HasPrefix(line, "Uid:"):
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					n, _ := strconv.ParseUint(fields[1], 10, 32)
					uid = uint32(n)
				}
				gotUID = true
			case !gotRSS && strings.HasPrefix(line, "VmRSS:"):
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					rssKB, _ = strconv.ParseInt(fields[1], 10, 64)
				}
				gotRSS = true
			}
			if gotUID && gotRSS {
				break
			}
		}
	}
	ok = true
	return
}

func readProcCmdline(pid int) string {
	b, err := os.ReadFile(procPath(strconv.Itoa(pid), "cmdline"))
	if err != nil {
		return ""
	}
	// args are NUL-separated; the binary path + args are useful for daemons.
	s := strings.ReplaceAll(string(b), "\x00", " ")
	return strings.TrimSpace(s)
}

// uidNameCacheCap bounds uidNameCache. On hosts with churning UIDs (LDAP/NIS,
// containers spawning fresh users) an unbounded map would grow without limit.
// When the cache fills we drop the entire map and start fresh — coarse but
// adequate: this is a syscall-saver on a slow tier, not a hot path.
const uidNameCacheCap = 1024

// uidNameCache reduces syscalls on a busy host.
var (
	uidNameCacheMu sync.Mutex
	uidNameCache   = make(map[uint32]string, uidNameCacheCap)
)

func uidToName(uid uint32) string {
	uidNameCacheMu.Lock()
	if v, ok := uidNameCache[uid]; ok {
		uidNameCacheMu.Unlock()
		return v
	}
	uidNameCacheMu.Unlock()

	u, err := user.LookupId(strconv.FormatUint(uint64(uid), 10))
	name := ""
	if err == nil {
		name = u.Username
	} else {
		name = strconv.FormatUint(uint64(uid), 10)
	}

	uidNameCacheMu.Lock()
	if len(uidNameCache) >= uidNameCacheCap {
		// Coarse eviction: drop the whole map. The next collector tick will
		// repopulate the still-live UIDs from /etc/passwd lookups.
		uidNameCache = make(map[uint32]string, uidNameCacheCap)
	}
	uidNameCache[uid] = name
	uidNameCacheMu.Unlock()
	return name
}

// collectTopProcesses returns the top N processes by CPU% and by RSS, deduped
// into a single list sorted by CPU desc.
func collectTopProcesses(top int) []ProcessInfo {
	entries, err := os.ReadDir(procPath())
	if err != nil {
		return nil
	}
	now := time.Now()

	procSampleMu.Lock()
	prev := procLastSamples
	prevT := procLastSampleT
	curSamples := make(map[int]procSample, len(prev))
	procSampleMu.Unlock()

	type row struct {
		pid     int
		uid     uint32
		name    string
		threads int
		rssKB   int64
		cpuPct  float64
	}
	var rows []row

	dt := now.Sub(prevT).Seconds()
	if dt <= 0 {
		dt = 1
	}

	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		uid, sample, threads, name, rssKB, ok := readProcStat(pid)
		if !ok {
			continue
		}
		curSamples[pid] = sample

		cpu := 0.0
		if p, ok := prev[pid]; ok && !prevT.IsZero() {
			deltaJiffies := float64((sample.utime + sample.stime) - (p.utime + p.stime))
			cpu = 100 * (deltaJiffies / clkTck) / dt
			if cpu < 0 {
				cpu = 0
			}
		}
		rows = append(rows, row{
			pid:     pid,
			uid:     uid,
			name:    name,
			threads: threads,
			rssKB:   rssKB,
			cpuPct:  cpu,
		})
	}

	procSampleMu.Lock()
	procLastSamples = curSamples
	procLastSampleT = now
	procSampleMu.Unlock()

	// Take top-N by CPU, then merge in top-N by RSS not already present.
	sort.Slice(rows, func(i, j int) bool { return rows[i].cpuPct > rows[j].cpuPct })
	seen := map[int]bool{}
	chosen := make([]row, 0, top*2)
	for i := 0; i < len(rows) && len(chosen) < top; i++ {
		chosen = append(chosen, rows[i])
		seen[rows[i].pid] = true
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].rssKB > rows[j].rssKB })
	for i := 0; i < len(rows) && len(chosen) < top*2; i++ {
		if seen[rows[i].pid] {
			continue
		}
		chosen = append(chosen, rows[i])
	}

	out := make([]ProcessInfo, 0, len(chosen))
	for _, r := range chosen {
		out = append(out, ProcessInfo{
			PID:     r.pid,
			Name:    r.name,
			User:    uidToName(r.uid),
			CPU:     roundTo(r.cpuPct, 1),
			MemMB:   roundTo(float64(r.rssKB)/1024, 1),
			Cmd:     readProcCmdline(r.pid),
			Threads: r.threads,
		})
	}
	// Final sort by CPU desc so the UI doesn't have to.
	sort.Slice(out, func(i, j int) bool {
		if out[i].CPU != out[j].CPU {
			return out[i].CPU > out[j].CPU
		}
		return out[i].MemMB > out[j].MemMB
	})
	return out
}

// ---------------------------------------------------------------------------
// Per-core CPU
// ---------------------------------------------------------------------------

var (
	coreLastMu sync.Mutex
	coreLast   map[int]cpuJiffies
)

// collectPerCoreCPU takes pre-parsed cpuStats (shared with cpuUsage on the
// fast tick) and returns the per-core busy% diff against the previous tick.
func collectPerCoreCPU(s cpuStats) []CoreUsage {
	if len(s.perCore) == 0 {
		return nil
	}
	cur := make(map[int]cpuJiffies, len(s.perCore))
	for _, cj := range s.perCore {
		cur[cj.core] = cj.j
	}

	coreLastMu.Lock()
	prev := coreLast
	coreLast = cur
	coreLastMu.Unlock()

	// s.perCore is already in /proc/stat order (cpu0, cpu1, ...) which is the
	// order we want to emit; skip the extra sort + cores slice allocation.
	out := make([]CoreUsage, 0, len(s.perCore))
	for _, cj := range s.perCore {
		pct := 0.0
		if p, ok := prev[cj.core]; ok {
			dt := float64(cj.j.total() - p.total())
			if dt > 0 {
				pct = clampPct(100 * float64(cj.j.busy()-p.busy()) / dt)
			}
		}
		out = append(out, CoreUsage{Core: cj.core, Pct: roundTo(pct, 1)})
	}
	return out
}

// ---------------------------------------------------------------------------
// Disk I/O throughput  (/proc/diskstats)
// ---------------------------------------------------------------------------

type diskStatsSnap struct {
	readsCompleted, sectorsRead, writesCompleted, sectorsWritten, ioTicks uint64
}

var (
	diskIOMu      sync.Mutex
	diskIOLast    map[string]diskStatsSnap
	diskIOLastT   time.Time
	sectorSize    = uint64(512)
)

// wholeDiskRe matches block-device names that are whole disks (not
// partitions or virtual devices). Covered families:
//
//   - SCSI/SATA/USB:  sda, sdb, sdaa
//   - legacy IDE:     hda, hdb
//   - virtio:         vda, vdb
//   - Xen virt block: xvda
//   - NVMe namespace: nvme0n1, nvme1n2  (each namespace is a "whole disk")
//   - eMMC/SD:        mmcblk0, mmcblk1
//   - SCSI removable: sr0  (CD/DVD)
//   - persistent mem: pmem0
//
// Partitions (sda1, nvme0n1p1, mmcblk0p1) are explicitly NOT matched, nor
// are loopback, ramdisk, or device-mapper aggregates (loop*, ram*, dm-*).
var wholeDiskRe = regexp.MustCompile(`^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|sr\d+|pmem\d+)$`)

func isWholeDisk(name string) bool {
	return wholeDiskRe.MatchString(name)
}

func readDiskstats() map[string]diskStatsSnap {
	out := map[string]diskStatsSnap{}
	f, err := os.Open(procPath("diskstats"))
	if err != nil {
		return out
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		fields := strings.Fields(s.Text())
		// 1=major 2=minor 3=name 4=reads_completed 5=reads_merged 6=sectors_read
		// 7=ms_reading 8=writes_completed 9=writes_merged 10=sectors_written
		// 11=ms_writing 12=ios_in_flight 13=ms_in_io 14=weighted_ms_in_io
		if len(fields) < 14 {
			continue
		}
		name := fields[2]
		if !isWholeDisk(name) {
			continue
		}
		var d diskStatsSnap
		d.readsCompleted, _ = strconv.ParseUint(fields[3], 10, 64)
		d.sectorsRead, _ = strconv.ParseUint(fields[5], 10, 64)
		d.writesCompleted, _ = strconv.ParseUint(fields[7], 10, 64)
		d.sectorsWritten, _ = strconv.ParseUint(fields[9], 10, 64)
		d.ioTicks, _ = strconv.ParseUint(fields[12], 10, 64)
		out[name] = d
	}
	return out
}

func collectDiskIO() []DiskIO {
	cur := readDiskstats()
	now := time.Now()

	diskIOMu.Lock()
	prev := diskIOLast
	prevT := diskIOLastT
	diskIOLast = cur
	diskIOLastT = now
	diskIOMu.Unlock()

	dt := now.Sub(prevT).Seconds()
	if dt <= 0 {
		dt = 1
	}

	names := make([]string, 0, len(cur))
	for k := range cur {
		names = append(names, k)
	}
	sort.Strings(names)

	out := make([]DiskIO, 0, len(names))
	for _, name := range names {
		c := cur[name]
		p := prev[name]
		readBytes := float64((c.sectorsRead - p.sectorsRead) * sectorSize)
		writeBytes := float64((c.sectorsWritten - p.sectorsWritten) * sectorSize)
		readIO := float64(c.readsCompleted - p.readsCompleted)
		writeIO := float64(c.writesCompleted - p.writesCompleted)
		// ioTicks is in ms; convert busy% as min(100, ticks_delta / (dt*1000) * 100)
		ticks := float64(c.ioTicks - p.ioTicks)
		util := 100 * ticks / (dt * 1000)
		if util > 100 {
			util = 100
		}
		if util < 0 {
			util = 0
		}
		out = append(out, DiskIO{
			ID:        name,
			ReadBps:   roundTo(readBytes/dt, 0),
			WriteBps:  roundTo(writeBytes/dt, 0),
			ReadIops:  roundTo(readIO/dt, 1),
			WriteIops: roundTo(writeIO/dt, 1),
			UtilPct:   roundTo(util, 1),
		})
	}
	return out
}

// keep the import busy when stripping things later
var _ = filepath.Join
