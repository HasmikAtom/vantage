package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// fs_safety_at.go is the openat2-based replacement for the EvalSymlinks
// chokepoint in fs_safety.go. Every helper here closes the time-of-check
// to time-of-use (TOCTOU) window that exists when path resolution and
// the syscall are separate steps.
//
// The kernel mechanism is openat2(RESOLVE_BENEATH), exposed via
// os.Root (Go 1.24+). A Root holds an O_PATH fd to hostRoot; every
// method does a single openat2 walk anchored to that fd. The walk
// follows symlinks but refuses any path component that would resolve
// outside the root — so an attacker who swaps a parent directory for
// a symlink to /etc cannot redirect our open mid-walk.
//
// Callers never see a raw container-path string. The helpers take an
// "in" path (host-relative, e.g. "/home/user/foo"), apply the existing
// denylist + role rules, then dispatch to the matching Root method.

// hostRootHandle is the single rooted handle every file operation goes
// through. Opened in initHostRoot() at startup; closed at process exit
// (the OS reclaims fds anyway, but we keep the Close() explicit so
// race tests can swap roots cleanly).
var hostRootHandle *os.Root

// initHostRoot opens hostRoot for the safe helpers. Called from main()
// before any handler can run. On systems without openat2 support
// (Linux <5.6), os.OpenRoot returns ENOSYS and we fail closed rather
// than silently degrading to the racy fallback.
func initHostRoot() {
	r, err := os.OpenRoot(hostRoot)
	if err != nil {
		log.Fatalf("fs safety: cannot open host root %q: %v", hostRoot, err)
	}
	hostRootHandle = r
}

// toRootRel converts a host-absolute path ("/home/user/foo") into the
// form os.Root expects ("home/user/foo", or "." for the root itself).
// The leading slash MUST be stripped because Root rejects absolute names.
func toRootRel(hostAbs string) string {
	if hostAbs == "/" {
		return "."
	}
	return strings.TrimPrefix(hostAbs, "/")
}

// resolveSafeName runs the denylist + role checks against the cleaned
// host-absolute path, then returns the name relative to hostRoot ready
// to pass into an os.Root method. This is the policy half of the old
// resolveSafe — the actual filesystem walk is the responsibility of the
// Root method that follows.
//
// Returns (rootRelative, hostCanonical, error). The hostCanonical value
// is what audit logs / UI responses should use (it's the absolute
// host-namespace path, not the root-relative form).
func resolveSafeName(in string, op FsOp, role string) (rootRel, hostAbs string, err error) {
	hostAbs, err = toAbsHost(in)
	if err != nil {
		return "", "", err
	}
	if pathInDenylist(hostAbs) {
		return "", "", ErrPathDenied
	}
	if (op == FsOpRead || op == FsOpDownload) && pathInAdminReadList(hostAbs) {
		if !roleAtLeast(roleAdmin, role) {
			return "", "", ErrAdminRequired
		}
	}
	return toRootRel(hostAbs), hostAbs, nil
}

// ---------------------------------------------------------------------------
// Operation helpers
//
// Each helper is a thin wrapper: validate via resolveSafeName, then call
// the matching os.Root method. The Root method does the openat2 walk
// atomically — there is no window between policy check and the syscall.
//
// Helpers return the canonical host path so callers can populate audit
// logs / response bodies without re-deriving it.
// ---------------------------------------------------------------------------

// safeOpenDir opens a directory for listing (Readdirnames). Caller must
// Close the returned *os.File.
func safeOpenDir(in, role string) (*os.File, string, error) {
	rel, hp, err := resolveSafeName(in, FsOpList, role)
	if err != nil {
		return nil, "", err
	}
	f, err := hostRootHandle.OpenFile(rel, os.O_RDONLY, 0)
	if err != nil {
		return nil, hp, err
	}
	return f, hp, nil
}

// safeOpenForRead opens a file for reading. Caller must Close.
func safeOpenForRead(in, role string) (*os.File, string, error) {
	rel, hp, err := resolveSafeName(in, FsOpRead, role)
	if err != nil {
		return nil, "", err
	}
	f, err := hostRootHandle.Open(rel)
	if err != nil {
		return nil, hp, err
	}
	return f, hp, nil
}

// safeOpenForDownload is identical to safeOpenForRead but uses the
// FsOpDownload op so the admin-read denylist applies the download
// classification (matches the legacy resolveSafe behaviour).
func safeOpenForDownload(in, role string) (*os.File, string, error) {
	rel, hp, err := resolveSafeName(in, FsOpDownload, role)
	if err != nil {
		return nil, "", err
	}
	f, err := hostRootHandle.Open(rel)
	if err != nil {
		return nil, hp, err
	}
	return f, hp, nil
}

