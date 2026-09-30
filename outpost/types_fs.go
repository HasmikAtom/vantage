package main

// FsEntry is one item in a directory listing or a stat response. Paths are
// host-relative — the /hostfs prefix the outpost uses internally is stripped
// before serializing, so vantage-prime works in the host's own namespace.
type FsEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`            // canonical, absolute (host-relative)
	Type      string `json:"type"`            // "dir" | "file" | "symlink" | "other"
	Size      int64  `json:"size"`
	Mode      uint32 `json:"mode"`            // permission bits (octal)
	ModeStr   string `json:"modeStr"`         // "drwxr-xr-x" style
	Owner     string `json:"owner"`           // resolved user name (fallback: uid as string)
	Group     string `json:"group"`
	UID       uint32 `json:"uid"`
	GID       uint32 `json:"gid"`
	Mtime     int64  `json:"mtime"`           // unix seconds
	IsSymlink bool   `json:"isSymlink,omitempty"`
	Target    string `json:"target,omitempty"` // raw link target as stored on disk
	Broken    bool   `json:"broken,omitempty"` // symlink whose target doesn't resolve
}

// FsListResponse is the body of GET /fs/list.
type FsListResponse struct {
	Path    string    `json:"path"`    // canonical path of the directory listed
	Parent  string    `json:"parent"`  // parent directory, or "" if Path is "/"
	Entries []FsEntry `json:"entries"`
}
