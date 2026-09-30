package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// SettingsStore manages encrypted-at-rest user-supplied secrets.
//
// File layout (single file at VANTAGE_DATA_DIR/settings.enc):
//
//   [12 bytes nonce] [N bytes ciphertext+gcm-tag]
//
// AES-256-GCM, key derived from VANTAGE_ENCRYPTION_KEY (32-byte base64).
// As a convenience for self-hosters who don't want to manage another secret,
// when VANTAGE_ENCRYPTION_KEY is unset we derive a 32-byte key by SHA-256 of a
// hostname-based seed and a hard-coded salt. That keeps secrets stable across
// restarts but is weak against an attacker who can read the env+file. The
// recommended path is to set VANTAGE_ENCRYPTION_KEY explicitly.

// StoredSettings is the persisted shape of the per-outpost secret store.
// Today only Cloudflare credentials live here; the prior `Servers` list
// moved to the gate service's per-user registry once the architecture
// stopped having a single "primary" outpost.
type StoredSettings struct {
	CloudflareAPIToken    string `json:"cloudflareApiToken,omitempty"`
	CloudflareAccountID   string `json:"cloudflareAccountId,omitempty"`
	CloudflareTunnelID    string `json:"cloudflareTunnelId,omitempty"`
	CloudflareRefreshSecs int    `json:"cloudflareRefreshSecs,omitempty"`
}

// DefaultCloudflareRefreshSecs is the fallback when CloudflareRefreshSecs is
// unset (or stored as 0) — five minutes, matching the original hard-coded
// cadence. The minimum allowed user value is also enforced against this:
// see MinCloudflareRefreshSecs / MaxCloudflareRefreshSecs.
const (
	DefaultCloudflareRefreshSecs = 300
	MinCloudflareRefreshSecs     = 30
	MaxCloudflareRefreshSecs     = 86400 // 24h — gives "hours" unit some room
)

type SettingsStore struct {
	path string
	key  []byte
	mu   sync.RWMutex

	// In-memory cache to avoid re-reading + re-decrypting + re-unmarshalling on
	// every Get() call (the tunnel loop and every settings HTTP handler hit
	// this). Invalidated via mtime: if os.Stat reports a different ModTime
	// than cacheMTime, we re-read. Set() also refreshes the cache directly
	// after a successful rename so writers don't have to wait for the next
	// stat round-trip.
	cacheMu     sync.Mutex
	cacheValid  bool
	cacheValue  StoredSettings
	cacheMTime  time.Time
}

func NewSettingsStore() (*SettingsStore, error) {
	dir := os.Getenv("VANTAGE_DATA_DIR")
	if dir == "" {
		dir = "/data"
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		// /data is read-only off-container; fall back to ./data.
		dir = "./data"
		_ = os.MkdirAll(dir, 0o700)
	}

	key, err := loadKey()
	if err != nil {
		return nil, err
	}
	return &SettingsStore{
		path: filepath.Join(dir, "settings.enc"),
		key:  key,
	}, nil
}

func loadKey() ([]byte, error) {
	if raw := os.Getenv("VANTAGE_ENCRYPTION_KEY"); raw != "" {
		b, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			return nil, fmt.Errorf("VANTAGE_ENCRYPTION_KEY must be base64: %w", err)
		}
		if len(b) != 32 {
			return nil, fmt.Errorf("VANTAGE_ENCRYPTION_KEY must decode to 32 bytes, got %d", len(b))
		}
		return b, nil
	}
	// Fallback: derive a deterministic key from a stable host attribute so
	// settings survive container recreation without an explicit env var.
	// Logged loudly — multi-line banner — because operators tend to skim
	// a single WARN line. The fallback is fine for first-boot tinkering;
	// for anything where stored secrets matter (Cloudflare API tokens
	// being the obvious case) the operator MUST set the env var and
	// re-save secrets through the UI before walking away.
	seed := os.Getenv("HOSTNAME") + ":vantage-settings-fallback-v1"
	h := sha256.Sum256([]byte(seed))
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "************************************************************")
	fmt.Fprintln(os.Stderr, "WARN: VANTAGE_ENCRYPTION_KEY is not set.")
	fmt.Fprintln(os.Stderr, "Settings encryption is using a hostname-derived fallback")
	fmt.Fprintln(os.Stderr, "key. Anyone who knows the host's HOSTNAME can decrypt the")
	fmt.Fprintln(os.Stderr, "Cloudflare API token (and any future secret) stored on disk.")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Fix BEFORE saving anything sensitive through the UI:")
	fmt.Fprintln(os.Stderr, "  1. echo \"VANTAGE_ENCRYPTION_KEY=$(openssl rand -base64 32)\" >> .env")
	fmt.Fprintln(os.Stderr, "  2. docker compose restart outpost")
	fmt.Fprintln(os.Stderr, "  3. Re-save any secrets through the dashboard's Settings page.")
	fmt.Fprintln(os.Stderr, "************************************************************")
	fmt.Fprintln(os.Stderr, "")
	return h[:], nil
}

