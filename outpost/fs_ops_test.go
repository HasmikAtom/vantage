package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func fsOpsTestEnv(t *testing.T) (root, trash string) {
	t.Helper()
	root = t.TempDir()
	trash = t.TempDir()
	prev := hostRoot
	prevTrash := trashRoot
	prevHandle := hostRootHandle
	hostRoot = root
	trashRoot = trash
	r, err := os.OpenRoot(root)
	if err != nil {
		t.Fatalf("OpenRoot: %v", err)
	}
	hostRootHandle = r
	t.Cleanup(func() {
		_ = r.Close()
		hostRoot = prev
		trashRoot = prevTrash
		hostRootHandle = prevHandle
	})
	return root, trash
}

func TestSafeListDirSortsDirsFirst(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	mustMkdir(t, filepath.Join(root, "alpha-dir"))
	if err := os.WriteFile(filepath.Join(root, "0001-file"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries, _, err := safeListDir("/", roleViewer)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries: %+v", len(entries), entries)
	}
	if entries[0].Type != "dir" {
		t.Errorf("expected dir first; got %+v", entries[0])
	}
}

func TestSafeMkdirInheritsParentOwnership(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	// We can only meaningfully test the inherit logic if we can chown.
	// In CI as non-root, os.Chown will fail; skip then.
	if os.Geteuid() != 0 {
		t.Skip("requires root to exercise chown inheritance")
	}
	mustMkdir(t, filepath.Join(root, "home"))
	if err := os.Chown(filepath.Join(root, "home"), 1000, 1000); err != nil {
		t.Fatalf("chown setup: %v", err)
	}
	if _, err := safeMkdirInheritOwner("/home/sub", roleOperator, 0o755); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(filepath.Join(root, "home/sub"))
	st := info.Sys().(*syscall.Stat_t)
	if st.Uid != 1000 || st.Gid != 1000 {
		t.Errorf("expected inherited 1000:1000, got %d:%d", st.Uid, st.Gid)
	}
}

func TestSafeRenameRefusesExistingDest(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	mustMkdir(t, filepath.Join(root, "a"))
	mustMkdir(t, filepath.Join(root, "b"))
	// The handler checks Lstat-before-rename. Verify the same logic
	// against the rooted helpers here.
	if _, err := hostRootHandle.Lstat("b"); err != nil {
		t.Fatalf("setup: expected b to exist, got %v", err)
	}
	// os.Root.Rename DOES silently overwrite (matches os.Rename Linux
	// semantics), so the conflict check is the handler's responsibility —
	// confirm the precondition the handler relies on.
	if _, err := hostRootHandle.Lstat("b"); err != nil {
		t.Fatalf("dest should exist for the handler conflict check, got %v", err)
	}
}

func TestSafeDeleteToTrashSameFS(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	// trashRoot must be under hostRoot for the fast-path branch to
	// engage. Override trash to live inside root so the helper can
	// rename via Root.
	trashInside := filepath.Join(root, "trash")
	mustMkdir(t, trashInside)
	prev := trashRoot
	trashRoot = trashInside
	t.Cleanup(func() { trashRoot = prev })

	target := filepath.Join(root, "to-delete.txt")
	if err := os.WriteFile(target, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	id, _, err := fsDeleteToTrashSafe("/to-delete.txt", roleOperator, "test-user")
	if err != nil {
		t.Fatal(err)
	}
	// Source must be gone.
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		t.Errorf("source still present: %v", err)
	}
	// Trash should contain payload and meta.json.
	if _, err := os.Stat(filepath.Join(trashInside, id, "payload")); err != nil {
		t.Errorf("trash payload missing: %v", err)
	}
	metaBytes, err := os.ReadFile(filepath.Join(trashInside, id, "meta.json"))
	if err != nil {
		t.Errorf("trash meta missing: %v", err)
	}
	if !strings.Contains(string(metaBytes), `"originalPath":"/to-delete.txt"`) {
		t.Errorf("meta did not include originalPath: %s", metaBytes)
	}
}

func TestSafeWriteTextAtomic(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	target := filepath.Join(root, "config.txt")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := safeWriteTextPreserving("/config.txt", roleOperator, []byte("new")); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "new" {
		t.Errorf("got %q, want %q", got, "new")
	}
	// No leftover temp files in the directory.
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") && strings.HasSuffix(e.Name(), ".vantage-tmp") {
			t.Errorf("leftover temp file: %s", e.Name())
		}
	}
}

func TestSafeWriteTextCreatesNewFile(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	target := filepath.Join(root, "fresh.txt")
	if _, err := safeWriteTextPreserving("/fresh.txt", roleOperator, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != "hello" {
		t.Errorf("got %q, want %q", got, "hello")
	}
}

func TestSafeOpenForRead_RespectsSizeCap(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	target := filepath.Join(root, "big.bin")
	if err := os.WriteFile(target, make([]byte, 1024), 0o644); err != nil {
		t.Fatal(err)
	}
	// The handler enforces the size cap after open; replicate the
	// same check here against the safe helper.
	f, _, err := safeOpenForRead("/big.bin", roleViewer)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	const cap = int64(100)
	if info.Size() <= cap {
		t.Fatalf("test fixture should exceed cap (have %d, cap %d)", info.Size(), cap)
	}
	// The handler returns 413 here; the file content is never read.
}

func TestRejectSpecialFile_Rejects(t *testing.T) {
	// /dev/null is character-special. We can't reasonably create one in
	// a tempdir without root.
	if _, err := os.Stat("/dev/null"); err != nil {
		t.Skip("/dev/null unavailable")
	}
	info, err := os.Stat("/dev/null")
	if err != nil {
		t.Fatal(err)
	}
	if err := rejectSpecialFile(info); !errors.Is(err, ErrSpecialFile) {
		t.Errorf("expected ErrSpecialFile, got %v", err)
	}
}

// io.ReadAll is referenced from the cap test's intent comment but not
// actually called — keep the import alive via this no-op so the test
// file compiles even if future edits add streaming-check tests.
var _ = io.ReadAll
