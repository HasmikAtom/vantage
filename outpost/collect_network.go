package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// /proc/net/dev gives cumulative rx/tx in bytes. Convert to a per-second
// rate by sampling twice across our refresh interval.
type ifaceCounters struct {
	rxBytes, txBytes uint64
}

var (
	netMu    sync.Mutex
	netLast  = map[string]ifaceCounters{}
	netLastT time.Time
)

func readNetDev() map[string]ifaceCounters {
	out := map[string]ifaceCounters{}
	f, err := os.Open(hostNetPath("dev"))
	if err != nil {
		return out
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := s.Text()
		i := strings.Index(line, ":")
		if i < 0 {
			continue
		}
		name := strings.TrimSpace(line[:i])
		fields := strings.Fields(line[i+1:])
		if len(fields) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(fields[0], 10, 64)
		tx, _ := strconv.ParseUint(fields[8], 10, 64)
		out[name] = ifaceCounters{rxBytes: rx, txBytes: tx}
	}
	return out
}

// listInterfaces does ONE netlink enumeration of all interfaces (the
// expensive part of `net.InterfaceByName`, which fetched the full list per
// call) and returns a name→Interface map. Addrs() is fetched lazily by the
// caller for kept ifaces only — important on Docker-heavy hosts where most
// ifaces are veth/br- pairs we filter out.
func listInterfaces() map[string]net.Interface {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := make(map[string]net.Interface, len(ifaces))
	for _, iface := range ifaces {
		out[iface.Name] = iface
	}
	return out
}

// ipv4Of returns the first IPv4 address bound to iface, or "" if none.
func ipv4Of(iface net.Interface) string {
	addrs, err := iface.Addrs()
	if err != nil {
		return ""
	}
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok {
			if v4 := ipn.IP.To4(); v4 != nil {
				return v4.String()
			}
		}
	}
	return ""
}

func (m *Manager) collectNetwork() Network {
	cur := readNetDev()
	now := time.Now()

	netMu.Lock()
	prev := netLast
	prevT := netLastT
	netLast = cur
	netLastT = now
	netMu.Unlock()

	dt := now.Sub(prevT).Seconds()
	if dt <= 0 {
		dt = 1
	}

	// ONE netlink enumeration up front. Old code did a full enumeration
	// inside every interfaceIP() and interfaceUp() fallback call — once per
	// retained iface. We now pay the list cost once and call Addrs() only
	// for ifaces that survive the prefix filter.
	byName := listInterfaces()

	ifaces := make([]NetInterface, 0, len(cur))
	for name, c := range cur {
		// Skip docker veth pairs and per-network bridges; keep docker0 itself.
		if strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "br-") {
			continue
		}
		var rxRate, txRate int
		if p, ok := prev[name]; ok {
			rxRate = int(float64(c.rxBytes-p.rxBytes) / dt)
			txRate = int(float64(c.txBytes-p.txBytes) / dt)
			if rxRate < 0 {
				rxRate = 0
			}
			if txRate < 0 {
				txRate = 0
			}
		}
		iface, haveIface := byName[name]
		// sysfs operstate is more accurate across mount/net namespaces; fall
		// back to the netlink-derived up flag only if operstate is empty.
		status := "down"
		if state := readSysString(sysPath("class", "net", name, "operstate")); state != "" {
			if state == "up" || state == "unknown" {
				status = "up"
			}
		} else if haveIface && iface.Flags&net.FlagUp != 0 {
			status = "up"
		}
		ip := ""
		if haveIface {
			ip = ipv4Of(iface)
		}
		ifaces = append(ifaces, NetInterface{
			Name:   name,
			IP:     ip,
			RX:     rxRate,
			TX:     txRate,
			Status: status,
		})
	}

	// Stable order: lo last, then alphabetical.
	netSort(ifaces)

	// Total throughput sparkline = sum of all non-loopback rx+tx per second.
	total := 0
	for _, i := range ifaces {
		if i.Name == "lo" {
			continue
		}
		total += i.RX + i.TX
	}

	// Push into a ring buffer so the UI gets a real 24-sample series.
	history := m.pushHistory("network.total", float64(total))
	sparkline := make([]int, len(history))
	for i, v := range history {
		sparkline[i] = int(v)
	}

	return Network{
		Interfaces: ifaces,
		Sparkline:  sparkline,
	}
}

