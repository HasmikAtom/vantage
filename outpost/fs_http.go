package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// queryPath pulls the `path` query parameter and rejects empty values
// with a 400 — every fs endpoint requires it.
func queryPath(r *http.Request) (string, error) {
	p := r.URL.Query().Get("path")
	if p == "" {
		return "", fmt.Errorf("missing path query parameter")
	}
	return p, nil
}

// fsErrorStatus maps internal error kinds to HTTP status codes. Keeps the
// handler bodies short.
func fsErrorStatus(err error) (int, string) {
	switch {
	case errors.Is(err, ErrPathDenied), errors.Is(err, ErrAdminRequired):
		return http.StatusForbidden, err.Error()
	case errors.Is(err, ErrPathOutsideHost):
		return http.StatusBadRequest, err.Error()
	case errors.Is(err, ErrSpecialFile):
		return http.StatusUnsupportedMediaType, err.Error()
	case os.IsNotExist(err):
		return http.StatusNotFound, err.Error()
	case os.IsPermission(err):
		return http.StatusForbidden, err.Error()
	case os.IsExist(err):
		return http.StatusConflict, err.Error()
	default:
		return http.StatusBadRequest, err.Error()
	}
}

func fsWriteErr(w http.ResponseWriter, err error) {
	status, msg := fsErrorStatus(err)
	writeErr(w, status, msg)
}

func fsListHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.list")
		in, err := queryPath(r)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, in)
		entries, hp, err := safeListDir(in, r.Header.Get(roleHeader))
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		parent := ""
		if hp != "/" {
			parent = filepath.Dir(hp)
		}
		writeJSON(w, FsListResponse{Path: hp, Parent: parent, Entries: entries})
	}
}

func fsStatHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.stat")
		in, err := queryPath(r)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, in)
		entry, _, err := safeStatEntry(in, r.Header.Get(roleHeader), FsOpStat)
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		writeJSON(w, entry)
	}
}

// fsReadHandler returns the file content as JSON {content, mode, mtime},
// size-capped to 1 MiB. For raw streaming downloads use fsDownloadHandler.
func fsReadHandler() http.HandlerFunc {
	const cap = 1 << 20 // 1 MiB
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.read")
		in, err := queryPath(r)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, in)
		f, hp, err := safeOpenForRead(in, r.Header.Get(roleHeader))
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		if err := rejectSpecialFile(info); err != nil {
			fsWriteErr(w, err)
			return
		}
		if !info.Mode().IsRegular() {
			writeErr(w, http.StatusBadRequest, "not a regular file")
			return
		}
		if info.Size() > cap {
			writeErr(w, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("file too large for text edit (%d > %d bytes)", info.Size(), cap))
			return
		}
		data, err := io.ReadAll(f)
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		writeJSON(w, map[string]any{
			"path":    hp,
			"size":    info.Size(),
			"mode":    uint32(info.Mode().Perm()),
			"mtime":   info.ModTime().Unix(),
			"content": string(data),
		})
	}
}

func fsDownloadHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.download")
		in, err := queryPath(r)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, in)
		f, hp, err := safeOpenForDownload(in, r.Header.Get(roleHeader))
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		if err := rejectSpecialFile(info); err != nil {
			fsWriteErr(w, err)
			return
		}
		if info.IsDir() {
			writeErr(w, http.StatusBadRequest, "downloading directories is not supported in Phase 1")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
		// RFC 5987-encode the filename so non-ASCII names survive.
		filename := filepath.Base(hp)
		w.Header().Set("Content-Disposition",
			fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`,
				strings.ReplaceAll(filename, `"`, `_`),
				url.PathEscape(filename),
			),
		)
		_, _ = io.Copy(w, f)
	}
}

func fsWriteHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.write")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		var body struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, body.Path)
		if _, err := safeWriteTextPreserving(body.Path, r.Header.Get(roleHeader), []byte(body.Content)); err != nil {
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}

func fsMkdirHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.mkdir")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		var body struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, body.Path)
		if _, err := safeMkdirInheritOwner(body.Path, r.Header.Get(roleHeader), 0o755); err != nil {
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}

func fsRenameHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.rename")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		var body struct {
			From string `json:"from"`
			To   string `json:"to"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, body.From+" -> "+body.To)
		role := r.Header.Get(roleHeader)
		// Validate both sides via Root; refuse to clobber an existing
		// destination (matches legacy fsRename — Phase 3 will add an
		// explicit overwrite flag if anyone wants it).
		dstRel, _, err := resolveSafeName(body.To, FsOpRename, role)
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		if _, err := hostRootHandle.Lstat(dstRel); err == nil {
			writeErr(w, http.StatusConflict, "destination exists")
			return
		}
		if _, _, err := safeRename(body.From, body.To, role); err != nil {
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}

// fsCopyHandler duplicates a host path. Body:
//
//	{from, to, overwrite?: bool, recursive?: bool}
//
// `to` is the FULL destination path (the same contract as fsRename —
// vantage-prime joins parent + new name). overwrite=false (the default)
// refuses an existing destination; recursive=true is required when
// copying a directory. Operator role gates the write.
func fsCopyHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.copy")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		var body struct {
			From      string `json:"from"`
			To        string `json:"to"`
			Overwrite bool   `json:"overwrite"`
			Recursive bool   `json:"recursive"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, body.From+" -> "+body.To)
		if _, _, err := safeCopy(body.From, body.To, r.Header.Get(roleHeader), copyOpts{
			Overwrite: body.Overwrite,
			Recursive: body.Recursive,
		}); err != nil {
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}

// fsMoveHandler relocates a host path. Body:
//
//	{from, to, overwrite?: bool}
//
// Uses the kernel rename on the same filesystem; transparently falls back
// to copy+delete on EXDEV. Unlike fsRenameHandler this endpoint accepts
// an `overwrite` flag so callers can opt into replacing an existing
// regular file destination — fsRename keeps the legacy strict no-clobber
// behaviour for back-compat. Operator role gates the write.
func fsMoveHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.move")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		var body struct {
			From      string `json:"from"`
			To        string `json:"to"`
			Overwrite bool   `json:"overwrite"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, body.From+" -> "+body.To)
		if _, _, err := safeMove(body.From, body.To, r.Header.Get(roleHeader), copyOpts{
			Overwrite: body.Overwrite,
		}); err != nil {
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}

// fsDeleteHandler does a soft-delete by default: moves the entry into the
// trash root with metadata so it can be restored. Phase 3 will add
// `?permanent=true` for an explicit, admin-gated bypass.
func fsDeleteHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.delete")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		in, err := queryPath(r)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, in)
		deletedBy := r.Header.Get("X-Vantage-User") // optional; gate proxy may pass through
		trashID, _, err := fsDeleteToTrashSafe(in, r.Header.Get(roleHeader), deletedBy)
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "trashId": trashID})
	}
}

// fsUploadHandler accepts a multipart upload with a single "file" part.
// The destination directory comes from the `path` query parameter (must
// exist); the destination filename comes from the part's filename. To
// upload with an explicit name use `?path=/dest/dir&name=newname`.
func fsUploadHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.upload")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		destDir, err := queryPath(r)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		role := r.Header.Get(roleHeader)
		// Multipart with a single "file" part. We don't buffer the body —
		// the part reader streams straight to the destination file via
		// MultipartReader. Do NOT call ParseMultipartForm here: passing 0
		// would force the entire body to spill to a temp file on disk
		// before we ever reach the streaming branch.
		mr, err := r.MultipartReader()
		if err != nil {
			writeErr(w, http.StatusBadRequest, "expected multipart body")
			return
		}
		part, err := mr.NextPart()
		if err != nil {
			writeErr(w, http.StatusBadRequest, "no file part: "+err.Error())
			return
		}
		defer part.Close()
		name := r.URL.Query().Get("name")
		if name == "" {
			name = part.FileName()
		}
		if name == "" || strings.ContainsAny(name, "/\x00") {
			writeErr(w, http.StatusBadRequest, "invalid filename")
			return
		}
		dstHost := filepath.Join(destDir, name)
		w.Header().Set(auditTargetHeader, dstHost)
		overwrite := r.URL.Query().Get("overwrite") == "true"
		n, _, err := safeUpload(dstHost, role, part, overwrite)
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "bytes": n})
	}
}

// fsReceiveHandler is the server-to-server destination endpoint used by
// the cross-outpost transfer relay. Unlike fsUploadHandler it expects the
// REQUEST BODY to BE the file content (no multipart wrapper), which makes
// the relaying path in the gate service a straight stream-to-stream pipe
// with no buffering or boundary parsing.
//
// `?path=` is the full destination path (parent dir must exist).
// `?overwrite=true` allows clobbering an existing file.
//
// Same role/audit/safety contract as fsUploadHandler.
func fsReceiveHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.receive")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		dst, err := queryPath(r)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, dst)
		overwrite := r.URL.Query().Get("overwrite") == "true"
		n, _, err := safeUpload(dst, r.Header.Get(roleHeader), r.Body, overwrite)
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "bytes": n})
	}
}

// fsTrashListHandler returns every retained trash entry. Operator role
// is sufficient — the listing only reveals paths the user already deleted
// or can re-delete; admin gating here would be friction without payoff.
func fsTrashListHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.trash.list")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		items, err := listTrash()
		if err != nil {
			fsWriteErr(w, err)
			return
		}
		writeJSON(w, items)
	}
}

// fsTrashRestoreHandler puts a trashed entry back at its original path.
// Body: {trashId, overwrite}. Returns 409 if the destination exists and
// overwrite is false. The destination is routed through resolveSafeName
// + the openat2-anchored rename helpers so a restore can't slip content
// into a denylisted location, outside the host root, or via a symlink
// swap on a parent dir — even if the trash record was hand-crafted.
func fsTrashRestoreHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.trash.restore")
		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		var body struct {
			TrashID   string `json:"trashId"`
			Overwrite bool   `json:"overwrite"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		if body.TrashID == "" {
			writeErr(w, http.StatusBadRequest, "trashId required")
			return
		}
		w.Header().Set(auditTargetHeader, body.TrashID)
		dst, err := restoreTrash(body.TrashID, body.Overwrite, r.Header.Get(roleHeader))
		if err != nil {
			if errors.Is(err, ErrTrashRestoreConflict) {
				writeErr(w, http.StatusConflict, err.Error())
				return
			}
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "restoredTo": dst})
	}
}

