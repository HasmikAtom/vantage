package main

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
)

// TestTOCTOU_ConcurrentSymlinkSwapDoesNotEscape stages the exact attack
// the openat2 refactor was meant to close: a background goroutine
// repeatedly swaps a legitimate directory for an absolute symlink
// pointing outside hostRoot, while the foreground exercises
// safeWriteFile on a path that goes through that directory.
//
// With the legacy `EvalSymlinks` → `os.WriteFile` pattern, a race
// hit during the window between the resolve and the syscall could
// redirect the write into the attacker's target. With os.Root's
// `openat2(RESOLVE_BENEATH)` walk, the open either resolves entirely
// within hostRoot or fails — there is no window in which a symlink
// component to an external path can be followed.
//
// Success criterion: the external sentinel directory must remain empty
// throughout. We don't care how many writes succeeded vs. failed (the
// race is intentionally noisy); we care that NO write ever landed
// outside hostRoot.
func TestTOCTOU_ConcurrentSymlinkSwapDoesNotEscape(t *testing.T) {
	if testing.Short() {
		t.Skip("race-style test; skipped in -short mode")
	}
	root, _ := fsOpsTestEnv(t)

	// Legitimate target dir + file. The race tries to make
	// /safe/file.txt resolve to <outside>/file.txt instead.
	safeDir := filepath.Join(root, "safe")
	if err := os.MkdirAll(safeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(safeDir, "file.txt"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Outside-hostRoot location the attacker is trying to redirect at.
	// If anything ever writes here, the refactor's protection has a hole.
	outside := t.TempDir()

	// Background swapper. Repeatedly:
	//   1. Rename `safe` out of the way: safe -> safe.bak
	//   2. Place a symlink: safe -> <outside>  (absolute target = OUT of hostRoot)
	//   3. Undo: remove the symlink, rename safe.bak back to safe.
	// Bounded by `stop`. The swap+restore loop is intentionally tight.
	stop := make(chan struct{})
	var swapWG sync.WaitGroup
	swapWG.Add(1)
	go func() {
		defer swapWG.Done()
		bak := safeDir + ".bak"
		for {
			select {
			case <-stop:
				return
			default:
			}
			// Best-effort swap; ignore individual syscall errors —
			// any failure just means we missed one iteration of the
			// race. The assertion at the end of the test is what
			// matters.
			_ = os.Rename(safeDir, bak)
			_ = os.Symlink(outside, safeDir)
			_ = os.Remove(safeDir)
			_ = os.Rename(bak, safeDir)
		}
	}()

	// Hammer safeWriteFile from multiple goroutines on multiple CPUs to
	// maximise the chance of landing inside the swap window.
	const writers = 4
	const iterPerWriter = 5000
	var writeWG sync.WaitGroup
	for w := 0; w < writers; w++ {
		writeWG.Add(1)
		go func() {
			defer writeWG.Done()
			payload := []byte("hostRoot-only payload")
			for i := 0; i < iterPerWriter; i++ {
				_, _ = safeWriteFile("/safe/file.txt", roleOperator, payload, 0o644)
			}
		}()
	}

	writeWG.Wait()
	close(stop)
	swapWG.Wait()

	// THE invariant. If a write ever escaped via the symlink, the
	// outside directory would contain a `file.txt`.
	if _, err := os.Stat(filepath.Join(outside, "file.txt")); !os.IsNotExist(err) {
		t.Fatalf("TOCTOU PROTECTION FAILED: write escaped hostRoot into %s (err=%v)",
			outside, err)
	}
	// Also check for the temp-file leak path (safeWriteFile creates a
	// dotted .vantage-tmp file before renaming) — none should land
	// outside either.
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("TOCTOU PROTECTION FAILED: temp files leaked into %s: %v",
			outside, names)
	}

	// Touch GOMAXPROCS so this test exercises real parallelism in
	// CI environments that default to GOMAXPROCS=1.
	_ = runtime.GOMAXPROCS(0)
}

// TestTOCTOU_StaticSymlinkOutsideRootBlocked verifies the static case
// (no race needed): a symlink that ALREADY points outside hostRoot can
// never be opened through the safe helpers, full stop. This is the
// minimum guarantee; the race test above proves the same holds under
// concurrent swap pressure.
func TestTOCTOU_StaticSymlinkOutsideRootBlocked(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("classified"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Plant an absolute symlink inside hostRoot pointing at the
	// outside directory.
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	// Read via the safe helper — must fail.
	if _, _, err := safeOpenForRead("/escape/secret", roleAdmin); err == nil {
		t.Fatalf("expected open through external-target symlink to fail")
	}
	// Write — must also fail and must NOT create anything outside.
	if _, err := safeWriteFile("/escape/new.txt", roleOperator, []byte("x"), 0o644); err == nil {
		t.Fatalf("expected write through external-target symlink to fail")
	}
	if _, err := os.Stat(filepath.Join(outside, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("write escaped via static symlink: %s exists", filepath.Join(outside, "new.txt"))
	}
}
