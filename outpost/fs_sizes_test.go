package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeSized(t *testing.T, path string, n int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, n), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestWalkDirSize_SumsFilesRecursively(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeSized(t, filepath.Join(root, "data/a.bin"), 100)
	writeSized(t, filepath.Join(root, "data/sub/b.bin"), 50)
	writeSized(t, filepath.Join(root, "data/sub/deeper/c.bin"), 7)

	res, err := walkDirSize(context.Background(), "/data", defaultSizeLimits)
	if err != nil {
		t.Fatal(err)
	}
	if res.Path != "/data" || res.Bytes != 157 || res.Files != 3 || res.Partial {
		t.Fatalf("got %+v, want /data 157 bytes 3 files complete", res)
	}
}

func TestWalkDirSize_HardLinkCountedOnce(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeSized(t, filepath.Join(root, "d/a.bin"), 40)
	if err := os.Link(filepath.Join(root, "d/a.bin"), filepath.Join(root, "d/b.bin")); err != nil {
		t.Fatal(err)
	}
	res, err := walkDirSize(context.Background(), "/d", defaultSizeLimits)
	if err != nil {
		t.Fatal(err)
	}
	if res.Bytes != 40 || res.Files != 1 {
		t.Fatalf("got %+v, want 40 bytes 1 file", res)
	}
}

func TestWalkDirSize_SymlinksNotFollowed(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeSized(t, filepath.Join(root, "d/a.bin"), 10)
	writeSized(t, filepath.Join(root, "big/huge.bin"), 1000)
	if err := os.Symlink(".", filepath.Join(root, "d/loop")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../big", filepath.Join(root, "d/tobig")); err != nil {
		t.Fatal(err)
	}
	res, err := walkDirSize(context.Background(), "/d", defaultSizeLimits)
	if err != nil {
		t.Fatal(err)
	}
	if res.Bytes != 10 || res.Files != 1 {
		t.Fatalf("got %+v, want 10 bytes 1 file", res)
	}
}

func TestWalkDirSize_SkipsOtherFilesystems(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeSized(t, filepath.Join(root, "d/a.bin"), 10)
	writeSized(t, filepath.Join(root, "d/othermount/x.bin"), 999)
	prev := statIDs
	statIDs = func(fi os.FileInfo) (uint64, uint64, uint64, bool) {
		dev, ino, nlink, ok := prev(fi)
		if fi.Name() == "othermount" {
			dev++
		}
		return dev, ino, nlink, ok
	}
	t.Cleanup(func() { statIDs = prev })

	res, err := walkDirSize(context.Background(), "/d", defaultSizeLimits)
	if err != nil {
		t.Fatal(err)
	}
	if res.Bytes != 10 {
		t.Fatalf("got %d bytes, want 10 (othermount must be skipped)", res.Bytes)
	}
}

func TestWalkDirSize_SkipsDenylistedChildren(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeSized(t, filepath.Join(root, "etc/hosts"), 5)
	writeSized(t, filepath.Join(root, "proc/kcore"), 5000)
	res, err := walkDirSize(context.Background(), "/", defaultSizeLimits)
	if err != nil {
		t.Fatal(err)
	}
	if res.Bytes != 5 {
		t.Fatalf("got %d bytes, want 5 (/proc must be skipped)", res.Bytes)
	}
}

func TestWalkDirSize_EntryCapMarksPartial(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	for i := 0; i < 10; i++ {
		writeSized(t, filepath.Join(root, "d", "f"+string(rune('a'+i))), 1)
	}
	res, err := walkDirSize(context.Background(), "/d", sizeLimits{MaxDuration: time.Minute, MaxEntries: 3})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Partial || res.Files != 3 {
		t.Fatalf("got %+v, want partial with 3 files", res)
	}
}

func TestWalkDirSize_TimeCapMarksPartial(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeSized(t, filepath.Join(root, "d/a.bin"), 1)
	res, err := walkDirSize(context.Background(), "/d", sizeLimits{MaxDuration: -time.Second, MaxEntries: 100})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Partial {
		t.Fatalf("got %+v, want partial", res)
	}
}

func TestWalkDirSize_CancelledContext(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeSized(t, filepath.Join(root, "d/a.bin"), 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := walkDirSize(ctx, "/d", defaultSizeLimits)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestWalkDirSize_RejectsFile(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeSized(t, filepath.Join(root, "f.bin"), 1)
	if _, err := walkDirSize(context.Background(), "/f.bin", defaultSizeLimits); err == nil {
		t.Fatal("want error for a regular file")
	}
}

func resetSizeCache(t *testing.T) {
	t.Helper()
	prev := dirSizeCache
	dirSizeCache = newSizeCache(5*time.Minute, 5000)
	t.Cleanup(func() { dirSizeCache = prev })
}

func TestSizeCache_TTLAndLRU(t *testing.T) {
	c := newSizeCache(time.Minute, 2)
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }
	c.put(dirSizeResult{Path: "/a", Bytes: 1})
	c.put(dirSizeResult{Path: "/b", Bytes: 2})
	if _, ok := c.get("/a"); !ok { // touches /a → /b is now oldest
		t.Fatal("want /a cached")
	}
	c.put(dirSizeResult{Path: "/c", Bytes: 3})
	if _, ok := c.get("/b"); ok {
		t.Fatal("/b should have been evicted (LRU)")
	}
	now = now.Add(2 * time.Minute)
	if _, ok := c.get("/a"); ok {
		t.Fatal("/a should have expired (TTL)")
	}
	c.clear()
	if c.len() != 0 {
		t.Fatalf("len after clear = %d", c.len())
	}
}

type sseEvent struct {
	name string
	data string
}

func parseSSE(body string) []sseEvent {
	var out []sseEvent
	for _, block := range strings.Split(body, "\n\n") {
		var ev sseEvent
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "event: "):
				ev.name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.data = strings.TrimPrefix(line, "data: ")
			}
		}
		if ev.data != "" || ev.name != "" {
			out = append(out, ev)
		}
	}
	return out
}

