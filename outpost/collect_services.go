package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// We can't shell out to `systemctl` inside the container — it prefers
// /run/systemd/private which is bound to a host-PID socket and isn't usable
// across mount namespaces (returns "No such device or address"). DBus passes
// through fine, so we hit the DBus REST-like JSON over `busctl` instead, or
// fall back to talking via systemd's DBus methods directly through a private
// socket dialer.
//
// Approach: shell out to `busctl --json=short` for ListUnits + Get properties.
// busctl is part of systemd-tools, ships with the systemd package we install,
// and talks DBus over /run/dbus/system_bus_socket — which works inside the
// container with apparmor=unconfined.

// skipUnit suppresses systemd's own scaffolding so the list shows the things
// you'd actually want to monitor.
func skipUnit(name string) bool {
	switch {
	case strings.HasPrefix(name, "systemd-"):
		return true
	case strings.HasPrefix(name, "user@"):
		return true
	case strings.HasPrefix(name, "user-runtime-dir@"):
		return true
	case strings.HasPrefix(name, "getty@"):
		return true
	case strings.HasPrefix(name, "modprobe@"):
		return true
	case strings.HasPrefix(name, "snapd."):
		return true
	case strings.HasPrefix(name, "snap."):
		return true
	}
	return false
}

func collectServices(ctx context.Context) ([]Service, error) {
	if _, err := exec.LookPath("busctl"); err != nil {
		return nil, fmt.Errorf("busctl not in PATH (install systemd/dbus)")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// ListUnits returns an array of (n, descr, load, active, sub, follower, objpath, jobid, jobtype, jobpath).
	cmd := exec.CommandContext(ctx, "busctl",
		"--system", "--json=short", "--no-pager",
		"call",
		"org.freedesktop.systemd1",
		"/org/freedesktop/systemd1",
		"org.freedesktop.systemd1.Manager",
		"ListUnits",
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("busctl ListUnits: %w", err)
	}
	// busctl --json=short returns: {"type":"a(ssssssouso)","data":[ [name,desc,load,active,sub,follower,path,jobid,jobtype,jobpath], ... ]}
	// The data is wrapped in an extra array because ListUnits returns a single array.
	var resp struct {
		Type string `json:"type"`
		Data []any  `json:"data"`
	}
	if err := json.Unmarshal(out, &resp); err != nil {
		return nil, fmt.Errorf("parse ListUnits: %w", err)
	}
	if len(resp.Data) == 0 {
		return nil, nil
	}
	// The first element is the array of unit tuples.
	tuples, ok := resp.Data[0].([]any)
	if !ok {
		return nil, fmt.Errorf("unexpected ListUnits shape: %T", resp.Data[0])
	}

	var keep []sdUnitTuple
	for _, t := range tuples {
		row, ok := t.([]any)
		if !ok || len(row) < 7 {
			continue
		}
		u := sdUnitTuple{
			name:        toStr(row[0]),
			description: toStr(row[1]),
			load:        toStr(row[2]),
			active:      toStr(row[3]),
			sub:         toStr(row[4]),
			objPath:     toStr(row[6]),
		}
		if !strings.HasSuffix(u.name, ".service") {
			continue
		}
		if u.load != "loaded" {
			continue
		}
		if u.active != "active" && u.active != "failed" && u.active != "activating" {
			continue
		}
		if skipUnit(u.name) {
			continue
		}
		keep = append(keep, u)
	}

	// Pull props for each kept unit. The old code did 4 sequential
	// `busctl get-property` shell-outs per service (~3 ms each × 4 props ×
	// 50 services = ~600 ms of process spawn time per medium tick). We now:
	//
	//   1. Use Properties.GetAll instead of per-property Get — 1 call covers
	//      every property on an interface. Two interfaces (Service + Unit)
	//      give us everything we need, halving the call count.
	//   2. Fan out across units with a bounded worker pool. Each busctl
	//      process opens its own DBus connection; systemd-bus tolerates the
	//      concurrency happily.
	//
	// A real fix would be a long-lived godbus connection (no fork/exec at
	// all) — see the README/SECURITY_REVIEW notes for follow-up.
	out2 := make([]Service, len(keep))
	sem := make(chan struct{}, 16)
	var wg sync.WaitGroup
	for i := range keep {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			u := keep[i]
			props := unitProps(ctx, u.objPath)
			var pidPtr *int
			if p, ok := props["MainPID"].(float64); ok && p > 0 {
				v := int(p)
				pidPtr = &v
			}
			memMB := 0.0
			if m, ok := props["MemoryCurrent"].(float64); ok && m > 0 && m < 1e15 {
				// systemd reports UINT64_MAX (~1.8e19) when the property is
				// unset (e.g. cgroup not accounting memory); filter that out.
				memMB = roundTo(m/1024/1024, 1)
			}
			enabled := false
			if s, ok := props["UnitFileState"].(string); ok && (s == "enabled" || s == "static") {
				enabled = true
			}
			user := "root"
			if s, ok := props["User"].(string); ok && s != "" {
				user = s
			}
			out2[i] = Service{
				Name:        u.name,
				Status:      u.active,
				Enabled:     enabled,
				PID:         pidPtr,
				MemMb:       memMB,
				User:        user,
				Description: u.description,
				FailedSince: failedSince(props, u.active),
			}
		}(i)
	}
	wg.Wait()

	sort.SliceStable(out2, func(i, j int) bool {
		if (out2[i].Status == "failed") != (out2[j].Status == "failed") {
			return out2[i].Status == "failed"
		}
		return out2[i].Name < out2[j].Name
	})
	return out2, nil
}