// fsTrashPermanentDeleteHandler wipes a trash entry from disk with no
// undo. Admin role required — operator can only soft-delete (already
// covered by the standard /fs/entry DELETE).
func fsTrashPermanentDeleteHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.trash.permanent")
		if !roleAtLeast(roleAdmin, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "admin role required")
			return
		}
		id := r.PathValue("id")
		w.Header().Set(auditTargetHeader, id)
		if err := permanentDeleteTrash(id); err != nil {
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}

// fsChmodHandler — admin-only. Body: {path, mode} where mode is an
// integer or octal-prefixed string (we accept both).
func fsChmodHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.chmod")
		if !roleAtLeast(roleAdmin, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "admin role required")
			return
		}
		var body struct {
			Path string `json:"path"`
			// Mode is parsed manually below so we can accept "0755", "755", or 493.
			Mode json.RawMessage `json:"mode"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		mode, err := parseMode(body.Mode)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, body.Path+" "+fmt.Sprintf("%#o", mode))
		if _, err := safeChmod(body.Path, r.Header.Get(roleHeader), mode); err != nil {
			fsWriteErr(w, err)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}

// parseMode accepts a JSON number (treated as raw octal-or-decimal —
// see the docstring), or a string like "0755"/"755" parsed as octal.
// Always returns a FileMode with at most the perm + sticky/setuid/setgid
// bits set; higher bits are masked off so a malformed input can't
// accidentally request a directory bit.
func parseMode(raw json.RawMessage) (os.FileMode, error) {
	s := string(raw)
	if s == "" || s == "null" {
		return 0, fmt.Errorf("mode required")
	}
	// JSON string: strip quotes and parse as octal.
	if s[0] == '"' {
		var str string
		if err := json.Unmarshal(raw, &str); err != nil {
			return 0, fmt.Errorf("mode: %w", err)
		}
		str = strings.TrimSpace(str)
		base := 10
		if strings.HasPrefix(str, "0o") || strings.HasPrefix(str, "0O") {
			str = str[2:]
			base = 8
		} else if strings.HasPrefix(str, "0") && len(str) > 1 {
			base = 8
		} else if len(str) <= 4 && allOctalDigits(str) {
			// Bare 3-4 digit form like "644" → octal by convention.
			base = 8
		}
		n, err := strconv.ParseUint(str, base, 32)
		if err != nil {
			return 0, fmt.Errorf("mode %q: %w", str, err)
		}
		return os.FileMode(n) & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky), nil
	}
	// JSON number.
	var n uint32
	if err := json.Unmarshal(raw, &n); err != nil {
		return 0, fmt.Errorf("mode: %w", err)
	}
	return os.FileMode(n) & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky), nil
}

func allOctalDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '7' {
			return false
		}
	}
	return true
}

// fsChownHandler — admin-only. Body: {path, owner?, group?, recursive?}.
// Either of owner/group can be omitted to leave that side alone.
func fsChownHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "fs.chown")
		if !roleAtLeast(roleAdmin, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "admin role required")
			return
		}
		var body struct {
			Path      string `json:"path"`
			Owner     string `json:"owner"`
			Group     string `json:"group"`
			Recursive bool   `json:"recursive"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, body.Path+" "+body.Owner+":"+body.Group)
		uid, gid, err := resolveOwnerGroup(body.Owner, body.Group)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		role := r.Header.Get(roleHeader)
		if body.Recursive {
			if _, err := safeChownRecursive(body.Path, role, uid, gid); err != nil {
				fsWriteErr(w, err)
				return
			}
		} else {
			if _, err := safeLchown(body.Path, role, uid, gid); err != nil {
				fsWriteErr(w, err)
				return
			}
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}
}
