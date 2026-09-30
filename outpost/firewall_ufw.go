package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// ufwProvider implements FirewallProvider by dispatching `ufw` invocations
// through systemd-run so they execute on the host with root privileges.
//
// Why the mutex: ufw's delete-by-index is positional, and the indices shift
// every time a rule is added or removed. The canonical-tuple delete path
// does a list -> find -> `ufw delete N`, and we MUST hold mu across that
// sequence so a concurrent add/delete from another operator can't slip in
// and re-number the rules between our list and our delete. The mutex also
// protects against concurrent state changes through this dashboard; ufw
// edits performed directly on the host via SSH bypass our mutex but those
// are out of scope.
type ufwProvider struct {
	mu      sync.Mutex
	binPath string // absolute path on the HOST, e.g. "/usr/sbin/ufw"
}

func newUfwProvider(binPath string) *ufwProvider {
	return &ufwProvider{binPath: binPath}
}

func (p *ufwProvider) Name() string { return "ufw" }

// Status fetches the ufw status (active state, default policy) plus the
// numbered rule list and parses it into FirewallRule values. We use
// `status verbose` to also pick up the default-policy line.
func (p *ufwProvider) Status(ctx context.Context) (FirewallStatus, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.statusLocked(ctx)
}

func (p *ufwProvider) statusLocked(ctx context.Context) (FirewallStatus, error) {
	out, err := runOnHost(ctx, randTag("status"), []string{p.binPath, "status", "verbose"})
	if err != nil {
		return FirewallStatus{}, err
	}
	st := parseUfwStatus(string(out))
	st.Backend = "ufw"
	st.Available = true
	return st, nil
}

// Add appends a rule. ufw is idempotent for identical rules (it just says
// "Skipping adding existing rule"), so callers don't need to dedupe.
func (p *ufwProvider) Add(ctx context.Context, rule FirewallRule) error {
	args, err := buildUfwAddArgs(p.binPath, rule)
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	_, err = runOnHost(ctx, randTag("add"), args)
	return err
}

// Delete removes a rule by canonical tuple. We list rules under our own
// mutex, find the first matching numbered row, then issue `ufw --force
// delete N`. The mutex serializes list+delete so the index can't shift
// underneath us due to a concurrent Add/Delete from another operator
// through this dashboard.
func (p *ufwProvider) Delete(ctx context.Context, rule FirewallRule) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	numbered, err := runOnHost(ctx, randTag("list"), []string{p.binPath, "status", "numbered"})
	if err != nil {
		return err
	}
	idx, found := findUfwRuleIndex(string(numbered), rule)
	if !found {
		return ErrFirewallRuleNotFound
	}
	_, err = runOnHost(ctx, randTag("del"), []string{p.binPath, "--force", "delete", strconv.Itoa(idx)})
	return err
}

// buildUfwAddArgs constructs the argv for `ufw <action> <direction> ...`
// from a FirewallRule. We pass everything as a vector so there is no shell
// interpolation. Comments must be quoted by ufw, but we're passing the
// arg directly via exec — ufw will see the literal value.
func buildUfwAddArgs(binPath string, r FirewallRule) ([]string, error) {
	action := strings.ToLower(strings.TrimSpace(r.Action))
	switch action {
	case "allow", "deny", "reject", "limit":
	default:
		return nil, fmt.Errorf("invalid action %q (allow|deny|reject|limit)", r.Action)
	}
	direction := strings.ToLower(strings.TrimSpace(r.Direction))
	if direction == "" {
		direction = "in"
	}
	if direction != "in" && direction != "out" {
		return nil, fmt.Errorf("invalid direction %q (in|out)", r.Direction)
	}
	proto := strings.ToLower(strings.TrimSpace(r.Proto))
	if proto != "" && proto != "tcp" && proto != "udp" {
		return nil, fmt.Errorf("invalid proto %q (tcp|udp|empty)", r.Proto)
	}
	if r.Port < 0 || r.Port > 65535 {
		return nil, fmt.Errorf("invalid port %d", r.Port)
	}
	if r.PortEnd < 0 || r.PortEnd > 65535 {
		return nil, fmt.Errorf("invalid portEnd %d", r.PortEnd)
	}
	if r.PortEnd != 0 && r.PortEnd < r.Port {
		return nil, fmt.Errorf("portEnd %d < port %d", r.PortEnd, r.Port)
	}
	if r.From != "" {
		if err := validateAddrSpec(r.From); err != nil {
			return nil, fmt.Errorf("from: %w", err)
		}
	}
	if r.To != "" {
		if err := validateAddrSpec(r.To); err != nil {
			return nil, fmt.Errorf("to: %w", err)
		}
	}
	if len(r.Comment) > 200 {
		return nil, fmt.Errorf("comment too long")
	}

	args := []string{binPath, action, direction}

	// Source / destination clauses. ufw syntax:
	//   ufw allow in from <cidr> to any port <p> proto tcp
	// "any" port + "any" addr is the bare form: `ufw allow 22/tcp`.
	hasAddrClause := r.From != "" || r.To != "" || r.Port != 0
	if !hasAddrClause {
		return nil, fmt.Errorf("rule must specify at least a port or address")
	}

	if r.From != "" || r.To != "" {
		// Long form so we can attach an address.
		args = append(args, "from", emptyToAny(r.From), "to", emptyToAny(r.To))
		if r.Port != 0 {
			args = append(args, "port", portSpec(r.Port, r.PortEnd))
		}
		if proto != "" {
			args = append(args, "proto", proto)
		}
	} else {
		// Bare form: just port[/proto].
		spec := portSpec(r.Port, r.PortEnd)
		if proto != "" {
			spec += "/" + proto
		}
		args = append(args, spec)
	}

	if r.Comment != "" {
		args = append(args, "comment", r.Comment)
	}
	return args, nil
}

