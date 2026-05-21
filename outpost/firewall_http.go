package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// firewallStatusHandler returns the current firewall snapshot
// (backend name, active state, default policy, rule list). When no
// supported backend was detected on this host we return a 200 with
// available=false so the frontend can render a friendly placeholder
// instead of a generic error.
//
// Auth: viewer is sufficient — listing rules is read-only.
func firewallStatusHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "firewall.status")
		if m.firewall == nil {
			writeJSON(w, FirewallStatus{Available: false, Rules: []FirewallRule{}})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		st, err := m.firewall.Status(ctx)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, st)
	}
}

// firewallAddHandler creates a new rule. Body shape mirrors FirewallRule
// (port/proto/direction/action/from/to/v6/comment). Operator role required.
//
// Validation is layered: the JSON decoder picks up obvious junk; the
// provider's buildUfwAddArgs() does strict per-field checks (port range,
// proto whitelist, CIDR parse, etc.) before any host call. We never build
// a shell string — argv is passed as a vector through systemd-run.
func firewallAddHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "firewall.add")

		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		if m.firewall == nil {
			writeErr(w, http.StatusServiceUnavailable, ErrFirewallUnsupported.Error())
			return
		}

		var rule FirewallRule
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&rule); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, firewallAuditTarget(rule))

		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		if err := m.firewall.Add(ctx, rule); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "action": "add"})
	}
}

// firewallDeleteHandler removes a rule by canonical tuple. The full
// FirewallRule comes in the body — the provider's Delete walks the
// numbered rule list under its own mutex to find the matching row and
// issues the indexed delete atomically with respect to other operations
// through this dashboard.
//
// We deliberately don't accept a positional index from the client: the
// index a user sees can shift between read and write if another operator
// edits the firewall first, and acting on a stale index could remove the
// wrong rule.
func firewallDeleteHandler(m *Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(auditActionHeader, "firewall.delete")

		if !roleAtLeast(roleOperator, r.Header.Get(roleHeader)) {
			writeErr(w, http.StatusForbidden, "insufficient role")
			return
		}
		if m.firewall == nil {
			writeErr(w, http.StatusServiceUnavailable, ErrFirewallUnsupported.Error())
			return
		}

		var rule FirewallRule
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&rule); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		w.Header().Set(auditTargetHeader, firewallAuditTarget(rule))

		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		if err := m.firewall.Delete(ctx, rule); err != nil {
			if errors.Is(err, ErrFirewallRuleNotFound) {
				writeErr(w, http.StatusNotFound, err.Error())
				return
			}
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "action": "delete"})
	}
}

// firewallAuditTarget produces a compact, human-readable target string for
// the audit log row, e.g. "allow in 22/tcp from 192.168.1.0/24".
func firewallAuditTarget(r FirewallRule) string {
	port := "any"
	if r.Port != 0 {
		port = strconv.Itoa(r.Port)
		if r.PortEnd != 0 && r.PortEnd != r.Port {
			port += ":" + strconv.Itoa(r.PortEnd)
		}
	}
	proto := r.Proto
	if proto == "" {
		proto = "any"
	}
	from := r.From
	if from == "" {
		from = "any"
	}
	to := r.To
	if to == "" {
		to = "any"
	}
	return fmt.Sprintf("%s %s %s/%s from %s to %s", r.Action, r.Direction, port, proto, from, to)
}