// safeOpenForWrite opens a file for writing with the caller-supplied
// flags / mode. Same TOCTOU guarantee as safeOpenForRead.
func safeOpenForWrite(in, role string, flag int, perm os.FileMode) (*os.File, string, error) {
	rel, hp, err := resolveSafeName(in, FsOpWrite, role)
	if err != nil {
		return nil, "", err
	}
	f, err := hostRootHandle.OpenFile(rel, flag, perm)
	if err != nil {
		return nil, hp, err
	}
	return f, hp, nil
}

// safeOpenForUpload mirrors safeOpenForWrite but uses the FsOpUpload op
// so future role policies that distinguish upload from text-write can
// kick in. Today both ops share the same denylist behaviour.
func safeOpenForUpload(in, role string, flag int, perm os.FileMode) (*os.File, string, error) {
	rel, hp, err := resolveSafeName(in, FsOpUpload, role)
	if err != nil {
		return nil, "", err
	}
	f, err := hostRootHandle.OpenFile(rel, flag, perm)
	if err != nil {
		return nil, hp, err
	}
	return f, hp, nil
}

// safeStat is the followsymlinks Stat. The walk to the target is
// TOCTOU-safe; the resolution of a final symlink target follows root
// containment rules (target must also live under hostRoot).
func safeStat(in string, op FsOp, role string) (os.FileInfo, string, error) {
	rel, hp, err := resolveSafeName(in, op, role)
	if err != nil {
		return nil, "", err
	}
	info, err := hostRootHandle.Stat(rel)
	if err != nil {
		return nil, hp, err
	}
	return info, hp, nil
}

// safeLstat does NOT follow a final symlink — used by listings and
// stat handlers that want to expose link metadata.
func safeLstat(in string, op FsOp, role string) (os.FileInfo, string, error) {
	rel, hp, err := resolveSafeName(in, op, role)
	if err != nil {
		return nil, "", err
	}
	info, err := hostRootHandle.Lstat(rel)
	if err != nil {
		return nil, hp, err
	}
	return info, hp, nil
}

// safeReadlink returns the target of a symlink at `in`. The link target
// itself is NOT containment-checked here (the value is data, not a path
// we're about to open); callers that want to follow it should route the
// target back through safeStat / safeOpenForRead.
func safeReadlink(in, role string) (string, string, error) {
	rel, hp, err := resolveSafeName(in, FsOpStat, role)
	if err != nil {
		return "", "", err
	}
	target, err := hostRootHandle.Readlink(rel)
	if err != nil {
		return "", hp, err
	}
	return target, hp, nil
}

// safeMkdir creates a single directory. Parent must exist. Use
// safeMkdirAll if you want recursive creation.
func safeMkdir(in, role string, perm os.FileMode) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpMkdir, role)
	if err != nil {
		return "", err
	}
	if err := hostRootHandle.Mkdir(rel, perm); err != nil {
		return hp, err
	}
	return hp, nil
}

// safeMkdirInheritOwner creates a directory at `in` with the given
// permission bits, then sets its owner/group to the parent directory's
// owner/group. Matches the legacy fsMkdir contract (don't leave a
// freshly-created dir in a user's home as root:root). Errors from the
// chown step are silent — the dir exists either way and the caller can
// fix ownership later.
func safeMkdirInheritOwner(in, role string, perm os.FileMode) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpMkdir, role)
	if err != nil {
		return "", err
	}
	if err := hostRootHandle.Mkdir(rel, perm); err != nil {
		return hp, err
	}
	parent, _ := splitRootRel(rel)
	if pinfo, err := hostRootHandle.Lstat(parent); err == nil {
		if st, ok := pinfo.Sys().(*syscall.Stat_t); ok {
			_ = hostRootHandle.Lchown(rel, int(st.Uid), int(st.Gid))
		}
	}
	return hp, nil
}

// safeMkdirAll creates `in` and any missing parents. Each intermediate
// directory creation goes through Root, so the same containment
// guarantee applies to the whole chain.
func safeMkdirAll(in, role string, perm os.FileMode) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpMkdir, role)
	if err != nil {
		return "", err
	}
	if err := hostRootHandle.MkdirAll(rel, perm); err != nil {
		return hp, err
	}
	return hp, nil
}

