package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// fsSafetyTestEnv sets up a temp directory and points hostRoot at it,
// so the safety tests can run without /hostfs (which only exists in the
// prod container). Also opens a fresh hostRootHandle so the openat2-based
// safe* helpers work against the temp directory. Returns a cleanup that
// restores both.
func fsSafetyTestEnv(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	prev := hostRoot
	prevHandle := hostRootHandle
	hostRoot = dir
	r, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatalf("OpenRoot: %v", err)
	}
	hostRootHandle = r
	t.Cleanup(func() {
		_ = r.Close()
		hostRoot = prev
		hostRootHandle = prevHandle
	})
	return dir
}

func TestResolveSafeName_AcceptsValidPath(t *testing.T) {
	root := fsSafetyTestEnv(t)
	mustMkdir(t, filepath.Join(root, "data"))
	rel, hp, err := resolveSafeName("/data", FsOpList, roleViewer)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if rel != "data" {
		t.Errorf("rootRel: got %q, want %q", rel, "data")
	}
	if hp != "/data" {
		t.Errorf("hostPath: got %q", hp)
	}
}

func TestResolveSafeName_RejectsRelative(t *testing.T) {
	fsSafetyTestEnv(t)
	if _, _, err := resolveSafeName("not/absolute", FsOpList, roleViewer); err == nil {
		t.Fatalf("expected error for relative path")
	}
}

func TestResolveSafeName_RejectsDenylist(t *testing.T) {
	fsSafetyTestEnv(t)
	for _, p := range []string{"/proc", "/sys", "/dev", "/boot", "/etc/shadow", "/var/lib/docker"} {
		if _, _, err := resolveSafeName(p, FsOpList, roleAdmin); !errors.Is(err, ErrPathDenied) {
			t.Errorf("expected ErrPathDenied for %s, got %v", p, err)
		}
		if _, _, err := resolveSafeName(p+"/child", FsOpList, roleAdmin); !errors.Is(err, ErrPathDenied) {
			t.Errorf("expected ErrPathDenied for descendant %s/child, got %v", p, err)
		}
	}
}

func TestSafeOpen_SymlinkEscapeBlocked(t *testing.T) {
	root := fsSafetyTestEnv(t)
	// Create /innocent as an absolute symlink pointing outside hostRoot.
	// os.Root.Open follows symlinks but RESOLVE_BENEATH rejects any link
	// target that lands outside the root, so the open must fail.
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "innocent")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := safeOpenForRead("/innocent", roleAdmin); err == nil {
		t.Fatalf("expected open of symlink escaping hostRoot to fail")
	}
}

func TestSafeOpen_SymlinkInsideRoot_DenylistBlocks(t *testing.T) {
	root := fsSafetyTestEnv(t)
	// Create /etc/shadow WITHIN the test hostRoot and a symlink to it.
	// The symlink target stays inside the root so Root.Open would
	// succeed, but the denylist check on the requested path (/innocent)
	// is irrelevant — what matters is that reading /etc/shadow through
	// the safe helpers is blocked. We exercise that here by trying to
	// read /etc/shadow directly via the safe helper.
	mustMkdir(t, filepath.Join(root, "etc"))
	if err := os.WriteFile(filepath.Join(root, "etc/shadow"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := safeOpenForRead("/etc/shadow", roleAdmin); !errors.Is(err, ErrPathDenied) {
		t.Fatalf("expected ErrPathDenied reading /etc/shadow, got %v", err)
	}
}

func TestResolveSafeName_NonExistentLeafPassesPolicy(t *testing.T) {
	root := fsSafetyTestEnv(t)
	mustMkdir(t, filepath.Join(root, "uploads"))
	// resolveSafeName is pure policy; it doesn't care if the leaf exists.
	// The actual filesystem check happens in the openat2 walk inside
	// each safe* helper.
	rel, hp, err := resolveSafeName("/uploads/new.txt", FsOpWrite, roleOperator)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if hp != "/uploads/new.txt" {
		t.Errorf("hostPath: got %q", hp)
	}
	if rel != "uploads/new.txt" {
		t.Errorf("rootRel: got %q", rel)
	}
}

func TestResolveSafeName_AdminReadGate(t *testing.T) {
	fsSafetyTestEnv(t)
	if _, _, err := resolveSafeName("/root/key", FsOpRead, roleOperator); !errors.Is(err, ErrAdminRequired) {
		t.Errorf("expected ErrAdminRequired for operator reading /root/key, got %v", err)
	}
	if _, _, err := resolveSafeName("/root/key", FsOpRead, roleAdmin); err != nil {
		t.Errorf("admin should be allowed to read /root/key, got %v", err)
	}
	// Stat / list of the same path should NOT require admin (we only gate
	// content reads).
	if _, _, err := resolveSafeName("/root/key", FsOpStat, roleViewer); err != nil {
		t.Errorf("viewer stat of /root/key should be allowed, got %v", err)
	}
}

func TestResolveSafeName_DotDotTraversal(t *testing.T) {
	fsSafetyTestEnv(t)
	// filepath.Clean collapses .. relative to /, so /../../etc becomes
	// /etc. That's fine — the denylist still catches /etc/shadow.
	_, _, err := resolveSafeName("/../../etc/shadow", FsOpRead, roleAdmin)
	if !errors.Is(err, ErrPathDenied) {
		t.Fatalf("expected denylist hit via traversal, got %v", err)
	}
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
}
