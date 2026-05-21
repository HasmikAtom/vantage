package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// FirewallProvider is the dashboard's abstraction over whatever host-side
// firewall is in use. The first implementation targets ufw, but the surface
// is intentionally tool-agnostic so firewalld / raw nftables can slot in
// later without touching the HTTP layer.
//
// Delete identity: providers MUST delete by the canonical rule tuple
// (port/proto/direction/action/from/to/v6), not by any positional handle
// that may race with concurrent edits. List-then-delete-by-index inside the
// provider is fine as long as it's serialised under the provider's own lock.
type FirewallProvider interface {
	Name() string
	Status(ctx context.Context) (FirewallStatus, error)
	Add(ctx context.Context, rule FirewallRule) error
	Delete(ctx context.Context, rule FirewallRule) error
}

// ErrFirewallUnsupported is returned by handlers when no supported backend
// was detected on this host. The frontend surfaces this as a greyed-out
// section with an explanatory message.
var ErrFirewallUnsupported = errors.New("no supported firewall backend on this host")

// ErrFirewallRuleNotFound is returned by Delete when no rule matches the
// canonical tuple supplied by the caller — typically because someone else
// already removed it.
var ErrFirewallRuleNotFound = errors.New("firewall rule not found")

// detectFirewallProvider probes the host filesystem (via the existing
// /hostfs bind mount) for known firewall binaries and returns the first
// available provider. Returns nil when nothing is found — callers should
// treat that as "feature unavailable on this server" rather than an error.
//
// systemd-run must also be present inside our container, since that's how
// we dispatch the actual binary to run on the host. The Dockerfile installs
// the systemd package which provides it.
func detectFirewallProvider() FirewallProvider {
	if _, err := exec.LookPath("systemd-run"); err != nil {
		return nil
	}
	hostroot := os.Getenv("HOST_ROOT")
	if hostroot == "" {
		hostroot = "/hostfs"
	}
	candidates := []string{"/usr/sbin/ufw", "/sbin/ufw", "/usr/bin/ufw"}
	for _, p := range candidates {
		if _, err := os.Stat(filepath.Join(hostroot, p)); err == nil {
			return newUfwProvider(p)
		}
	}
	return nil
}

// runOnHost dispatches a command to be executed on the host (not inside our
// container) by asking the host's systemd to spawn a transient unit over
// the DBus socket. The unit inherits host namespaces and root privileges
// (default for system services), runs to completion, and the output is
// piped back to us synchronously via systemd-run's --pipe.
//
// argv[0] must be an absolute path that exists on the HOST — not in the
// container's filesystem.
//
// Why /usr/bin/env: systemd-run stats the ExecStart path against its OWN
// (the container's) filesystem before submitting the DBus call, so giving
// it a host-only path like /usr/sbin/ufw fails with "No such file or
// directory" before the unit ever reaches the host. /usr/bin/env exists
// in both the container and the host; the unit launches env on the host,
// which then exec()s the host path with its full PATH/argv. The exit code
// and combined output stream back through --pipe.
//
// We deliberately don't set StandardOutput=journal here — --pipe already
// claims the unit's stdout/stderr and an explicit property override would
// fight it. Unit lifecycle events (start, exit code) are still logged to
// journald by systemd itself, so the audit story isn't lost; the
// "vantage-fw-..." unit name prefix makes those rows easy to grep.
func runOnHost(ctx context.Context, unitTag string, argv []string) ([]byte, error) {
	if len(argv) == 0 {
		return nil, errors.New("runOnHost: empty argv")
	}
	if !strings.HasPrefix(argv[0], "/") {
		return nil, fmt.Errorf("runOnHost: %q must be an absolute host path", argv[0])
	}
	args := []string{
		"--pipe", "--wait", "--collect", "--quiet",
		"--unit", "vantage-fw-" + unitTag,
		"--", "/usr/bin/env",
	}
	args = append(args, argv...)
	cmd := exec.CommandContext(ctx, "systemd-run", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("host exec %v: %w (output: %s)", argv, err, strings.TrimSpace(string(out)))
	}
	return out, nil
}