// safeRemove deletes a single file or empty directory. Use safeRemoveAll
// for trees.
func safeRemove(in, role string) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpDelete, role)
	if err != nil {
		return "", err
	}
	if err := hostRootHandle.Remove(rel); err != nil {
		return hp, err
	}
	return hp, nil
}

// safeRemoveAll recursively deletes `in`. Each entry in the tree is
// resolved through Root so a symlink swap mid-walk cannot redirect us
// outside the root.
func safeRemoveAll(in, role string) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpDelete, role)
	if err != nil {
		return "", err
	}
	if err := hostRootHandle.RemoveAll(rel); err != nil {
		return hp, err
	}
	return hp, nil
}

// safeRename moves `from` to `to`. Both paths are validated separately.
// Cross-filesystem renames return EXDEV (callers handle via copy+delete).
func safeRename(from, to, role string) (fromHost, toHost string, err error) {
	srcRel, fromHost, err := resolveSafeName(from, FsOpRename, role)
	if err != nil {
		return "", "", err
	}
	dstRel, toHost, err := resolveSafeName(to, FsOpRename, role)
	if err != nil {
		return fromHost, "", err
	}
	if err := hostRootHandle.Rename(srcRel, dstRel); err != nil {
		return fromHost, toHost, err
	}
	return fromHost, toHost, nil
}

// copyOpts modifies the copy walk: Overwrite replaces an existing
// regular-file destination, Recursive is required when the source is a
// directory.
type copyOpts struct {
	Overwrite bool
	Recursive bool
}

// safeCopy duplicates `from` to `to`. Both paths route through
// resolveSafeName so the denylist + policy checks apply to each side.
//
// Behaviour:
//   - Source may be a regular file, a symlink (copied as a symlink — target
//     is preserved verbatim, NOT followed), or a directory (requires
//     opts.Recursive).
//   - Special files (devices, FIFOs, sockets) are refused (ErrSpecialFile).
//   - If the destination exists and is a directory, the copy is refused —
//     callers must pass the final path, mirroring the rename contract.
//   - If the destination exists as a regular file or symlink, behaviour
//     depends on opts.Overwrite. Off (the default) → os.ErrExist (handler
//     maps to 409). On → atomic replace via temp + rename.
//   - Refuses to copy a path onto itself or into its own subtree.
//   - Best-effort preservation of mode bits and uid/gid (silent on Chown
//     failure — running as non-root in tests must not break the copy).
//
// Containment: every syscall goes through hostRootHandle so a symlink swap
// on any parent component cannot redirect the walk outside hostRoot.
func safeCopy(from, to, role string, opts copyOpts) (fromHost, toHost string, err error) {
	srcRel, fromHost, err := resolveSafeName(from, FsOpCopy, role)
	if err != nil {
		return "", "", err
	}
	dstRel, toHost, err := resolveSafeName(to, FsOpCopy, role)
	if err != nil {
		return fromHost, "", err
	}
	if srcRel == dstRel {
		return fromHost, toHost, fmt.Errorf("source and destination are the same")
	}
	if isDescendantRel(srcRel, dstRel) {
		return fromHost, toHost, fmt.Errorf("destination is inside source")
	}

	srcInfo, err := hostRootHandle.Lstat(srcRel)
	if err != nil {
		return fromHost, toHost, err
	}

	if dstInfo, derr := hostRootHandle.Lstat(dstRel); derr == nil {
		if dstInfo.IsDir() {
			return fromHost, toHost, fmt.Errorf("destination is an existing directory")
		}
		if !opts.Overwrite {
			return fromHost, toHost, os.ErrExist
		}
		if srcInfo.IsDir() {
			return fromHost, toHost, fmt.Errorf("cannot overwrite a file with a directory")
		}
	} else if !errors.Is(derr, os.ErrNotExist) {
		return fromHost, toHost, derr
	}

	if err := copyTree(srcRel, dstRel, srcInfo, opts); err != nil {
		return fromHost, toHost, err
	}
	return fromHost, toHost, nil
}

