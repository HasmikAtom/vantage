package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
)

// /proc/net/tcp{,6} parsing again, this time for state 01 (ESTABLISHED).
// Connections are grouped by (remote IP, local port) so a noisy client appears
// once with a count, rather than 30 nearly-identical rows.

func collectConnections(servicesByPort map[int]string) []Connection {
	type key struct {
		remote string
		port   int
	}
	counts := map[key]int{}

	for _, spec := range []struct {
		path string
		v6   bool
	}{
		{hostNetPath("tcp"), false},
		{hostNetPath("tcp6"), true},
	} {
		f, err := os.Open(spec.path)
		if err != nil {
			continue
		}
		s := bufio.NewScanner(f)
		s.Scan() // header
		for s.Scan() {
			fields := strings.Fields(s.Text())
			if len(fields) < 4 || fields[3] != "01" {
				continue
			}
			localHex := fields[1]
			remoteHex := fields[2]
			lp := strings.IndexByte(localHex, ':')
			rp := strings.IndexByte(remoteHex, ':')
			if lp < 0 || rp < 0 {
				continue
			}
			localPort, err := strconv.ParseInt(localHex[lp+1:], 16, 32)
			if err != nil {
				continue
			}
			remoteIP := parseHexIP(remoteHex[:rp], spec.v6)
			if remoteIP == "" {
				continue
			}
			counts[key{remote: remoteIP, port: int(localPort)}]++
		}
		f.Close()
	}

	out := make([]Connection, 0, len(counts))
	for k, n := range counts {
		out = append(out, Connection{
			RemoteIP:  k.remote,
			LocalPort: k.port,
			Service:   servicesByPort[k.port],
			Count:     n,
		})
	}
	// Highest-count first, then by remote IP for stable order.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].RemoteIP < out[j].RemoteIP
	})
	// Cap at 100 rows so we don't blow the JSON budget on busy boxes.
	if len(out) > 100 {
		out = out[:100]
	}
	return out
}

// parseHexIP turns the little-endian hex from /proc/net/tcp{,6} into a
// dotted/colon-colon string.
func parseHexIP(hex string, v6 bool) string {
	if !v6 {
		if len(hex) != 8 {
			return ""
		}
		b := make([]byte, 4)
		for i := 0; i < 4; i++ {
			v, err := strconv.ParseUint(hex[2*i:2*i+2], 16, 8)
			if err != nil {
				return ""
			}
			b[3-i] = byte(v)
		}
		return net.IP(b).String()
	}
	if len(hex) != 32 {
		return ""
	}
	// IPv6 in /proc is stored as four 32-bit little-endian words.
	b := make([]byte, 16)
	for word := 0; word < 4; word++ {
		for i := 0; i < 4; i++ {
			v, err := strconv.ParseUint(hex[word*8+2*i:word*8+2*i+2], 16, 8)
			if err != nil {
				return ""
			}
			b[word*4+3-i] = byte(v)
		}
	}
	ip := net.IP(b)
	// IPv4-mapped: ::ffff:1.2.3.4 — show as 1.2.3.4
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

// keep fmt referenced for future debug formatting
var _ = fmt.Sprintf
