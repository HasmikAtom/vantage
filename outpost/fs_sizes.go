package main

import (
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
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

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

// sizeCache is a small TTL + LRU map of completed walks keyed by host
// path. Any successful fs mutation clears it entirely (invalidatesSizes);
// mutations are rare next to browsing, so per-path invalidation is not
// worth its complexity.
type sizeCache struct {
	mu  sync.Mutex
	ttl time.Duration
	max int
	ll  *list.List
	m   map[string]*list.Element
	now func() time.Time
}

type sizeCacheEntry struct {
	res dirSizeResult
	at  time.Time
}

func newSizeCache(ttl time.Duration, max int) *sizeCache {
	return &sizeCache{ttl: ttl, max: max, ll: list.New(), m: map[string]*list.Element{}, now: time.Now}
}

func (c *sizeCache) get(path string) (dirSizeResult, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.m[path]
	if !ok {
		return dirSizeResult{}, false
	}
	e := el.Value.(*sizeCacheEntry)
	if c.now().Sub(e.at) > c.ttl {
		c.ll.Remove(el)
		delete(c.m, path)
		return dirSizeResult{}, false
	}
	c.ll.MoveToFront(el)
	return e.res, true
}

func (c *sizeCache) put(r dirSizeResult) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.m[r.Path]; ok {
		el.Value = &sizeCacheEntry{res: r, at: c.now()}
		c.ll.MoveToFront(el)
		return
	}
	c.m[r.Path] = c.ll.PushFront(&sizeCacheEntry{res: r, at: c.now()})
	for c.ll.Len() > c.max {
		last := c.ll.Back()
		c.ll.Remove(last)
		delete(c.m, last.Value.(*sizeCacheEntry).res.Path)
	}
}

func (c *sizeCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ll.Init()
	c.m = map[string]*list.Element{}
}

func (c *sizeCache) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}

var dirSizeCache = newSizeCache(5*time.Minute, 5000)

// sizeWalkSem caps concurrent walks across every open stream so a few
// browser tabs cannot saturate the host's disk.
var sizeWalkSem = make(chan struct{}, 4)

const sizeWalkersPerStream = 2

// ---------------------------------------------------------------------------
// GET /fs/sizes?path=<dir>  (SSE)
// ---------------------------------------------------------------------------

// fsSizesHandler streams one event per immediate subdirectory of path,
// cached results first, then `event: done`. Denylisted and failing
// children are omitted. The walk stops when the client disconnects.
func fsSizesHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.sizes")
		in, err := queryPath(r)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, in)
		entries, _, err := safeListDir(in, r.Header.Get(roleHeader))
		if err != nil {
			fsWriteErr(w, err)
			return
		}

		rc := http.NewResponseController(w)
		_ = rc.SetWriteDeadline(time.Time{})
		h := w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		h.Set("Connection", "keep-alive")
		h.Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)

		emit := func(res dirSizeResult) {
			b, _ := json.Marshal(res)
			_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
			_ = rc.Flush()
		}

		var todo []string
		for _, e := range entries {
			if e.Type != "dir" || pathInDenylist(e.Path) {
				continue
			}
			if res, ok := dirSizeCache.get(e.Path); ok {
				emit(res)
				continue
			}
			todo = append(todo, e.Path)
		}

		ctx := r.Context()
		jobs := make(chan string)
		results := make(chan dirSizeResult)
		var wg sync.WaitGroup
		for i := 0; i < sizeWalkersPerStream; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for p := range jobs {
					select {
					case sizeWalkSem <- struct{}{}:
					case <-ctx.Done():
						continue
					}
					res, err := walkDirSize(ctx, p, defaultSizeLimits)
					<-sizeWalkSem
					if err != nil {
						continue
					}
					dirSizeCache.put(res)
					select {
					case results <- res:
					case <-ctx.Done():
					}
				}
			}()
		}
		go func() {
			defer close(jobs)
			for _, p := range todo {
				select {
				case jobs <- p:
				case <-ctx.Done():
					return
				}
			}
		}()
		go func() {
			wg.Wait()
			close(results)
		}()

		keepalive := time.NewTicker(25 * time.Second)
		defer keepalive.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case res, ok := <-results:
				if !ok {
					if ctx.Err() != nil {
						return
					}
					_, _ = io.WriteString(w, "event: done\ndata: {}\n\n")
					_ = rc.Flush()
					return
				}
				emit(res)
			case <-keepalive.C:
				_, _ = io.WriteString(w, ": keepalive\n\n")
				_ = rc.Flush()
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

// statusCapture records the status code a handler wrote.
type statusCapture struct {
	http.ResponseWriter
	status int
}

func (s *statusCapture) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusCapture) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// invalidatesSizes wraps a mutating fs handler: when it succeeds the
// folder-size cache is dropped so the next stream re-walks.
func invalidatesSizes(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sc := &statusCapture{ResponseWriter: w, status: http.StatusOK}
		h(sc, r)
		if sc.status < 400 {
			dirSizeCache.clear()
		}
	}
}