// safeMove relocates `from` to `to`. Same-filesystem renames use the kernel
// rename in one step; cross-filesystem moves transparently fall back to
// copy+delete via copyTree + RemoveAll. Both halves of the fallback run
// through hostRootHandle.
//
// Behaviour parallels safeCopy:
//   - Destination must not be an existing directory.
//   - opts.Overwrite=false (default) refuses to clobber any existing dest.
//   - opts.Overwrite=true allows replacing an existing regular file /
//     symlink — for the rename fast-path this is the kernel's default
//     atomic-replace; for the EXDEV fallback we honour it by passing the
//     flag down to copyTree.
//   - Refuses a move onto self or into its own subtree.
func safeMove(from, to, role string, opts copyOpts) (fromHost, toHost string, err error) {
	srcRel, fromHost, err := resolveSafeName(from, FsOpRename, role)
	if err != nil {
		return "", "", err
	}
	dstRel, toHost, err := resolveSafeName(to, FsOpRename, role)
	if err != nil {
		return fromHost, "", err
	}
	if srcRel == dstRel {
		return fromHost, toHost, fmt.Errorf("source and destination are the same")
	}
	if isDescendantRel(srcRel, dstRel) {
		return fromHost, toHost, fmt.Errorf("destination is inside source")
	}

	// Pre-check the destination so overwrite=false refuses BEFORE we
	// touch the source. Without this Lstat the kernel rename would
	// silently clobber a regular-file dest.
	srcInfo, err := hostRootHandle.Lstat(srcRel)
	if err != nil {
		return fromHost, toHost, err
	}
	if dstInfo, derr := hostRootHandle.Lstat(dstRel); derr == nil {
		if dstInfo.IsDir() {
			return fromHost, toHost, fmt.Errorf("destination is an existing directory")
		}
		if !opts.Overwrite {
			return fromHost, toHost, os.ErrExist
		}
		if srcInfo.IsDir() {
			return fromHost, toHost, fmt.Errorf("cannot overwrite a file with a directory")
		}
	} else if !errors.Is(derr, os.ErrNotExist) {
		return fromHost, toHost, derr
	}

	if err := hostRootHandle.Rename(srcRel, dstRel); err == nil {
		return fromHost, toHost, nil
	} else if !errors.Is(err, syscall.EXDEV) {
		return fromHost, toHost, err
	}

	// Cross-filesystem move: copy then delete. Recursive is implicit
	// when source is a directory — the rename would have handled the
	// non-recursive case in one syscall.
	opts.Recursive = true
	if err := copyTree(srcRel, dstRel, srcInfo, opts); err != nil {
		return fromHost, toHost, err
	}
	if err := hostRootHandle.RemoveAll(srcRel); err != nil {
		return fromHost, toHost, err
	}
	return fromHost, toHost, nil
}

// copyTree dispatches by source kind. Called both from safeCopy and the
// EXDEV fallback in safeMove. srcInfo must be the Lstat result for srcRel
// (so symlinks are detected, not followed).
func copyTree(srcRel, dstRel string, srcInfo os.FileInfo, opts copyOpts) error {
	mode := srcInfo.Mode()
	switch {
	case mode&os.ModeSymlink != 0:
		target, err := hostRootHandle.Readlink(srcRel)
		if err != nil {
			return err
		}
		// For overwrite=true the caller has already authorised replacing
		// the dest; remove first so Symlink doesn't fail with EEXIST.
		_ = hostRootHandle.Remove(dstRel)
		return hostRootHandle.Symlink(target, dstRel)
	case mode.IsRegular():
		return copyRegularFile(srcRel, dstRel, srcInfo)
	case mode.IsDir():
		if !opts.Recursive {
			return fmt.Errorf("source is a directory (pass recursive=true)")
		}
		return copyDir(srcRel, dstRel, srcInfo, opts)
	default:
		return ErrSpecialFile
	}
}

// copyRegularFile streams srcRel → dstRel via a sibling temp-file with an
// atomic rename, mirroring safeUpload's contract: mid-stream failures
// never leave the destination half-written. Mode bits are preserved from
// the source; uid/gid is preserved best-effort (silent on failure so a
// non-root process can still copy).
func copyRegularFile(srcRel, dstRel string, srcInfo os.FileInfo) error {
	src, err := hostRootHandle.OpenFile(srcRel, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer src.Close()

	dir, leaf := splitRootRel(dstRel)
	if leaf == "" || leaf == "." {
		return fmt.Errorf("invalid destination")
	}
	tmpName, err := randomTmpName(dir, leaf)
	if err != nil {
		return err
	}
	mode := srcInfo.Mode().Perm()
	dst, err := hostRootHandle.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	cleanup := func() { _ = hostRootHandle.Remove(tmpName) }
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		cleanup()
		return err
	}
	if err := dst.Chmod(mode); err != nil {
		_ = dst.Close()
		cleanup()
		return err
	}
	if st, ok := srcInfo.Sys().(*syscall.Stat_t); ok {
		// Silent: copy still succeeds even if chown is denied (matches
		// the upload / write-text rules).
		_ = dst.Chown(int(st.Uid), int(st.Gid))
	}
	if err := dst.Close(); err != nil {
		cleanup()
		return err
	}
	if err := hostRootHandle.Rename(tmpName, dstRel); err != nil {
		cleanup()
		return err
	}
	return nil
}

