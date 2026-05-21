package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// cloudflareClient talks to the Cloudflare REST API to list tunnel routes.
//
// Credential resolution (per request, so live UI edits take effect on the
// next refresh tick without restarting the container):
//   1. If a SettingsStore is attached and the user saved values via the
//      Settings page, use those.
//   2. Otherwise fall back to environment variables:
//        CLOUDFLARE_API_TOKEN   scope: Account → Cloudflare Tunnel: Read
//        CLOUDFLARE_ACCOUNT_ID  32 hex chars
//        CLOUDFLARE_TUNNEL_ID   optional, picks the first tunnel if empty
type cloudflareClient struct {
	settings *SettingsStore
	http     *http.Client
}

func newCloudflareClient(store *SettingsStore) *cloudflareClient {
	return &cloudflareClient{
		settings: store,
		http:     &http.Client{Timeout: 10 * time.Second},
	}
}

// creds returns (token, accountID, tunnelID), preferring stored settings.
func (c *cloudflareClient) creds() (token, accountID, tunnelID string) {
	if c.settings != nil {
		if s, err := c.settings.Get(); err == nil {
			token = s.CloudflareAPIToken
			accountID = s.CloudflareAccountID
			tunnelID = s.CloudflareTunnelID
		}
	}
	if token == "" {
		token = os.Getenv("CLOUDFLARE_API_TOKEN")
	}
	if accountID == "" {
		accountID = os.Getenv("CLOUDFLARE_ACCOUNT_ID")
	}
	if tunnelID == "" {
		tunnelID = os.Getenv("CLOUDFLARE_TUNNEL_ID")
	}
	return
}

type cfResp struct {
	Success bool              `json:"success"`
	Errors  []json.RawMessage `json:"errors"`
	Result  json.RawMessage   `json:"result"`
}

func (c *cloudflareClient) call(ctx context.Context, token, path string, out any) error {
	u := "https://api.cloudflare.com/client/v4" + path
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("cloudflare %s: %d: %s", path, resp.StatusCode, body)
	}
	var env cfResp
	if err := json.Unmarshal(body, &env); err != nil {
		return fmt.Errorf("cloudflare %s: parse envelope: %w", path, err)
	}
	if !env.Success {
		return fmt.Errorf("cloudflare %s: api errors: %s", path, env.Errors)
	}
	if out != nil {
		return json.Unmarshal(env.Result, out)
	}
	return nil
}

type cfTunnel struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Status      string    `json:"status"`
	Connections []struct {
		ID string `json:"id"`
	} `json:"connections"`
	CreatedAt time.Time `json:"created_at"`
	DeletedAt time.Time `json:"deleted_at"`
}

type cfIngress struct {
	Hostname      string `json:"hostname"`
	Service       string `json:"service"`
	OriginRequest struct {
		ConnectTimeout string `json:"connectTimeout"`
	} `json:"originRequest"`
}

type cfConfig struct {
	Config struct {
		Ingress       []cfIngress       `json:"ingress"`
		OriginRequest map[string]string `json:"originRequest"`
		WarpRouting   struct {
			Enabled bool `json:"enabled"`
		} `json:"warp-routing"`
	} `json:"config"`
}

// fetchTunnels returns ingress routes from the account's tunnels.
// - If CLOUDFLARE_TUNNEL_ID (or the Settings-stored Tunnel ID) is set, only
//   that tunnel's routes are returned.
// - Otherwise every non-deleted tunnel in the account is fetched and their
//   routes are concatenated, each carrying TunnelID + TunnelName so the SPA
//   can group them.
func (c *cloudflareClient) fetchTunnels(ctx context.Context) ([]Tunnel, error) {
	token, accountID, tunnelID := c.creds()
	if token == "" || accountID == "" {
		return nil, errors.New("Cloudflare credentials not configured (set them in Settings or via env)")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	tunnels, err := c.listTunnels(ctx, token, accountID)
	if err != nil {
		return nil, err
	}
	if len(tunnels) == 0 {
		return nil, nil
	}

	var selected []cfTunnel
	if tunnelID != "" {
		for _, t := range tunnels {
			if t.ID == tunnelID {
				selected = []cfTunnel{t}
				break
			}
		}
		if len(selected) == 0 {
			return nil, fmt.Errorf("tunnel %s not found in account", tunnelID)
		}
	} else {
		selected = tunnels
	}

	var out []Tunnel
	for _, t := range selected {
		cfg, err := c.getConfig(ctx, token, accountID, t.ID)
		if err != nil {
			// Don't drop the whole list because one tunnel's config request
			// failed — log and skip so the user still sees the rest.
			log.Printf("tunnel %s (%s) config fetch failed: %v", t.Name, t.ID, err)
			continue
		}
		overall := t.Status // "healthy" | "down" | "degraded" | "inactive"
		if overall == "" {
			overall = "healthy"
		}
		idx := 1
		for _, ing := range cfg.Config.Ingress {
			if ing.Hostname == "" {
				continue // the "service: http_status:404" catch-all
			}
			out = append(out, Tunnel{
				ID:         t.ID + "-r" + strconv.Itoa(idx),
				TunnelID:   t.ID,
				TunnelName: t.Name,
				Hostname:   ing.Hostname,
				Service:    ing.Service,
				Target:     targetFromService(ing.Service),
				Origin:     originFromService(ing.Service),
				Status:     overall,
			})
			idx++
		}
	}
	return out, nil
}

func (c *cloudflareClient) listTunnels(ctx context.Context, token, accountID string) ([]cfTunnel, error) {
	path := fmt.Sprintf("/accounts/%s/cfd_tunnel?is_deleted=false&per_page=50",
		url.PathEscape(accountID))
	var out []cfTunnel
	if err := c.call(ctx, token, path, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *cloudflareClient) getConfig(ctx context.Context, token, accountID, tunnelID string) (*cfConfig, error) {
	path := fmt.Sprintf("/accounts/%s/cfd_tunnel/%s/configurations",
		url.PathEscape(accountID), url.PathEscape(tunnelID))
	var out cfConfig
	if err := c.call(ctx, token, path, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func targetFromService(svc string) string {
	// "http://obsidian:3000" -> "obsidian"; "ssh://localhost:22" -> "ssh-host"
	s := svc
	for _, prefix := range []string{"http://", "https://", "tcp://", "ssh://", "rdp://", "unix:"} {
		s = strings.TrimPrefix(s, prefix)
	}
	if i := strings.IndexByte(s, '/'); i >= 0 {
		s = s[:i]
	}
	if i := strings.IndexByte(s, ':'); i >= 0 {
		s = s[:i]
	}
	if s == "localhost" || s == "127.0.0.1" {
		return strings.TrimPrefix(strings.SplitN(svc, "://", 2)[0], "") + "-host"
	}
	return s
}

func originFromService(svc string) string {
	// localhost ingress = served by something on the host; otherwise it's a docker bridge name.
	if strings.Contains(svc, "localhost") || strings.Contains(svc, "127.0.0.1") {
		return "host"
	}
	return "docker"
}