// failedSince is when a failed unit entered that state, in Unix ms, from
// systemd's StateChangeTimestamp (µs; fetched with the other Unit
// properties, so no extra call). 0 for healthy units or a missing value.
func failedSince(props map[string]any, status string) int64 {
	if status != "failed" {
		return 0
	}
	us, ok := props["StateChangeTimestamp"].(float64)
	if !ok || us <= 0 {
		return 0
	}
	return int64(us) / 1000
}

type sdUnitTuple struct {
	name, description, load, active, sub, objPath string
}

func toStr(v any) string {
	s, _ := v.(string)
	return s
}

// unitProps fetches MainPID + MemoryCurrent + UnitFileState + User for one
// unit using Properties.GetAll — one call per interface (Service, Unit)
// instead of one call per property. Cuts busctl shell-outs in half
// regardless of how many properties we end up consuming.
func unitProps(ctx context.Context, objPath string) map[string]any {
	out := map[string]any{}
	for _, iface := range []string{
		"org.freedesktop.systemd1.Service",
		"org.freedesktop.systemd1.Unit",
	} {
		fetchAllProps(ctx, objPath, iface, out)
	}
	return out
}

// fetchAllProps runs Properties.GetAll on the given DBus interface and merges
// the unwrapped property values into dst. busctl --json=short wraps each
// variant as {"type":"...","data":VALUE}; we unwrap to just VALUE so the
// caller's type-asserts against `any` remain unchanged.
func fetchAllProps(ctx context.Context, objPath, iface string, dst map[string]any) {
	cmd := exec.CommandContext(ctx, "busctl",
		"--system", "--json=short",
		"call",
		"org.freedesktop.systemd1",
		objPath,
		"org.freedesktop.DBus.Properties",
		"GetAll", "s", iface,
	)
	b, err := cmd.Output()
	if err != nil {
		return
	}
	// Shape: {"type":"a{sv}","data":[{"PropName":{"type":"...","data":VALUE}, ...}]}
	var r struct {
		Data []map[string]struct {
			Data any `json:"data"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return
	}
	if len(r.Data) == 0 {
		return
	}
	for k, v := range r.Data[0] {
		dst[k] = v.Data
	}
}

