package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// File-system feature paths live in the HOST's namespace from the user's
// perspective. The outpost container sees the host root through the
// /hostfs bind mount, so every user-supplied path P becomes ${hostRoot}/P
// before we touch the filesystem. vantage-prime never sees the prefix.
//
// hostRoot is resolved at startup so we don't repeatedly call os.Getenv on
// every request. It is /hostfs in prod (matches docker-compose.prod.yml)
// and tests can override via HOST_ROOT.
var hostRoot = func() string {
	if v := os.Getenv("HOST_ROOT"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "/hostfs"
}()

// Trash root lives at a fixed location ON THE HOST so it survives outpost
// container rebuilds. We pin a single dir instead of per-filesystem trash
// because the recovery UX is simpler — but it does mean cross-filesystem
// deletes fall back to copy+delete (handled inside fsDeleteToTrash).
//
// Default resolves under hostRoot so the data lives on the host at
// /var/lib/vantage-trash, not in the container's writable layer.
// VANTAGE_TRASH_DIR overrides for tests / non-standard layouts and is
// taken verbatim (assumed already in the container's namespace).
var trashRoot = func() string {
	if v := os.Getenv("VANTAGE_TRASH_DIR"); v != "" {
		return v
	}
	return hostRoot + "/var/lib/vantage-trash"
}()

// fsDenylist holds path prefixes that are off-limits to every role,
// including admin. These either control the kernel (/proc, /sys), are
// short-lived state nobody should be touching at rest (/run), would brick
// the host on accidental delete (/boot, /etc/shadow, /etc/sudoers,
// /etc/ssh), or break the dashboard itself (/var/lib/docker — managed
// through the docker API, not file ops). The check matches against
// canonical (symlink-resolved) paths AFTER user input so a symlink can't
// be used to slip past.
var fsDenylist = []string{
	"/proc",
	"/sys",
	"/dev",
	"/run",
	"/boot",
	"/etc/shadow",
	"/etc/shadow-",
	"/etc/gshadow",
	"/etc/gshadow-",
	"/etc/passwd-",
	"/etc/sudoers",
	"/etc/sudoers.d",
	"/etc/ssh",
	"/var/lib/docker",
}

// fsAdminReadPaths gates *reading file contents* (not listing) on the
// admin role. Listing the directory is fine for viewer — the entries
// themselves don't leak credentials, only their content does. These
// catches the most obvious credential paths but is not a security
// boundary: any operator can change file permissions in Phase 3, and the
// global denylist above is what actually protects the kernel.
var fsAdminReadPaths = []string{
	"/etc/shadow",
	"/etc/gshadow",
	"/etc/sudoers",
	"/etc/ssh",
	"/root",
}

// ErrPathDenied is returned when the resolved path is in the denylist.
var ErrPathDenied = errors.New("path is not accessible through the dashboard")

// ErrPathOutsideHost is returned when a path resolves outside /hostfs (so a
// crafted ".." can't escape into the outpost container's own filesystem).
var ErrPathOutsideHost = errors.New("path resolves outside the host filesystem")

// ErrAdminRequired is returned when the role check fails for a sensitive
// read.
var ErrAdminRequired = errors.New("admin role required for this path")

// ErrSpecialFile is returned when the resolved entry is a device, FIFO, or
// socket — we refuse to operate on those.
var ErrSpecialFile = errors.New("special files (devices, fifos, sockets) are not supported")

// toAbsHost takes a user-supplied path in the host's namespace and returns
// the absolute, cleaned host-relative form. Relative paths are rejected
// (we never have an implicit cwd here). Trailing slashes are dropped
// except for the root.
func toAbsHost(in string) (string, error) {
	if in == "" {
		return "", fmt.Errorf("empty path")
	}
	if !strings.HasPrefix(in, "/") {
		return "", fmt.Errorf("path must be absolute")
	}
	clean := filepath.Clean(in)
	if clean == "" {
		return "", fmt.Errorf("invalid path")
	}
	return clean, nil
}

// containerPath joins the host-relative path with the /hostfs prefix to
// give the path we actually pass to syscalls from inside the container.
func containerPath(hostAbs string) string {
	if hostAbs == "/" {
		return hostRoot
	}
	return hostRoot + hostAbs
}

// hostFromContainer strips the /hostfs prefix so paths returned to
// vantage-prime look like absolute paths on the host, not paths inside our
// container.
func hostFromContainer(containerAbs string) string {
	if containerAbs == hostRoot {
		return "/"
	}
	if rest, ok := strings.CutPrefix(containerAbs, hostRoot+"/"); ok {
		return "/" + rest
	}
	return containerAbs // shouldn't happen if we always feed it from containerPath
}

// pathInDenylist reports whether `hostAbs` is exactly a denied path or any
// descendant of one. Comparison is on cleaned absolute paths so trailing
// slashes / "." segments don't matter.
func pathInDenylist(hostAbs string) bool {
	return pathInAny(hostAbs, fsDenylist)
}

func pathInAdminReadList(hostAbs string) bool {
	return pathInAny(hostAbs, fsAdminReadPaths)
}

func pathInAny(hostAbs string, list []string) bool {
	for _, deny := range list {
		if hostAbs == deny {
			return true
		}
		if strings.HasPrefix(hostAbs, deny+"/") {
			return true
		}
	}
	return false
}

// FsOp categorises what we're about to do so resolveSafeName can apply
// the right rules.
type FsOp string

const (
	FsOpList     FsOp = "list"
	FsOpStat     FsOp = "stat"
	FsOpRead     FsOp = "read"     // file content
	FsOpDownload FsOp = "download" // raw stream
	FsOpWrite    FsOp = "write"
	FsOpMkdir    FsOp = "mkdir"
	FsOpRename   FsOp = "rename"
	FsOpDelete   FsOp = "delete"
	FsOpUpload   FsOp = "upload"
	FsOpCopy     FsOp = "copy"
	FsOpMove     FsOp = "move"
)

// rejectSpecialFile checks the dirent kind on a stat result and refuses
// FIFOs, sockets, character devices, and block devices. We accept dirs,
// regular files, and symlinks (which the caller will have resolved
// already via resolveSafe for ops that follow links).
func rejectSpecialFile(info os.FileInfo) error {
	mode := info.Mode()
	if mode.IsDir() || mode.IsRegular() {
		return nil
	}
	if mode&os.ModeSymlink != 0 {
		return nil
	}
	if mode&(os.ModeDevice|os.ModeCharDevice|os.ModeNamedPipe|os.ModeSocket) != 0 {
		return ErrSpecialFile
	}
	return nil
}

