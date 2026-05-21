package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// TrashItem is one entry in the trash listing. The `id` is the trash dir
// name (the unix-millis-hex form newTrashID produces); the original path
// and deletion metadata come from meta.json.
type TrashItem struct {
	ID           string `json:"id"`
	OriginalPath string `json:"originalPath"`
	Type         string `json:"type"`            // dir|file|symlink|other
	Size         int64  `json:"size"`
	DeletedAt    int64  `json:"deletedAt"`       // unix seconds
	DeletedBy    string `json:"deletedBy,omitempty"`
}

// trashMeta mirrors what fsDeleteToTrash writes; we keep the on-disk
// format minimal so future versions can add fields without breaking
// older records.
type trashMeta struct {
	OriginalPath string `json:"originalPath"`
	DeletedAt    int64  `json:"deletedAt"`
	DeletedBy    string `json:"deletedBy"`
}

// listTrash reads every entry under trashRoot. Bad/half-written entries
// (missing meta, missing payload) are skipped silently — the sweep will
// clean them up eventually.
func listTrash() ([]TrashItem, error) {
	dir, err := os.Open(trashRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return []TrashItem{}, nil
		}
		return nil, err
	}
	defer dir.Close()
	names, err := dir.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	out := make([]TrashItem, 0, len(names))
	for _, name := range names {
		meta, err := readTrashMeta(filepath.Join(trashRoot, name))
		if err != nil {
			continue
		}
		payload := filepath.Join(trashRoot, name, "payload")
		info, err := os.Lstat(payload)
		if err != nil {
			continue
		}
		typ := "other"
		switch {
		case info.Mode().IsDir():
			typ = "dir"
		case info.Mode()&os.ModeSymlink != 0:
			typ = "symlink"
		case info.Mode().IsRegular():
			typ = "file"
		}
		size := info.Size()
		// For directories the on-disk size is just the dir entry itself;
		// users expect total bytes. Walk the tree, swallowing per-file
		// errors so a permission-denied child doesn't break the count.
		if typ == "dir" {
			size = 0
			_ = filepath.Walk(payload, func(_ string, fi os.FileInfo, walkErr error) error {
				if walkErr != nil {
					return nil
				}
				if fi.Mode().IsRegular() {
					size += fi.Size()
				}
				return nil
			})
		}
		out = append(out, TrashItem{
			ID:           name,
			OriginalPath: meta.OriginalPath,
			Type:         typ,
			Size:         size,
			DeletedAt:    meta.DeletedAt,
			DeletedBy:    meta.DeletedBy,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeletedAt > out[j].DeletedAt })
	return out, nil
}

func readTrashMeta(entryDir string) (trashMeta, error) {
	b, err := os.ReadFile(filepath.Join(entryDir, "meta.json"))
	if err != nil {
		return trashMeta{}, err
	}
	var m trashMeta
	if err := json.Unmarshal(b, &m); err != nil {
		return trashMeta{}, err
	}
	if m.OriginalPath == "" {
		return trashMeta{}, fmt.Errorf("trash meta missing originalPath")
	}
	return m, nil
}

// ErrTrashRestoreConflict is returned by restoreTrash when the original
// path is already occupied. Callers can pass overwrite=true to clobber.
var ErrTrashRestoreConflict = errors.New("destination already exists; pass overwrite=true to replace")

// restoreTrash moves a trash entry's payload back to its original path.
// The destination goes through the openat2-anchored helpers so the
// restore can't slip content into a denylisted location (e.g. someone
// deleted /etc/passwd's twin from outside the dashboard and tried to
// put it back through us) AND a symlink swap on a parent dir can't
// redirect the final placement mid-operation.
//
// Fast path: when trashRoot lives under hostRoot (the default) we can
// express both source and destination as Root-relative paths and use
// hostRootHandle.Rename, which is atomic. Slow path: when
// VANTAGE_TRASH_DIR points outside hostRoot the rename can't go
// through the same Root, so we copy the payload via Root (TOCTOU-safe
// destination) and then unlink the original trash payload. Atomicity
// is lost on the slow path; a crash mid-restore leaves a partial
// destination and the trash sweep cleans up the stale entry later.
func restoreTrash(id string, overwrite bool, role string) (hostPath string, err error) {
	if strings.ContainsAny(id, "/\\\x00") {
		return "", fmt.Errorf("invalid trash id")
	}
	entryDir := filepath.Join(trashRoot, id)
	meta, err := readTrashMeta(entryDir)
	if err != nil {
		return "", err
	}
	payload := filepath.Join(entryDir, "payload")
	if _, err := os.Lstat(payload); err != nil {
		return "", err
	}

	dstRel, dstHost, err := resolveSafeName(meta.OriginalPath, FsOpWrite, role)
	if err != nil {
		return "", err
	}
	if _, err := hostRootHandle.Lstat(dstRel); err == nil {
		if !overwrite {
			return "", ErrTrashRestoreConflict
		}
		if err := hostRootHandle.RemoveAll(dstRel); err != nil {
			return "", fmt.Errorf("clearing destination: %w", err)
		}
	}

	if srcRel, ok := containerPathToRootRel(payload); ok {
		// Fast path: both sides under hostRoot, atomic rename via Root.
		if err := hostRootHandle.Rename(srcRel, dstRel); err != nil {
			var linkErr *os.LinkError
			isCrossDev := errors.As(err, &linkErr) && errors.Is(linkErr.Err, syscall.EXDEV)
			if !isCrossDev {
				return "", err
			}
			// Cross-filesystem within hostRoot: copy + delete.
			if err := restoreCopyTree(payload, dstRel); err != nil {
				_ = hostRootHandle.RemoveAll(dstRel)
				return "", err
			}
			if err := os.RemoveAll(payload); err != nil {
				log.Printf("trash: restore copy succeeded but payload cleanup failed: %v", err)
			}
		}
	} else {
		// Slow path: trashRoot is outside hostRoot (custom
		// VANTAGE_TRASH_DIR), no Root.Rename possible. Copy via Root,
		// then delete the source.
		if err := restoreCopyTree(payload, dstRel); err != nil {
			_ = hostRootHandle.RemoveAll(dstRel)
			return "", err
		}
		if err := os.RemoveAll(payload); err != nil {
			log.Printf("trash: restore copy succeeded but payload cleanup failed: %v", err)
		}
	}
	// Remove the now-empty trash entry directory (meta.json + maybe
	// an empty payload dir if it was the slow-path copy).
	_ = os.RemoveAll(entryDir)
	return dstHost, nil
}