func netSort(ifs []NetInterface) {
	// lo last, others alphabetical — small N (handful of NICs).
	sort.Slice(ifs, func(i, j int) bool {
		a, b := ifs[i].Name, ifs[j].Name
		if a == "lo" {
			return false
		}
		if b == "lo" {
			return true
		}
		return a < b
	})
}

// ---------------------------------------------------------------------------
// /proc/net/tcp{,6} — listening sockets
// ---------------------------------------------------------------------------

// dockerHostPortToContainer is populated by the docker collector at refresh
// time. The port classifier uses it to flag "docker"-backed bindings, and
// the ports collector uses it to translate docker-proxy → actual container.
var (
	dockerPortsMu             sync.RWMutex
	dockerHostPortToContainer = map[int]string{}
)

func setDockerHostPortMap(ports map[int]string) {
	dockerPortsMu.Lock()
	dockerHostPortToContainer = ports
	dockerPortsMu.Unlock()
}

func dockerContainerForHostPort(p int) (string, bool) {
	dockerPortsMu.RLock()
	defer dockerPortsMu.RUnlock()
	name, ok := dockerHostPortToContainer[p]
	return name, ok
}

func isDockerPort(p int) bool {
	_, ok := dockerContainerForHostPort(p)
	return ok
}

type listenSocket struct {
	port  int
	proto string
	v6    bool
	inode uint64
	ipHex string
}

// readListenSockets parses /proc/1/net/tcp{,6} (host net ns) for LISTEN
// entries. Column 9 of /proc/net/tcp is the socket inode, which lets us join
// to /proc/[pid]/fd later.
func readListenSockets() []listenSocket {
	var out []listenSocket
	// Per-iteration body wrapped in a func so `defer f.Close()` runs at the
	// end of each iteration rather than at readListenSockets exit. A future
	// early `continue` inside the body would otherwise leak the handle.
	scan := func(path, proto string, v6 bool) {
		f, err := os.Open(path)
		if err != nil {
			return
		}
		defer f.Close()
		s := bufio.NewScanner(f)
		s.Scan() // skip header
		for s.Scan() {
			fields := strings.Fields(s.Text())
			if len(fields) < 10 || fields[3] != "0A" {
				continue
			}
			local := fields[1]
			colon := strings.IndexByte(local, ':')
			if colon < 0 {
				continue
			}
			portN, err := strconv.ParseInt(local[colon+1:], 16, 32)
			if err != nil {
				continue
			}
			inode, _ := strconv.ParseUint(fields[9], 10, 64)
			out = append(out, listenSocket{
				port:  int(portN),
				proto: proto,
				v6:    v6,
				inode: inode,
				ipHex: local[:colon],
			})
		}
	}
	scan(hostNetPath("tcp"), "tcp", false)
	scan(hostNetPath("tcp6"), "tcp", true)
	return out
}

