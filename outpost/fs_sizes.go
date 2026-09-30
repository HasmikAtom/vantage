package main

import (
	"context"
	"errors"
	"os"
	"syscall"
	"time"
)

// fs_sizes.go computes recursive folder sizes for the Files tab. The
// listing endpoint stays instant; the SPA opens GET /fs/sizes after it
// and fills folder sizes in as each walk finishes.
//
// Walk rules (see the explorer design spec):
//   - every access goes through hostRootHandle, symlinks are never
//     followed (Lstat only, symlinks are neither counted nor descended);
//   - one filesystem per walk (du -x): subdirectories on another device
//     are skipped, so an NFS or USB mount under a folder is not walked;
//   - denylisted host paths (/proc, /sys, /var/lib/docker, …) are skipped;
//   - apparent size (st_size) of regular files, hard links counted once;
//   - capped by wall time and entries visited → Partial.

type dirSizeResult struct {
	Path    string `json:"path"`
	Bytes   int64  `json:"bytes"`
	Files   int64  `json:"files"`
	Partial bool   `json:"partial"`
}

type sizeLimits struct {
	MaxDuration time.Duration
	MaxEntries  int64
}

var defaultSizeLimits = sizeLimits{MaxDuration: 10 * time.Second, MaxEntries: 2_000_000}

type fileID struct{ dev, ino uint64 }

// statIDs extracts device, inode and link count. A var so tests can
// simulate a mount boundary without needing root to mount anything.
var statIDs = func(fi os.FileInfo) (dev, ino, nlink uint64, ok bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, 0, false
	}
	return uint64(st.Dev), uint64(st.Ino), uint64(st.Nlink), true
}

// walkDirSize sums the regular files under hostPath. It returns
// ctx.Err() when the caller goes away, and a Partial result (not an
// error) when a cap is hit. Unreadable subdirectories are skipped.
func walkDirSize(ctx context.Context, hostPath string, lim sizeLimits) (dirSizeResult, error) {
	res := dirSizeResult{Path: hostPath}
	if err := ctx.Err(); err != nil {
		return res, err
	}
	rel := toRootRel(hostPath)
	info, err := hostRootHandle.Lstat(rel)
	if err != nil {
		return res, err
	}
	if !info.IsDir() {
		return res, errors.New("not a directory")
	}
	rootDev, rootIno, _, ok := statIDs(info)
	if !ok {
		return res, errors.New("no stat data")
	}

	deadline := time.Now().Add(lim.MaxDuration)
	seenFiles := map[fileID]struct{}{}
	seenDirs := map[fileID]struct{}{{rootDev, rootIno}: {}}
	type dir struct{ rel, host string }
	stack := []dir{{rel, hostPath}}
	var visited int64

	for len(stack) > 0 {
		if err := ctx.Err(); err != nil {
			return res, err
		}
		if time.Now().After(deadline) {
			res.Partial = true
			return res, nil
		}
		d := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		f, err := hostRootHandle.Open(d.rel)
		if err != nil {
			continue
		}
		names, _ := f.Readdirnames(-1)
		_ = f.Close()

		for _, n := range names {
			if visited >= lim.MaxEntries {
				res.Partial = true
				return res, nil
			}
			visited++
			if visited%1024 == 0 {
				if err := ctx.Err(); err != nil {
					return res, err
				}
				if time.Now().After(deadline) {
					res.Partial = true
					return res, nil
				}
			}
			cHost := joinHostPath(d.host, n)
			if pathInDenylist(cHost) {
				continue
			}
			cRel := joinRootRel(d.rel, n)
			ci, err := hostRootHandle.Lstat(cRel)
			if err != nil {
				continue
			}
			dev, ino, nlink, ok := statIDs(ci)
			if !ok {
				continue
			}
			switch {
			case ci.Mode().IsRegular():
				if nlink > 1 {
					k := fileID{dev, ino}
					if _, dup := seenFiles[k]; dup {
						continue
					}
					seenFiles[k] = struct{}{}
				}
				res.Bytes += ci.Size()
				res.Files++
			case ci.IsDir():
				if dev != rootDev {
					continue
				}
				k := fileID{dev, ino}
				if _, dup := seenDirs[k]; dup {
					continue
				}
				seenDirs[k] = struct{}{}
				stack = append(stack, dir{cRel, cHost})
			}
		}
	}
	return res, nil
}
