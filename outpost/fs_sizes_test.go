package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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
