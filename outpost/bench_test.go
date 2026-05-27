package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// ---------------------------------------------------------------------------
// /proc parsers (called every 2s on the fast tick)
// ---------------------------------------------------------------------------

func BenchmarkReadMeminfo(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = readMeminfo()
	}
}

func BenchmarkCollectMem(b *testing.B) {
	mi := readMeminfo()
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = collectMem(mi)
	}
}

func BenchmarkCollectSwap(b *testing.B) {
	mi := readMeminfo()
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = collectSwap(mi)
	}
}

func BenchmarkReadCPUStats(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = readCPUStats()
	}
}

func BenchmarkCPUUsage(b *testing.B) {
	// Prime so the first iter isn't the all-zeros short-circuit.
	s := readCPUStats()
	_, _, _, _, _, _, _, _ = cpuUsage(s)
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		s = readCPUStats()
		_, _, _, _, _, _, _, _ = cpuUsage(s)
	}
}

func BenchmarkCollectPerCoreCPU(b *testing.B) {
	s := readCPUStats()
	_ = collectPerCoreCPU(s)
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		s = readCPUStats()
		_ = collectPerCoreCPU(s)
	}
}

func BenchmarkReadNetDev(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = readNetDev()
	}
}

func BenchmarkCollectNetwork(b *testing.B) {
	m := NewManager()
	_ = m.collectNetwork() // prime
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = m.collectNetwork()
	}
}

func BenchmarkCollectSystem(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = collectSystem()
	}
}

func BenchmarkReadCPUClock(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = readCPUClock()
	}
}

func BenchmarkReadCPUModelCores(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = readCPUModelCores()
	}
}

func BenchmarkReadDiskstats(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = readDiskstats()
	}
}

// collectTopProcesses runs on the medium (15s) tick. It's the heaviest of
// the medium-tick collectors because it walks /proc and opens up to three
// files per process.
func BenchmarkCollectTopProcesses(b *testing.B) {
	_, _ = collectTopProcesses(10) // prime sample state
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = collectTopProcesses(10)
	}
}

// ---------------------------------------------------------------------------
// Other medium-tick collectors
// ---------------------------------------------------------------------------

func BenchmarkCollectFilesystems(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = collectFilesystems()
	}
}

func BenchmarkCollectConnections(b *testing.B) {
	ports := collectPorts()
	servicesByPort := make(map[int]string, len(ports))
	for _, p := range ports {
		servicesByPort[p.Port] = p.Service
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = collectConnections(servicesByPort)
	}
}

func BenchmarkCollectPorts(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = collectPorts()
	}
}

// collectServices shells out to busctl; the bench runs at most a few times
// per second, so we set benchtime in the invocation rather than relying on
// the default ns/op-driven loop.
func BenchmarkCollectServices(b *testing.B) {
	ctx := context.Background()
	if _, err := collectServices(ctx); err != nil {
		b.Skipf("busctl not usable in this environment: %v", err)
	}
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := collectServices(ctx); err != nil {
			b.Fatal(err)
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP handler end-to-end. Two paths matter:
//   - 304 Not Modified (ETag match — the steady-state poll)
//   - 200 OK with full JSON body (after each refresh tick)
// ---------------------------------------------------------------------------

func BenchmarkDashboardHandler304(b *testing.B) {
	mgr := NewManager()
	mgr.refreshFast(context.Background())
	// Force the manager into having a known version for ETag matching.
	_, version := mgr.SnapshotWithVersion()
	etag := fmt.Sprintf(`W/"%d"`, version)

	// Build the handler inline (mirrors what /dashboard does, against this
	// local manager rather than the package-level one).
	h := dashboardHandler(mgr)

	req := httptest.NewRequest(http.MethodGet, "/dashboard", nil)
	req.Header.Set("If-None-Match", etag)

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusNotModified {
			b.Fatalf("want 304, got %d", w.Code)
		}
	}
}

func BenchmarkDashboardHandler200(b *testing.B) {
	mgr := NewManager()
	mgr.refreshFast(context.Background())
	h := dashboardHandler(mgr)
	req := httptest.NewRequest(http.MethodGet, "/dashboard", nil)

	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			b.Fatalf("want 200, got %d", w.Code)
		}
	}
}

func BenchmarkCollectPressure(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = collectPressure()
	}
}

// ---------------------------------------------------------------------------
// pushHistory (hit several times per fast tick: 4 headline series + sensors)
// ---------------------------------------------------------------------------

func BenchmarkPushHistory(b *testing.B) {
	m := NewManager()
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = m.pushHistory("bench", float64(i))
	}
}

// ---------------------------------------------------------------------------
// Pure parse helpers (no syscalls)
// ---------------------------------------------------------------------------

func BenchmarkParseHexIPv4(b *testing.B) {
	in := "0100007F" // 127.0.0.1
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = parseHexIP(in, false)
	}
}

func BenchmarkParseHexIPv6(b *testing.B) {
	in := "0000000000000000FFFF00000100007F" // ::ffff:127.0.0.1-ish
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = parseHexIP(in, true)
	}
}

// ---------------------------------------------------------------------------
// Manager snapshot read path (every /dashboard hit)
// ---------------------------------------------------------------------------

func BenchmarkSnapshotWithVersion(b *testing.B) {
	m := NewManager()
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_, _ = m.SnapshotWithVersion()
	}
}

// Contended read path: simulates many concurrent /dashboard pollers
// while a writer occasionally bumps the snapshot (refreshFast cadence).
func BenchmarkSnapshotWithVersionParallel(b *testing.B) {
	m := NewManager()
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			m.mu.Lock()
			m.version++
			m.mu.Unlock()
		}
	}()
	b.ResetTimer()
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_, _ = m.SnapshotWithVersion()
		}
	})
	b.StopTimer()
	close(stop)
	wg.Wait()
}

// ---------------------------------------------------------------------------
// JSON encode of the full snapshot — every non-304 /dashboard response.
// We use a primed manager so the snapshot has realistic data.
// ---------------------------------------------------------------------------

func primedSnapshot(b *testing.B) DashboardSnapshot {
	b.Helper()
	m := NewManager()
	m.refreshFast(context.Background())
	snap, _ := m.SnapshotWithVersion()
	return snap
}

func BenchmarkSnapshotJSONEncode(b *testing.B) {
	snap := primedSnapshot(b)
	var buf bytes.Buffer
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		buf.Reset()
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(snap); err != nil {
			b.Fatal(err)
		}
	}
	b.SetBytes(int64(buf.Len()))
}

func BenchmarkSnapshotJSONMarshal(b *testing.B) {
	snap := primedSnapshot(b)
	b.ResetTimer()
	b.ReportAllocs()
	var total int
	for i := 0; i < b.N; i++ {
		out, err := json.Marshal(snap)
		if err != nil {
			b.Fatal(err)
		}
		total = len(out)
	}
	b.SetBytes(int64(total))
}

// ---------------------------------------------------------------------------
// End-to-end fast tick: full cost of one 2s refresh.
// ---------------------------------------------------------------------------

func BenchmarkRefreshFast(b *testing.B) {
	m := NewManager()
	m.refreshFast(context.Background()) // prime sample state
	ctx := context.Background()
	b.ResetTimer()
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		m.refreshFast(ctx)
	}
}