func portSpec(port, portEnd int) string {
	if portEnd == 0 || portEnd == port {
		return strconv.Itoa(port)
	}
	return strconv.Itoa(port) + ":" + strconv.Itoa(portEnd)
}

func emptyToAny(s string) string {
	if s == "" {
		return "any"
	}
	return s
}

// validateAddrSpec accepts IP, CIDR, or the literal "any"/"Anywhere".
func validateAddrSpec(s string) error {
	low := strings.ToLower(strings.TrimSpace(s))
	if low == "any" || low == "anywhere" {
		return nil
	}
	if ip := net.ParseIP(s); ip != nil {
		return nil
	}
	if _, _, err := net.ParseCIDR(s); err == nil {
		return nil
	}
	return fmt.Errorf("not an IP or CIDR")
}

// ufwRuleLine matches a `status numbered` row, e.g.:
//
//	[ 1] 22/tcp                     ALLOW IN    Anywhere
//	[ 2] 80                         ALLOW IN    192.168.1.0/24
//	[ 3] 22/tcp (v6)                ALLOW IN    Anywhere (v6)
//	[ 4] Anywhere on eth0           ALLOW IN    192.168.1.0/24
//
// And `status verbose` rows look the same except without the `[N]` prefix.
var ufwRuleLine = regexp.MustCompile(`^(?:\[\s*(\d+)\]\s+)?(.+?)\s{2,}(ALLOW IN|ALLOW OUT|DENY IN|DENY OUT|REJECT IN|REJECT OUT|LIMIT IN|LIMIT OUT)\s{2,}(.+?)(?:\s+#\s*(.+))?$`)

// parseUfwStatus reads the output of `ufw status verbose` (no indices) or
// `ufw status numbered`. Both paths share the rule-row regex; the verbose
// header is also parsed for default policy and the active flag.
func parseUfwStatus(text string) FirewallStatus {
	st := FirewallStatus{Rules: []FirewallRule{}}
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := sc.Text()
		trim := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trim, "Status:"):
			st.Active = strings.Contains(strings.ToLower(trim), "active")
		case strings.HasPrefix(trim, "Default:"):
			st.Default = strings.TrimSpace(strings.TrimPrefix(trim, "Default:"))
		}
		m := ufwRuleLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		spec := strings.TrimSpace(m[2])
		action := strings.TrimSpace(m[3])
		from := strings.TrimSpace(m[4])
		comment := strings.TrimSpace(m[5])
		rule := FirewallRule{
			Action:    strings.ToLower(strings.Fields(action)[0]),
			Direction: strings.ToLower(strings.Fields(action)[1]),
			From:      stripV6Suffix(from),
			V6:        strings.Contains(spec, "(v6)") || strings.Contains(from, "(v6)"),
			Comment:   comment,
			Raw:       strings.TrimSpace(line),
		}
		port, portEnd, proto, to := parseUfwSpec(spec)
		rule.Port = port
		rule.PortEnd = portEnd
		rule.Proto = proto
		rule.To = to
		st.Rules = append(st.Rules, rule)
	}
	return st
}