// fsDeleteToTrashSafe is the openat2-anchored equivalent of the legacy
// fsDeleteToTrash. The source path is validated through Root (closing
// the TOCTOU window on the source side); the trash payload is either
// renamed in (fast path, both sides under hostRoot) or copied + then the
// source is removed via Root (slow path, custom VANTAGE_TRASH_DIR).
//
// Returns the trash ID on success. On failure the trash entry directory
// is cleaned up so we don't leak partial entries.
func fsDeleteToTrashSafe(in, role, deletedBy string) (trashID, hostPath string, err error) {
	srcRel, hp, err := resolveSafeName(in, FsOpDelete, role)
	if err != nil {
		return "", "", err
	}
	if _, err := hostRootHandle.Lstat(srcRel); err != nil {
		return "", hp, err
	}
	id, err := newTrashID()
	if err != nil {
		return "", hp, err
	}
	entryDir := filepath.Join(trashRoot, id)
	if err := os.MkdirAll(entryDir, 0o700); err != nil {
		return "", hp, err
	}
	payloadAbs := filepath.Join(entryDir, "payload")

	cleanupEntry := func() { _ = os.RemoveAll(entryDir) }

	if payloadRel, ok := containerPathToRootRel(payloadAbs); ok {
		// Fast path: trashRoot under hostRoot — atomic rename via Root.
		if err := hostRootHandle.Rename(srcRel, payloadRel); err != nil {
			var linkErr *os.LinkError
			isCrossDev := errors.As(err, &linkErr) && errors.Is(linkErr.Err, syscall.EXDEV)
			if !isCrossDev {
				cleanupEntry()
				return "", hp, err
			}
			// Cross-filesystem within hostRoot: copy + delete via Root.
			if err := deleteCopyTree(srcRel, payloadRel); err != nil {
				cleanupEntry()
				return "", hp, err
			}
			if err := hostRootHandle.RemoveAll(srcRel); err != nil {
				return "", hp, fmt.Errorf("copied to trash but source delete failed: %w", err)
			}
		}
	} else {
		// Slow path: VANTAGE_TRASH_DIR points outside hostRoot. We open
		// the source via Root, copy out to the raw trash path, then
		// remove the source via Root.
		if err := deleteCopyTreeOut(srcRel, payloadAbs); err != nil {
			cleanupEntry()
			return "", hp, err
		}
		if err := hostRootHandle.RemoveAll(srcRel); err != nil {
			return "", hp, fmt.Errorf("copied to trash but source delete failed: %w", err)
		}
	}

	meta := map[string]any{
		"originalPath": hp,
		"deletedAt":    time.Now().Unix(),
		"deletedBy":    deletedBy,
	}
	b, _ := json.Marshal(meta)
	// meta.json failure is non-fatal: the payload is already preserved.
	if err := os.WriteFile(filepath.Join(entryDir, "meta.json"), b, 0o600); err != nil {
		log.Printf("trash: meta.json write failed for %s: %v", id, err)
	}
	return id, hp, nil
}

