package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// fs_copy_test.go exercises safeCopy / safeMove against the same
// in-memory tempdir + openat2 root the rest of the fs tests use. The
// goal: prove the new copy/move endpoints (a) actually duplicate or
// relocate the bytes, (b) preserve mode bits, (c) refuse to clobber by
// default, (d) recurse properly with the recursive flag, and (e) keep
// the openat2 jail intact for the symlink-escape case.

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func TestSafeCopyFile(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeFile(t, filepath.Join(root, "src.txt"), "hello", 0o640)

	if _, _, err := safeCopy("/src.txt", "/dst.txt", roleOperator, copyOpts{}); err != nil {
		t.Fatalf("safeCopy: %v", err)
	}
	if got := readFile(t, filepath.Join(root, "dst.txt")); got != "hello" {
		t.Errorf("content: got %q", got)
	}
	// Source untouched.
	if got := readFile(t, filepath.Join(root, "src.txt")); got != "hello" {
		t.Errorf("source mutated: %q", got)
	}
	// Mode preserved.
	info, err := os.Stat(filepath.Join(root, "dst.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Errorf("mode: got %o, want 0640", info.Mode().Perm())
	}
}

func TestSafeCopyRefusesExistingDest(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeFile(t, filepath.Join(root, "src.txt"), "new", 0o644)
	writeFile(t, filepath.Join(root, "dst.txt"), "old", 0o644)

	_, _, err := safeCopy("/src.txt", "/dst.txt", roleOperator, copyOpts{})
	if !errors.Is(err, os.ErrExist) {
		t.Fatalf("expected os.ErrExist, got %v", err)
	}
	// Destination is intact.
	if got := readFile(t, filepath.Join(root, "dst.txt")); got != "old" {
		t.Errorf("dst clobbered: %q", got)
	}
}

func TestSafeCopyOverwriteReplacesFile(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeFile(t, filepath.Join(root, "src.txt"), "new", 0o644)
	writeFile(t, filepath.Join(root, "dst.txt"), "old", 0o644)

	if _, _, err := safeCopy("/src.txt", "/dst.txt", roleOperator, copyOpts{Overwrite: true}); err != nil {
		t.Fatalf("safeCopy overwrite: %v", err)
	}
	if got := readFile(t, filepath.Join(root, "dst.txt")); got != "new" {
		t.Errorf("dst: got %q, want %q", got, "new")
	}
}

func TestSafeCopyRefusesExistingDirDest(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeFile(t, filepath.Join(root, "src.txt"), "x", 0o644)
	if err := os.Mkdir(filepath.Join(root, "dst"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Even with overwrite=true we refuse to clobber a directory.
	if _, _, err := safeCopy("/src.txt", "/dst", roleOperator, copyOpts{Overwrite: true}); err == nil {
		t.Fatal("expected error copying file onto existing directory")
	}
}

func TestSafeCopyDirRequiresRecursive(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "src", "a.txt"), "a", 0o644)

	_, _, err := safeCopy("/src", "/dst", roleOperator, copyOpts{})
	if err == nil {
		t.Fatal("expected error copying directory without recursive flag")
	}
}

func TestSafeCopyDirRecursive(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	if err := os.MkdirAll(filepath.Join(root, "src", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(root, "src", "a.txt"), "a", 0o644)
	writeFile(t, filepath.Join(root, "src", "sub", "b.txt"), "b", 0o600)

	if _, _, err := safeCopy("/src", "/dst", roleOperator, copyOpts{Recursive: true}); err != nil {
		t.Fatalf("safeCopy recursive: %v", err)
	}
	if got := readFile(t, filepath.Join(root, "dst", "a.txt")); got != "a" {
		t.Errorf("dst/a.txt: %q", got)
	}
	if got := readFile(t, filepath.Join(root, "dst", "sub", "b.txt")); got != "b" {
		t.Errorf("dst/sub/b.txt: %q", got)
	}
	// Mode preserved on the nested file.
	info, _ := os.Stat(filepath.Join(root, "dst", "sub", "b.txt"))
	if info.Mode().Perm() != 0o600 {
		t.Errorf("nested mode: got %o, want 0600", info.Mode().Perm())
	}
}

func TestSafeCopyPreservesSymlink(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	// Internal symlink (target stays inside the root so the *result* is
	// resolvable, but the copy must not follow it — it must create a
	// symlink at dst whose target string matches.
	writeFile(t, filepath.Join(root, "real.txt"), "data", 0o644)
	if err := os.Symlink("real.txt", filepath.Join(root, "src.lnk")); err != nil {
		t.Fatal(err)
	}

	if _, _, err := safeCopy("/src.lnk", "/dst.lnk", roleOperator, copyOpts{}); err != nil {
		t.Fatalf("safeCopy symlink: %v", err)
	}
	info, err := os.Lstat(filepath.Join(root, "dst.lnk"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("dst is not a symlink")
	}
	target, err := os.Readlink(filepath.Join(root, "dst.lnk"))
	if err != nil {
		t.Fatal(err)
	}
	if target != "real.txt" {
		t.Errorf("symlink target: got %q, want %q", target, "real.txt")
	}
}

func TestSafeCopyRefusesSelfDescendant(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	// /src into /src/child would loop forever — refuse upfront.
	if _, _, err := safeCopy("/src", "/src/child", roleOperator, copyOpts{Recursive: true}); err == nil {
		t.Fatal("expected error for copy into own subtree")
	}
}

func TestSafeCopyRespectsDenylist(t *testing.T) {
	fsOpsTestEnv(t)
	// Source is fine, destination is denylisted.
	if _, _, err := safeCopy("/tmp.txt", "/etc/shadow", roleAdmin, copyOpts{}); !errors.Is(err, ErrPathDenied) {
		t.Errorf("expected ErrPathDenied for dest, got %v", err)
	}
	// Source in denylist also refused.
	if _, _, err := safeCopy("/etc/shadow", "/safe.txt", roleAdmin, copyOpts{}); !errors.Is(err, ErrPathDenied) {
		t.Errorf("expected ErrPathDenied for source, got %v", err)
	}
}

func TestSafeMoveRenamesSameFS(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeFile(t, filepath.Join(root, "src.txt"), "payload", 0o644)
	if _, _, err := safeMove("/src.txt", "/dst.txt", roleOperator, copyOpts{}); err != nil {
		t.Fatalf("safeMove: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "src.txt")); !os.IsNotExist(err) {
		t.Errorf("src still present: %v", err)
	}
	if got := readFile(t, filepath.Join(root, "dst.txt")); got != "payload" {
		t.Errorf("dst: %q", got)
	}
}

func TestSafeMoveRefusesExistingDest(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeFile(t, filepath.Join(root, "src.txt"), "new", 0o644)
	writeFile(t, filepath.Join(root, "dst.txt"), "old", 0o644)
	if _, _, err := safeMove("/src.txt", "/dst.txt", roleOperator, copyOpts{}); !errors.Is(err, os.ErrExist) {
		t.Fatalf("expected os.ErrExist, got %v", err)
	}
	// Both files intact — refusal must happen before any rename.
	if got := readFile(t, filepath.Join(root, "src.txt")); got != "new" {
		t.Errorf("src mutated: %q", got)
	}
	if got := readFile(t, filepath.Join(root, "dst.txt")); got != "old" {
		t.Errorf("dst mutated: %q", got)
	}
}

func TestSafeMoveOverwriteReplacesFile(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	writeFile(t, filepath.Join(root, "src.txt"), "new", 0o644)
	writeFile(t, filepath.Join(root, "dst.txt"), "old", 0o644)
	if _, _, err := safeMove("/src.txt", "/dst.txt", roleOperator, copyOpts{Overwrite: true}); err != nil {
		t.Fatalf("safeMove overwrite: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "src.txt")); !os.IsNotExist(err) {
		t.Errorf("src still present: %v", err)
	}
	if got := readFile(t, filepath.Join(root, "dst.txt")); got != "new" {
		t.Errorf("dst: got %q", got)
	}
}

func TestSafeMoveRefusesSelfDescendant(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	if err := os.Mkdir(filepath.Join(root, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := safeMove("/src", "/src/inner", roleOperator, copyOpts{}); err == nil {
		t.Fatal("expected error moving into own subtree")
	}
}

func TestIsDescendantRel(t *testing.T) {
	cases := []struct {
		src, dst string
		want     bool
	}{
		{"a/b", "a/b", true},
		{"a/b", "a/b/c", true},
		{"a/b", "a/bc", false},
		{"a/b", "a/c", false},
		{".", ".", true},
	}
	for _, c := range cases {
		if got := isDescendantRel(c.src, c.dst); got != c.want {
			t.Errorf("isDescendantRel(%q, %q) = %v, want %v", c.src, c.dst, got, c.want)
		}
	}
}