// copyDir recursively duplicates a directory. The destination directory is
// created with the source's perm bits; uid/gid is preserved best-effort.
// Each child is dispatched through copyTree so symlinks remain symlinks
// and nested dirs descend further.
func copyDir(srcRel, dstRel string, srcInfo os.FileInfo, opts copyOpts) error {
	mode := srcInfo.Mode().Perm()
	if err := hostRootHandle.Mkdir(dstRel, mode); err != nil {
		return err
	}
	if st, ok := srcInfo.Sys().(*syscall.Stat_t); ok {
		_ = hostRootHandle.Lchown(dstRel, int(st.Uid), int(st.Gid))
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
		childSrc := joinRootRel(srcRel, n)
		childDst := joinRootRel(dstRel, n)
		childInfo, err := hostRootHandle.Lstat(childSrc)
		if err != nil {
			return err
		}
		if err := copyTree(childSrc, childDst, childInfo, opts); err != nil {
			return err
		}
	}
	return nil
}

// joinRootRel joins two root-relative path segments, handling the "."
// root case that splitRootRel leaves behind.
func joinRootRel(rel, name string) string {
	if rel == "" || rel == "." {
		return name
	}
	return rel + "/" + name
}

// isDescendantRel reports whether `dst` is `src` or sits inside `src/`.
// Used to refuse copy/move from /a/b into /a/b/c (infinite copy / broken
// move). Inputs are root-relative paths from resolveSafeName, so they're
// already canonical.
func isDescendantRel(src, dst string) bool {
	if src == dst {
		return true
	}
	return strings.HasPrefix(dst, src+"/")
}

// safeChmod sets perm on `in`. NOTE: per os.Root docs, Chmod has a
// narrow Unix race window where a file-to-symlink swap mid-operation
// can land the chmod on the link instead of the target. This is a
// stdlib limitation, not something we can close from here; the
// operator-role gate on the chmod handler is the actual mitigation.
func safeChmod(in, role string, perm os.FileMode) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpWrite, role)
	if err != nil {
		return "", err
	}
	if err := hostRootHandle.Chmod(rel, perm); err != nil {
		return hp, err
	}
	return hp, nil
}

// safeLchown sets uid/gid on `in` without following a final symlink.
// Use -1 to leave a side untouched.
func safeLchown(in, role string, uid, gid int) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpWrite, role)
	if err != nil {
		return "", err
	}
	if err := hostRootHandle.Lchown(rel, uid, gid); err != nil {
		return hp, err
	}
	return hp, nil
}

// safeChown sets uid/gid following a final symlink. Used by the
// recursive chown walk after the leaf has already been verified.
func safeChown(in, role string, uid, gid int) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpWrite, role)
	if err != nil {
		return "", err
	}
	if err := hostRootHandle.Chown(rel, uid, gid); err != nil {
		return hp, err
	}
	return hp, nil
}

// safeChownRecursive sets owner/group on `in` and, if it's a directory,
// every descendant. Each Lchown goes through Root so a symlink swap
// mid-walk cannot redirect us outside the host filesystem view. Symlinks
// themselves are chowned (not their targets) — matches the legacy
// fsChown behaviour and the chown(8) `--reference` idiom.
func safeChownRecursive(in, role string, uid, gid int) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpWrite, role)
	if err != nil {
		return "", err
	}
	return hp, chownWalk(rel, uid, gid)
}

func chownWalk(rel string, uid, gid int) error {
	if err := hostRootHandle.Lchown(rel, uid, gid); err != nil {
		return err
	}
	info, err := hostRootHandle.Lstat(rel)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return nil
	}
	d, err := hostRootHandle.OpenFile(rel, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	names, err := d.Readdirnames(-1)
	_ = d.Close()
	if err != nil {
		return err
	}
	for _, n := range names {
		var child string
		if rel == "." {
			child = n
		} else {
			child = rel + "/" + n
		}
		if err := chownWalk(child, uid, gid); err != nil {
			return err
		}
	}
	return nil
}