// deleteCopyTree recursively copies srcRel -> dstRel ENTIRELY via Root
// (used for cross-filesystem within hostRoot).
func deleteCopyTree(srcRel, dstRel string) error {
	info, err := hostRootHandle.Lstat(srcRel)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := hostRootHandle.Readlink(srcRel)
		if err != nil {
			return err
		}
		return hostRootHandle.Symlink(target, dstRel)
	}
	if info.IsDir() {
		if err := hostRootHandle.Mkdir(dstRel, info.Mode().Perm()); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		d, err := hostRootHandle.OpenFile(srcRel, os.O_RDONLY, 0)
		if err != nil {
			return err
		}
		names, err := d.Readdirnames(-1)
		_ = d.Close()
		if err != nil {
			return err
		}
		for _, n := range names {
			if err := deleteCopyTree(filepath.Join(srcRel, n), filepath.Join(dstRel, n)); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := hostRootHandle.Open(srcRel)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := hostRootHandle.OpenFile(dstRel, os.O_CREATE|os.O_WRONLY|os.O_TRUNC|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// deleteCopyTreeOut recursively copies srcRel (under hostRoot via Root)
// -> dstAbs (raw, outside hostRoot — used when VANTAGE_TRASH_DIR points
// to a custom location).
func deleteCopyTreeOut(srcRel, dstAbs string) error {
	info, err := hostRootHandle.Lstat(srcRel)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := hostRootHandle.Readlink(srcRel)
		if err != nil {
			return err
		}
		return os.Symlink(target, dstAbs)
	}
	if info.IsDir() {
		if err := os.Mkdir(dstAbs, info.Mode().Perm()); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		d, err := hostRootHandle.OpenFile(srcRel, os.O_RDONLY, 0)
		if err != nil {
			return err
		}
		names, err := d.Readdirnames(-1)
		_ = d.Close()
		if err != nil {
			return err
		}
		for _, n := range names {
			if err := deleteCopyTreeOut(filepath.Join(srcRel, n), filepath.Join(dstAbs, n)); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := hostRootHandle.Open(srcRel)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dstAbs, os.O_CREATE|os.O_WRONLY|os.O_TRUNC|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// containerPathToRootRel converts an absolute container path (e.g.
// /hostfs/var/lib/vantage-trash/abc/payload) into a path relative to
// hostRoot suitable for hostRootHandle methods. Returns ("", false) if
// the path is not under hostRoot — in which case callers must fall back
// to raw syscalls or a copy-based path.
func containerPathToRootRel(absContainer string) (string, bool) {
	if absContainer == hostRoot {
		return ".", true
	}
	if rest, ok := strings.CutPrefix(absContainer, hostRoot+"/"); ok {
		return rest, true
	}
	return "", false
}

// restoreCopyTree recursively copies an absolute container path
// (typically a trash payload that lives outside the hostRoot view) into
// a Root-relative destination. Every write goes through hostRootHandle
// so the destination side stays TOCTOU-safe even though the source is
// addressed raw.
func restoreCopyTree(srcAbs, dstRel string) error {
	info, err := os.Lstat(srcAbs)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(srcAbs)
		if err != nil {
			return err
		}
		return hostRootHandle.Symlink(target, dstRel)
	}
	if info.IsDir() {
		if err := hostRootHandle.Mkdir(dstRel, info.Mode().Perm()); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		d, err := os.Open(srcAbs)
		if err != nil {
			return err
		}
		names, err := d.Readdirnames(-1)
		_ = d.Close()
		if err != nil {
			return err
		}
		for _, n := range names {
			if err := restoreCopyTree(filepath.Join(srcAbs, n), filepath.Join(dstRel, n)); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := os.Open(srcAbs)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := hostRootHandle.OpenFile(dstRel, os.O_CREATE|os.O_WRONLY|os.O_TRUNC|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// permanentDeleteTrash removes a trash entry from disk without restoring
// it. Admin-only — once we drop it there's no recovery.
func permanentDeleteTrash(id string) error {
	if strings.ContainsAny(id, "/\\\x00") {
		return fmt.Errorf("invalid trash id")
	}
	entryDir := filepath.Join(trashRoot, id)
	if _, err := os.Stat(entryDir); err != nil {
		return err
	}
	return os.RemoveAll(entryDir)
}

// startTrashSweep runs a background goroutine that purges trash entries
// older than ttl. Called from main.go alongside the snapshot manager.
//
// The sweep is intentionally simple: every tickEvery we scan trashRoot,
// look at each entry's meta.deletedAt, and remove anything older than
// the cutoff. Entries without a parseable meta are NOT removed — we
// prefer to leak a stale dir over silently deleting unknown content.
func startTrashSweep(ctx context.Context, ttl, tickEvery time.Duration) {
	go func() {
		t := time.NewTicker(tickEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				sweepTrash(ttl)
			}
		}
	}()
}

func sweepTrash(ttl time.Duration) {
	cutoff := time.Now().Add(-ttl).Unix()
	entries, err := os.ReadDir(trashRoot)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("trash sweep: read dir: %v", err)
		}
		return
	}
	for _, e := range entries {
		entryDir := filepath.Join(trashRoot, e.Name())
		meta, err := readTrashMeta(entryDir)
		if err != nil {
			// Unknown shape — leave alone.
			continue
		}
		if meta.DeletedAt > 0 && meta.DeletedAt < cutoff {
			if err := os.RemoveAll(entryDir); err != nil {
				log.Printf("trash sweep: remove %s: %v", entryDir, err)
			}
		}
	}
}
