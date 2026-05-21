package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// procPath joins under HOST_PROC (defaults to /proc), so the same code works
// inside a container with /proc:/host/proc:ro or on the host directly.
func procPath(elem ...string) string {
	base := os.Getenv("HOST_PROC")
	if base == "" {
		base = "/proc"
	}
	return filepath.Join(append([]string{base}, elem...)...)
}

func sysPath(elem ...string) string {
	base := os.Getenv("HOST_SYS")
	if base == "" {
		base = "/sys"
	}
	return filepath.Join(append([]string{base}, elem...)...)
}

func etcPath(elem ...string) string {
	base := os.Getenv("HOST_ETC")
	if base == "" {
		base = "/etc"
	}
	return filepath.Join(append([]string{base}, elem...)...)
}

// hostMountsPath returns a path to mountinfo that reflects the host's mount
// namespace. Inside a container `/proc/self/mounts` shows only container
// mounts, so when HOST_PROC is set we read `/host/proc/1/mounts` instead —
// PID 1 in the host's namespace sees the real system mounts.
func hostMountsPath() string {
	if os.Getenv("HOST_PROC") != "" {
		return procPath("1", "mounts")
	}
	return procPath("mounts")
}

// hostNetPath returns a path under /proc that reflects the host's network
// namespace. Inside a container, /proc/net is the container's net ns;
// /proc/1/net is PID 1's net ns, which on the host is the root net ns.
func hostNetPath(file string) string {
	if os.Getenv("HOST_PROC") != "" {
		return procPath("1", "net", file)
	}
	return procPath("net", file)
}

// hostFsPath rewrites a host-namespace mount path so syscall.Statfs() works
// from inside a container. When HOST_ROOT is set (e.g. host's /:/hostfs:ro),
// "/mnt/disk1" becomes "/hostfs/mnt/disk1". Off the host, paths are unchanged.
func hostFsPath(p string) string {
	base := os.Getenv("HOST_ROOT")
	if base == "" {
		return p
	}
	if p == "/" {
		return base
	}
	return filepath.Join(base, p)
}

// readSysFloat reads a /sys (or /proc) leaf file expected to hold a single
// numeric value, returning (value, true) on success or (0, false) on any
// read or parse error. The trailing newline is trimmed.
func readSysFloat(path string) (float64, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// readSysString reads a /sys (or /proc) leaf file and returns its trimmed
// contents, or "" on any error. Suitable for short name/state files.
func readSysString(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