// safeWriteTextPreserving is the openat2-anchored equivalent of the
// legacy fsWriteText. It:
//
//   - Atomically replaces `in` with `content` via temp-write + rename
//     in the same directory.
//   - On overwrite, preserves the existing file's permission bits AND
//     uid/gid so the in-place editor doesn't silently turn root:root
//     files into the backend's identity.
//   - On create, defaults to 0o644 and inherits ownership from the
//     destination's parent directory (matching the upload rule).
//
// Refuses to overwrite a non-regular file (symlink, dir, device) — the
// in-place editor only deals with text files.
func safeWriteTextPreserving(in, role string, content []byte) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpWrite, role)
	if err != nil {
		return "", err
	}
	mode := os.FileMode(0o644)
	wantChownUID, wantChownGID := -1, -1
	existed := true
	if info, err := hostRootHandle.Lstat(rel); err == nil {
		if !info.Mode().IsRegular() {
			return hp, fmt.Errorf("destination is not a regular file")
		}
		mode = info.Mode().Perm()
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			wantChownUID, wantChownGID = int(st.Uid), int(st.Gid)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		existed = false
	} else {
		return hp, err
	}
	dir, leaf := splitRootRel(rel)
	if leaf == "" || leaf == "." {
		return hp, fmt.Errorf("cannot write to a directory")
	}
	if !existed {
		// New file: inherit ownership from the parent dir (matches upload).
		if pinfo, err := hostRootHandle.Lstat(dir); err == nil {
			if st, ok := pinfo.Sys().(*syscall.Stat_t); ok {
				wantChownUID, wantChownGID = int(st.Uid), int(st.Gid)
			}
		}
	}
	tmpName, err := randomTmpName(dir, leaf)
	if err != nil {
		return hp, err
	}
	tmp, err := hostRootHandle.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_TRUNC, mode)
	if err != nil {
		return hp, err
	}
	cleanup := func() { _ = hostRootHandle.Remove(tmpName) }
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		cleanup()
		return hp, err
	}
	// Chmod/Chown via the open fd, not by name, so the stdlib's
	// by-name race window (file-to-symlink swap between Open and
	// Chmod) cannot redirect either operation. Umask DOES clip
	// OpenFile's perm bits, so Chmod is necessary to faithfully
	// reproduce a liberal source mode (e.g. preserving an existing
	// 0o666 file across overwrite).
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		cleanup()
		return hp, err
	}
	if wantChownUID >= 0 && wantChownGID >= 0 {
		// Errors are silent — chown failure on a freshly-created
		// temp is non-fatal (we just lose ownership preservation
		// for this write, the data is still written correctly).
		_ = tmp.Chown(wantChownUID, wantChownGID)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return hp, err
	}
	if err := hostRootHandle.Rename(tmpName, rel); err != nil {
		cleanup()
		return hp, err
	}
	return hp, nil
}

// safeWriteFile writes `data` to `in` atomically: it writes to a temp
// file in the same directory then renames into place. Both the temp
// and the rename go through Root so the whole sequence is contained.
// Inherits ownership from the destination parent on creation (matching
// the legacy fsWriteText behaviour).
func safeWriteFile(in, role string, data []byte, perm os.FileMode) (string, error) {
	rel, hp, err := resolveSafeName(in, FsOpWrite, role)
	if err != nil {
		return "", err
	}
	dir, leaf := splitRootRel(rel)
	if leaf == "" || leaf == "." {
		return hp, fmt.Errorf("cannot write to a directory")
	}
	tmpName, err := randomTmpName(dir, leaf)
	if err != nil {
		return hp, err
	}
	tmp, err := hostRootHandle.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_TRUNC, perm)
	if err != nil {
		return hp, err
	}
	cleanup := func() { _ = hostRootHandle.Remove(tmpName) }
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		cleanup()
		return hp, err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		cleanup()
		return hp, err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return hp, err
	}
	if err := hostRootHandle.Rename(tmpName, rel); err != nil {
		cleanup()
		return hp, err
	}
	return hp, nil
}