// inodeOwnerMap walks /host/proc/[pid]/fd/* and records (inode → pid) for
// any socket inode present in `want`. Requires CAP_SYS_PTRACE inside a
// container to read fds owned by other UIDs; off-container, you get coverage
// only for processes owned by the calling user.
//
// Performance:
//   - Bails out as soon as every wanted inode has been resolved (kernel
//     threads and other unrelated pids are skipped without inspection).
//   - Uses `pidStr := e.Name()` + string concat instead of Atoi→Itoa →
//     filepath.Join — saves ~3 allocations per /proc/[pid]/fd entry, which
//     adds up across hundreds of pids × tens of fds.
func inodeOwnerMap(want map[uint64]bool) map[uint64]int {
	out := make(map[uint64]int, len(want))
	if len(want) == 0 {
		return out
	}
	entries, err := os.ReadDir(procPath())
	if err != nil {
		return out
	}
	for _, e := range entries {
		// Use the dirent name as the pid string directly — skip the
		// strconv.Atoi → strconv.Itoa round-trip the old code did. Validate
		// digits-only so we don't try to enter /proc/self, /proc/cpuinfo, etc.
		pidStr := e.Name()
		if !allDigits(pidStr) {
			continue
		}
		fdDir := procPath(pidStr, "fd")
		fds, err := os.ReadDir(fdDir)
		if err != nil {
			// Kernel threads have no fd directory; permission denied also
			// lands here. Either way, nothing for us to inspect.
			continue
		}
		for _, fd := range fds {
			// Plain string concat is cheaper than filepath.Join (no Clean,
			// no variadic slice) and produces identical paths under /proc.
			target, err := os.Readlink(fdDir + "/" + fd.Name())
			if err != nil {
				continue
			}
			// Looking for "socket:[12345]"
			const prefix = "socket:["
			if !strings.HasPrefix(target, prefix) || !strings.HasSuffix(target, "]") {
				continue
			}
			inode, err := strconv.ParseUint(target[len(prefix):len(target)-1], 10, 64)
			if err != nil {
				continue
			}
			if !want[inode] {
				continue
			}
			// First PID wins; processes can share sockets via fork+inherit
			// but the listener is usually the one that opened it first.
			if _, taken := out[inode]; taken {
				continue
			}
			pid, err := strconv.Atoi(pidStr)
			if err != nil {
				continue
			}
			out[inode] = pid
			// Early exit: every listening socket has a pid. Saves walking
			// the long tail of fd directories once we've matched them all.
			if len(out) == len(want) {
				return out
			}
		}
	}
	return out
}

// allDigits reports whether s is non-empty and contains only '0'..'9'.
// Used to validate /proc dirents without paying for strconv.Atoi (which
// allocates an error on every non-pid name).
func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func readProcessName(pid int) string {
	if pid <= 0 {
		return ""
	}
	b, err := os.ReadFile(procPath(strconv.Itoa(pid), "comm"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func collectPorts() []Port {
	sockets := readListenSockets()

	want := make(map[uint64]bool, len(sockets))
	for _, s := range sockets {
		if s.inode != 0 {
			want[s.inode] = true
		}
	}
	owners := inodeOwnerMap(want)

	seen := map[string]bool{}
	out := []Port{}
	for _, s := range sockets {
		key := fmt.Sprintf("%d/%s", s.port, s.proto)
		if seen[key] {
			continue
		}
		seen[key] = true

		pid := owners[s.inode]
		proc := readProcessName(pid)

		// For docker-proxy ports, surface the actual container as the
		// "service" so the UI doesn't just say "docker-proxy" for everything.
		service := proc
		if proc == "docker-proxy" {
			if container, ok := dockerContainerForHostPort(s.port); ok {
				service = container
			}
		}

		var pidPtr *int
		if pid > 0 {
			pidPtr = &pid
		}

		out = append(out, Port{
			Port:    s.port,
			Proto:   s.proto,
			Service: service,
			Exposed: classifyExposure(s.ipHex, s.port, s.v6),
			PID:     pidPtr,
			Process: proc,
		})
	}
	return out
}

func classifyExposure(ipHex string, port int, v6 bool) string {
	// All-zero local addr = wildcard bind (0.0.0.0 or ::)
	allZero := strings.Trim(ipHex, "0") == ""
	loop := false
	if !v6 {
		// little-endian: 0100007F == 127.0.0.1
		loop = strings.EqualFold(ipHex, "0100007F")
	} else {
		// ::1 in /proc/net/tcp6 is 00000000000000000000000001000000
		loop = strings.HasSuffix(strings.ToLower(ipHex), "01000000") &&
			strings.Trim(ipHex[:len(ipHex)-8], "0") == ""
	}
	if isDockerPort(port) {
		return "docker"
	}
	if loop {
		return "loopback"
	}
	if allZero {
		return "lan"
	}
	return "lan"
}