func stripV6Suffix(s string) string {
	return strings.TrimSpace(strings.ReplaceAll(s, "(v6)", ""))
}

// parseUfwSpec pulls apart the "To" column. Recognised shapes:
//
//	"22/tcp"          -> port=22 proto=tcp
//	"22"              -> port=22
//	"1000:2000/udp"   -> port=1000 portEnd=2000 proto=udp
//	"Anywhere"        -> to="Anywhere"
//	"10.0.0.0/8 80"   -> to="10.0.0.0/8" port=80 (rare with the long form)
//
// On formats we don't recognise we leave the spec in To verbatim —
// vantage-prime still has Raw to show the user.
func parseUfwSpec(spec string) (port, portEnd int, proto, to string) {
	spec = stripV6Suffix(spec)
	// Strip an "on <iface>" suffix; we don't surface it in the typed rule.
	if i := strings.Index(spec, " on "); i >= 0 {
		spec = strings.TrimSpace(spec[:i])
	}
	// Try the bare port[/proto] form.
	p, pe, pr, ok := tryParsePortProto(spec)
	if ok {
		return p, pe, pr, ""
	}
	// Otherwise treat as a destination address (e.g. "Anywhere").
	return 0, 0, "", spec
}

func tryParsePortProto(s string) (port, portEnd int, proto string, ok bool) {
	rest := s
	if i := strings.LastIndex(s, "/"); i >= 0 {
		proto = strings.ToLower(s[i+1:])
		if proto != "tcp" && proto != "udp" {
			return 0, 0, "", false
		}
		rest = s[:i]
	}
	if i := strings.Index(rest, ":"); i >= 0 {
		a, err1 := strconv.Atoi(rest[:i])
		b, err2 := strconv.Atoi(rest[i+1:])
		if err1 != nil || err2 != nil {
			return 0, 0, "", false
		}
		return a, b, proto, true
	}
	n, err := strconv.Atoi(rest)
	if err != nil {
		return 0, 0, "", false
	}
	return n, 0, proto, true
}

// findUfwRuleIndex parses `ufw status numbered` output and returns the
// 1-based index of the first rule whose canonical tuple equals `target`.
// Two rules match when port range, proto, direction, action, source,
// destination, and IPv6 flag are all equal.
func findUfwRuleIndex(numberedOutput string, target FirewallRule) (int, bool) {
	st := parseUfwStatus(numberedOutput)
	// We didn't keep indices in FirewallStatus; re-walk the text to pair
	// each parsed rule with its [N] prefix.
	sc := bufio.NewScanner(strings.NewReader(numberedOutput))
	ri := 0
	for sc.Scan() {
		line := sc.Text()
		m := ufwRuleLine.FindStringSubmatch(line)
		if m == nil || m[1] == "" {
			continue
		}
		if ri >= len(st.Rules) {
			break
		}
		idx, err := strconv.Atoi(m[1])
		if err != nil {
			ri++
			continue
		}
		if ruleTupleEqual(st.Rules[ri], target) {
			return idx, true
		}
		ri++
	}
	return 0, false
}

// ruleTupleEqual is the canonical-identity check used by Delete. It is
// deliberately strict on the addressing fields so we never delete the
// wrong rule: a tuple with From="Anywhere" must match a stored rule whose
// From is also "Anywhere" (or empty, which we treat as the same).
func ruleTupleEqual(a, b FirewallRule) bool {
	if a.Port != b.Port || a.PortEnd != b.PortEnd {
		return false
	}
	if !strEqIgnoreCase(a.Proto, b.Proto) {
		return false
	}
	if !strEqIgnoreCase(a.Direction, b.Direction) {
		return false
	}
	if !strEqIgnoreCase(a.Action, b.Action) {
		return false
	}
	if !addrEq(a.From, b.From) || !addrEq(a.To, b.To) {
		return false
	}
	if a.V6 != b.V6 {
		return false
	}
	return true
}

func strEqIgnoreCase(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}

// addrEq treats "", "any", and "Anywhere" as equivalent so callers can
// supply any of them when deleting a wide-open rule.
func addrEq(a, b string) bool {
	na := normalizeAddr(a)
	nb := normalizeAddr(b)
	return na == nb
}

func normalizeAddr(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" || s == "any" || s == "anywhere" {
		return ""
	}
	return s
}

// randTag returns a short hex suffix appended to the transient unit name
// so concurrent ufw operations don't collide on the systemd unit namespace.
func randTag(prefix string) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return prefix + "-" + hex.EncodeToString(b[:])
}