// safeUpload streams `r` to a file at `in` via a temp-write + atomic
// rename. Going through a temp file (rather than truncating the
// destination in place) means a mid-stream failure never leaves the
// destination half-overwritten — the existing file is untouched until
// the temp is fully written and the rename promotes it.
//
// Containment: every syscall goes through the rooted handle, so a
// symlink swap on any parent component can't redirect either the temp
// open or the rename.
//
// Behaviour preserved from the legacy fsUpload:
//   - When overwrite=false and the destination exists, returns ErrExist
//     (the handler maps to 409 Conflict).
//   - On create, the temp gets the destination parent's uid/gid before
//     rename, so a freshly-uploaded file inherits the directory's owner
//     instead of running as backend:backend.
//   - On overwrite, the temp inherits the existing file's perm bits +
//     uid/gid (not the backend's identity), preserving the inode's
//     metadata across the replace.
func safeUpload(in, role string, r io.Reader, overwrite bool) (int64, string, error) {
	rel, hp, err := resolveSafeName(in, FsOpUpload, role)
	if err != nil {
		return 0, "", err
	}
	dir, leaf := splitRootRel(rel)
	if leaf == "" || leaf == "." {
		return 0, hp, fmt.Errorf("cannot upload to a directory")
	}
	// Verify the parent dir exists; capture its owner for the
	// inherit-on-create case (read once up front so we don't Lstat
	// twice).
	pinfo, err := hostRootHandle.Lstat(dir)
	if err != nil {
		return 0, hp, err
	}
	parentUID, parentGID := -1, -1
	if st, ok := pinfo.Sys().(*syscall.Stat_t); ok {
		parentUID, parentGID = int(st.Uid), int(st.Gid)
	}
	// Pre-check destination. If it exists and overwrite=false, fail
	// early before opening any temp file. There is a small TOCTOU
	// window between this check and the final Rename — a concurrent
	// create could land in between and our Rename would silently
	// replace it — but the cost of fully closing it is calling
	// renameat2 with RENAME_NOREPLACE which Go's stdlib doesn't
	// expose. Document and accept; matches legacy O_EXCL semantics
	// for the common single-uploader case.
	mode := os.FileMode(0o644)
	preserveUID, preserveGID := -1, -1
	if dinfo, err := hostRootHandle.Lstat(rel); err == nil {
		if !overwrite {
			return 0, hp, os.ErrExist
		}
		if !dinfo.Mode().IsRegular() {
			return 0, hp, fmt.Errorf("destination is not a regular file")
		}
		mode = dinfo.Mode().Perm()
		if st, ok := dinfo.Sys().(*syscall.Stat_t); ok {
			preserveUID, preserveGID = int(st.Uid), int(st.Gid)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, hp, err
	}

	tmpName, err := randomTmpName(dir, leaf)
	if err != nil {
		return 0, hp, err
	}
	tmp, err := hostRootHandle.OpenFile(tmpName, os.O_WRONLY|os.O_CREATE|os.O_EXCL|os.O_TRUNC, mode)
	if err != nil {
		return 0, hp, err
	}
	cleanup := func() { _ = hostRootHandle.Remove(tmpName) }
	n, copyErr := io.Copy(tmp, r)
	if copyErr != nil {
		_ = tmp.Close()
		cleanup()
		return 0, hp, copyErr
	}
	// Set perms + ownership via the open fd so an attacker who can
	// touch the parent dir mid-flight cannot redirect the Chmod/Chown
	// by swapping the dotted temp name for a symlink.
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		cleanup()
		return 0, hp, err
	}
	// Choose chown target: preserve existing (overwrite path) or
	// inherit from parent (create path).
	chownUID, chownGID := preserveUID, preserveGID
	if chownUID < 0 || chownGID < 0 {
		chownUID, chownGID = parentUID, parentGID
	}
	if chownUID >= 0 && chownGID >= 0 {
		_ = tmp.Chown(chownUID, chownGID)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return 0, hp, err
	}
	if err := hostRootHandle.Rename(tmpName, rel); err != nil {
		cleanup()
		return 0, hp, err
	}
	return n, hp, nil
}

// safeReadFile is a shortcut for "open + ReadAll + close". Use
// safeOpenForRead directly when streaming or when you need the file
// handle for further ops (e.g. Stat after open).
func safeReadFile(in, role string) ([]byte, string, error) {
	rel, hp, err := resolveSafeName(in, FsOpRead, role)
	if err != nil {
		return nil, "", err
	}
	b, err := hostRootHandle.ReadFile(rel)
	if err != nil {
		return nil, hp, err
	}
	return b, hp, nil
}

// randomTmpName returns a temp-file name with a random suffix in `dir`
// for the given `leaf`. Using a random suffix (rather than a fixed
// `.<leaf>.vantage-tmp`) means a crash-leftover dotfile from a
// previous run cannot block subsequent writes with EEXIST. Two
// concurrent writes to the same leaf also no longer collide.
func randomTmpName(dir, leaf string) (string, error) {
	var b [6]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	name := "." + leaf + ".vantage-" + hex.EncodeToString(b[:]) + ".tmp"
	if dir == "" || dir == "." {
		return name, nil
	}
	return filepath.Join(dir, name), nil
}

// splitRootRel splits a root-relative path "home/user/foo" into
// ("home/user", "foo"). The root itself ("." or "") returns ("", "").
func splitRootRel(rel string) (dir, leaf string) {
	if rel == "" || rel == "." {
		return "", ""
	}
	i := strings.LastIndex(rel, "/")
	if i < 0 {
		return ".", rel
	}
	return rel[:i], rel[i+1:]
}