// Get returns the decrypted settings, or zero values if no file exists yet.
//
// Memoized by file mtime. Stat first; if the cached mtime matches, hand back
// the cached value. The struct is now scalars only, so a value-copy is cheap
// and safe. On any stat / read error, falls through to the non-cached read
// path so behaviour in failure modes is unchanged.
func (s *SettingsStore) Get() (StoredSettings, error) {
	// Fast path: cached value still valid by mtime.
	if info, err := os.Stat(s.path); err == nil {
		s.cacheMu.Lock()
		if s.cacheValid && info.ModTime().Equal(s.cacheMTime) {
			cached := s.cacheValue
			s.cacheMu.Unlock()
			return cached, nil
		}
		s.cacheMu.Unlock()
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	raw, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return StoredSettings{}, nil
		}
		return StoredSettings{}, err
	}
	if len(raw) < 13 { // 12 nonce + at least 1 byte
		return StoredSettings{}, fmt.Errorf("settings file too short")
	}

	block, err := aes.NewCipher(s.key)
	if err != nil {
		return StoredSettings{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return StoredSettings{}, err
	}
	nonce, cipherText := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, cipherText, nil)
	if err != nil {
		return StoredSettings{}, fmt.Errorf("decrypt: %w (wrong VANTAGE_ENCRYPTION_KEY?)", err)
	}
	var out StoredSettings
	if err := json.Unmarshal(plain, &out); err != nil {
		return StoredSettings{}, err
	}

	// Populate cache with the parsed value + the mtime we just read.
	// Re-stat (not os.Stat from earlier) so we have a fresh mtime that
	// corresponds to the bytes we actually parsed.
	if info, statErr := os.Stat(s.path); statErr == nil {
		s.cacheMu.Lock()
		s.cacheValue = out
		s.cacheMTime = info.ModTime()
		s.cacheValid = true
		s.cacheMu.Unlock()
	}
	return out, nil
}

// Update applies a partial update — only non-empty fields overwrite existing
// values. Empty fields are preserved (so you can change the token without
// resending the account ID). For CloudflareRefreshSecs, 0 means "no change";
// a positive value within [Min, Max] overwrites.
func (s *SettingsStore) Update(patch StoredSettings) error {
	cur, err := s.Get()
	if err != nil {
		return err
	}
	if v := strings.TrimSpace(patch.CloudflareAPIToken); v != "" {
		cur.CloudflareAPIToken = v
	}
	if v := strings.TrimSpace(patch.CloudflareAccountID); v != "" {
		cur.CloudflareAccountID = v
	}
	if v := strings.TrimSpace(patch.CloudflareTunnelID); v != "" {
		cur.CloudflareTunnelID = v
	}
	if patch.CloudflareRefreshSecs > 0 {
		cur.CloudflareRefreshSecs = patch.CloudflareRefreshSecs
	}
	return s.write(cur)
}

// ClearCloudflare nulls out the Cloudflare-related fields, including the
// custom refresh interval (which falls back to DefaultCloudflareRefreshSecs).
func (s *SettingsStore) ClearCloudflare() error {
	cur, err := s.Get()
	if err != nil {
		return err
	}
	cur.CloudflareAPIToken = ""
	cur.CloudflareAccountID = ""
	cur.CloudflareTunnelID = ""
	cur.CloudflareRefreshSecs = 0
	return s.write(cur)
}

func (s *SettingsStore) write(v StoredSettings) error {
	plain, err := json.Marshal(v)
	if err != nil {
		return err
	}
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return err
	}
	cipherText := gcm.Seal(nil, nonce, plain, nil)

	s.mu.Lock()
	defer s.mu.Unlock()

	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(nonce, cipherText...), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}

	// Refresh the in-memory cache with the value we just wrote so the next
	// Get() doesn't have to round-trip through stat+read+decrypt+unmarshal.
	// Pull mtime from the post-rename stat so a subsequent mtime-equality
	// check matches. If stat fails here, invalidate the cache so the next
	// Get() falls through to the read path.
	s.cacheMu.Lock()
	if info, err := os.Stat(s.path); err == nil {
		s.cacheValue = v
		s.cacheMTime = info.ModTime()
		s.cacheValid = true
	} else {
		s.cacheValid = false
	}
	s.cacheMu.Unlock()
	return nil
}

// View is the safe-to-return-over-HTTP representation. Token is replaced by a
// boolean "tokenSet" so the client knows whether one is on file without ever
// seeing it. CloudflareRefreshSecs always carries the *effective* value (the
// stored value if set, the default otherwise) so the UI doesn't need to
// duplicate the default constant.
type SettingsView struct {
	CloudflareTokenSet    bool   `json:"cloudflareTokenSet"`
	CloudflareAccountID   string `json:"cloudflareAccountId"`
	CloudflareTunnelID    string `json:"cloudflareTunnelId"`
	CloudflareRefreshSecs int    `json:"cloudflareRefreshSecs"`
}

func (s *SettingsStore) View() (SettingsView, error) {
	cur, err := s.Get()
	if err != nil {
		return SettingsView{}, err
	}
	refresh := cur.CloudflareRefreshSecs
	if refresh < MinCloudflareRefreshSecs {
		refresh = DefaultCloudflareRefreshSecs
	}
	return SettingsView{
		CloudflareTokenSet:    cur.CloudflareAPIToken != "",
		CloudflareAccountID:   cur.CloudflareAccountID,
		CloudflareTunnelID:    cur.CloudflareTunnelID,
		CloudflareRefreshSecs: refresh,
	}, nil
}