func TestFsSizesHandler_StreamsEachSubfolderThenDone(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	resetSizeCache(t)
	writeSized(t, filepath.Join(root, "top/a/x.bin"), 10)
	writeSized(t, filepath.Join(root, "top/b/y.bin"), 5)
	writeSized(t, filepath.Join(root, "top/c.txt"), 3)

	req := httptest.NewRequest(http.MethodGet, "/fs/sizes?path=/top", nil)
	req.Header.Set(roleHeader, roleViewer)
	rec := httptest.NewRecorder()
	fsSizesHandler()(rec, req)

	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type = %q", ct)
	}
	evs := parseSSE(rec.Body.String())
	if len(evs) != 3 || evs[2].name != "done" {
		t.Fatalf("events = %+v, want 2 data + done", evs)
	}
	got := map[string]int64{}
	for _, ev := range evs[:2] {
		var r dirSizeResult
		if err := json.Unmarshal([]byte(ev.data), &r); err != nil {
			t.Fatal(err)
		}
		got[r.Path] = r.Bytes
	}
	if got["/top/a"] != 10 || got["/top/b"] != 5 {
		t.Fatalf("sizes = %v", got)
	}
	if _, ok := dirSizeCache.get("/top/a"); !ok {
		t.Fatal("result should be cached")
	}
}

func TestFsSizesHandler_ServesCachedWithoutWalking(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	resetSizeCache(t)
	writeSized(t, filepath.Join(root, "top/a/x.bin"), 10)
	dirSizeCache.put(dirSizeResult{Path: "/top/a", Bytes: 777, Files: 1})

	req := httptest.NewRequest(http.MethodGet, "/fs/sizes?path=/top", nil)
	rec := httptest.NewRecorder()
	fsSizesHandler()(rec, req)

	evs := parseSSE(rec.Body.String())
	if len(evs) != 2 || !strings.Contains(evs[0].data, `"bytes":777`) {
		t.Fatalf("events = %+v, want cached 777 then done", evs)
	}
}

func TestFsSizesHandler_OmitsDenylistedChildren(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	resetSizeCache(t)
	writeSized(t, filepath.Join(root, "etc/hosts"), 5)
	writeSized(t, filepath.Join(root, "proc/kcore"), 5000)

	req := httptest.NewRequest(http.MethodGet, "/fs/sizes?path=/", nil)
	rec := httptest.NewRecorder()
	fsSizesHandler()(rec, req)

	body := rec.Body.String()
	if strings.Contains(body, `"/proc"`) {
		t.Fatalf("denylisted /proc must not be emitted: %s", body)
	}
	if !strings.Contains(body, `"/etc"`) {
		t.Fatalf("want /etc emitted: %s", body)
	}
}

func TestFsSizesHandler_CancelledRequestReturns(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	resetSizeCache(t)
	writeSized(t, filepath.Join(root, "top/a/x.bin"), 10)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest(http.MethodGet, "/fs/sizes?path=/top", nil).WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { fsSizesHandler()(rec, req); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("handler did not return after client cancel")
	}
	if strings.Contains(rec.Body.String(), "event: done") {
		t.Fatal("cancelled stream must not send done")
	}
}

func TestFsSizesHandler_MissingPath(t *testing.T) {
	fsOpsTestEnv(t)
	rec := httptest.NewRecorder()
	fsSizesHandler()(rec, httptest.NewRequest(http.MethodGet, "/fs/sizes", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}

func TestInvalidatesSizes_ClearsOnlyOnSuccess(t *testing.T) {
	resetSizeCache(t)
	ok := invalidatesSizes(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]bool{"ok": true}) })
	conflict := invalidatesSizes(func(w http.ResponseWriter, r *http.Request) { writeErr(w, http.StatusConflict, "exists") })

	dirSizeCache.put(dirSizeResult{Path: "/a"})
	conflict(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/fs/move", nil))
	if dirSizeCache.len() != 1 {
		t.Fatal("failed mutation must not clear the cache")
	}
	ok(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/fs/move", nil))
	if dirSizeCache.len() != 0 {
		t.Fatal("successful mutation must clear the cache")
	}
}