// joinHostPath joins two host-namespace path components — used to build
// child host paths during a listing. Handles the root ("/") parent
// without producing a "//foo" double slash.
func joinHostPath(parent, child string) string {
	if parent == "/" {
		return "/" + child
	}
	return parent + "/" + child
}

// buildEntry constructs an FsEntry from a Root-rooted Lstat result. The
// optional symlink resolution (target string + Broken flag) uses Root
// methods so it stays within the host filesystem view.
func buildEntry(info os.FileInfo, rootRel, hostPath string) FsEntry {
	mode := info.Mode()
	typ := "other"
	switch {
	case mode.IsDir():
		typ = "dir"
	case mode&os.ModeSymlink != 0:
		typ = "symlink"
	case mode.IsRegular():
		typ = "file"
	}
	st, _ := info.Sys().(*syscall.Stat_t)
	var uid, gid uint32
	if st != nil {
		uid, gid = st.Uid, st.Gid
	}
	e := FsEntry{
		Name:    info.Name(),
		Path:    hostPath,
		Type:    typ,
		Size:    info.Size(),
		Mode:    uint32(mode.Perm()),
		ModeStr: mode.String(),
		UID:     uid,
		GID:     gid,
		Mtime:   info.ModTime().Unix(),
		Owner:   resolveUIDName(uid),
		Group:   resolveGIDName(gid),
	}
	if typ == "symlink" {
		e.IsSymlink = true
		if target, err := hostRootHandle.Readlink(rootRel); err == nil {
			e.Target = target
		}
		if _, err := hostRootHandle.Stat(rootRel); err != nil && os.IsNotExist(err) {
			e.Broken = true
		}
	}
	return e
}

// safeStatEntry returns the FsEntry for `in`, using Lstat (does not
// follow a final symlink — link metadata is what the UI wants).
func safeStatEntry(in, role string, op FsOp) (FsEntry, string, error) {
	rel, hp, err := resolveSafeName(in, op, role)
	if err != nil {
		return FsEntry{}, "", err
	}
	info, err := hostRootHandle.Lstat(rel)
	if err != nil {
		return FsEntry{}, hp, err
	}
	return buildEntry(info, rel, hp), hp, nil
}

// safeListDir reads `in` (which must be a directory) via Root and
// returns one FsEntry per child. Per-child metadata is fetched via Root
// too so the whole listing stays within the host filesystem view —
// symlinks pointing outside hostRoot become broken-symlink entries
// rather than silently leaking host content.
//
// Sort order matches the legacy fsListDir: directories first, then
// case-insensitive by name.
func safeListDir(in, role string) ([]FsEntry, string, error) {
	rel, hp, err := resolveSafeName(in, FsOpList, role)
	if err != nil {
		return nil, "", err
	}
	f, err := hostRootHandle.OpenFile(rel, os.O_RDONLY, 0)
	if err != nil {
		return nil, hp, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, hp, err
	}
	if !info.IsDir() {
		return nil, hp, fmt.Errorf("not a directory")
	}
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, hp, err
	}
	out := make([]FsEntry, 0, len(names))
	for _, n := range names {
		var childRel string
		if rel == "." {
			childRel = n
		} else {
			childRel = rel + "/" + n
		}
		childHp := joinHostPath(hp, n)
		childInfo, err := hostRootHandle.Lstat(childRel)
		if err != nil {
			// One bad child shouldn't break the whole listing; surface
			// a placeholder entry as the legacy code did.
			out = append(out, FsEntry{Name: n, Path: childHp, Type: "other"})
			continue
		}
		out = append(out, buildEntry(childInfo, childRel, childHp))
	}
	sort.Slice(out, func(i, j int) bool {
		di, dj := out[i].Type == "dir", out[j].Type == "dir"
		if di != dj {
			return di
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, hp, nil
}

// resolveUIDName / resolveGIDName turn a numeric uid/gid into the
// matching /etc/passwd / /etc/group name, falling back to the numeric
// form when the lookup fails so the UI always has something to show.
func resolveUIDName(uid uint32) string {
	u, err := user.LookupId(strconv.Itoa(int(uid)))
	if err != nil {
		return strconv.Itoa(int(uid))
	}
	return u.Username
}

func resolveGIDName(gid uint32) string {
	g, err := user.LookupGroupId(strconv.Itoa(int(gid)))
	if err != nil {
		return strconv.Itoa(int(gid))
	}
	return g.Name
}
