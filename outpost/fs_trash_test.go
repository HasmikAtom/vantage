package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// trashUnderHostRoot points trashRoot at a subdirectory of hostRoot so
// the fast-path (rename via Root) is exercised in tests. Returns the
// trash dir path.
func trashUnderHostRoot(t *testing.T, root string) string {
	t.Helper()
	trashInside := filepath.Join(root, "trash")
	mustMkdir(t, trashInside)
	prev := trashRoot
	trashRoot = trashInside
	t.Cleanup(func() { trashRoot = prev })
	return trashInside
}

func TestListTrashAndRestore(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	trashUnderHostRoot(t, root)
	// Set up a file, delete it through the dashboard pipeline, then
	// list trash and restore it.
	src := filepath.Join(root, "doc.txt")
	if err := os.WriteFile(src, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	id, _, err := fsDeleteToTrashSafe("/doc.txt", roleOperator, "tester")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(src); !os.IsNotExist(err) {
		t.Fatalf("source still present: %v", err)
	}

	items, err := listTrash()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("got %d trash items, want 1", len(items))
	}
	if items[0].ID != id || items[0].OriginalPath != "/doc.txt" || items[0].DeletedBy != "tester" {
		t.Errorf("unexpected item: %+v", items[0])
	}

	dst, err := restoreTrash(id, false, roleOperator)
	if err != nil {
		t.Fatal(err)
	}
	if dst != "/doc.txt" {
		t.Errorf("restored to %q, want /doc.txt", dst)
	}
	content, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "hello" {
		t.Errorf("content corrupt: %q", content)
	}
	// Trash entry must be cleaned up.
	items, _ = listTrash()
	if len(items) != 0 {
		t.Errorf("trash not cleared after restore: %d items", len(items))
	}
}

func TestRestoreConflictRespected(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	trashUnderHostRoot(t, root)
	src := filepath.Join(root, "f.txt")
	if err := os.WriteFile(src, []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	id, _, err := fsDeleteToTrashSafe("/f.txt", roleOperator, "")
	if err != nil {
		t.Fatal(err)
	}
	// Recreate a colliding file at the original path.
	if err := os.WriteFile(src, []byte("b"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := restoreTrash(id, false, roleOperator); err == nil {
		t.Fatalf("expected conflict error")
	}
	// With overwrite=true, the existing file is replaced by the restored payload.
	if _, err := restoreTrash(id, true, roleOperator); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(src)
	if string(got) != "a" {
		t.Errorf("overwrite restore content: %q, want %q", got, "a")
	}
}

func TestSweepRemovesOldEntries(t *testing.T) {
	root, _ := fsOpsTestEnv(t)
	trashUnderHostRoot(t, root)
	src := filepath.Join(root, "old.txt")
	if err := os.WriteFile(src, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	id, _, err := fsDeleteToTrashSafe("/old.txt", roleOperator, "")
	if err != nil {
		t.Fatal(err)
	}
	// Rewrite meta.json with a deletedAt far enough in the past that
	// any sub-second-precision ttl will trip on it.
	metaPath := filepath.Join(trashRoot, id, "meta.json")
	b := []byte(`{"originalPath":"/old.txt","deletedAt":` +
		formatI64(time.Now().Add(-10*time.Hour).Unix()) + `,"deletedBy":""}`)
	if err := os.WriteFile(metaPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	sweepTrash(time.Hour)
	if _, err := os.Stat(filepath.Join(trashRoot, id)); !os.IsNotExist(err) {
		t.Fatalf("expected trash entry %s to be swept; err=%v", id, err)
	}
}

func formatI64(n int64) string {
	// Avoid importing strconv into the test file for one number.
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func TestParseModeAccepts(t *testing.T) {
	cases := []struct {
		in   string
		want uint32
	}{
		{`"0755"`, 0o755},
		{`"755"`, 0o755},
		{`"0o644"`, 0o644},
		{`493`, 493}, // JSON number; 493 == 0o755
	}
	for _, c := range cases {
		got, err := parseMode([]byte(c.in))
		if err != nil {
			t.Errorf("%s: err %v", c.in, err)
			continue
		}
		if uint32(got) != c.want {
			t.Errorf("%s: got %#o want %#o", c.in, got, c.want)
		}
	}
	if _, err := parseMode([]byte(`"oops"`)); err == nil {
		t.Errorf("expected error for non-numeric mode")
	}
}
