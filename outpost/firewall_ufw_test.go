package main

import (
	"testing"
)

// Real-shape outputs from `ufw status verbose` / `ufw status numbered`,
// trimmed and inlined here so the test doesn't need root or the host
// firewall to run.

const ufwVerbose = `Status: active

Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
80/tcp                     ALLOW IN    192.168.1.0/24
1000:2000/udp              DENY IN     Anywhere
22/tcp (v6)                ALLOW IN    Anywhere (v6)
`

const ufwNumbered = `Status: active

     To                         Action      From
     --                         ------      ----
[ 1] 22/tcp                     ALLOW IN    Anywhere
[ 2] 80/tcp                     ALLOW IN    192.168.1.0/24
[ 3] 1000:2000/udp              DENY IN     Anywhere
[ 4] 22/tcp (v6)                ALLOW IN    Anywhere (v6)
`

func TestParseUfwStatus_Verbose(t *testing.T) {
	st := parseUfwStatus(ufwVerbose)
	if !st.Active {
		t.Fatalf("expected Active=true, got false")
	}
	if st.Default == "" {
		t.Fatalf("expected Default policy, got empty")
	}
	if got, want := len(st.Rules), 4; got != want {
		t.Fatalf("rules: got %d want %d (%+v)", got, want, st.Rules)
	}
	r0 := st.Rules[0]
	if r0.Port != 22 || r0.Proto != "tcp" || r0.Action != "allow" || r0.Direction != "in" {
		t.Errorf("rule[0] %+v", r0)
	}
	r1 := st.Rules[1]
	if r1.Port != 80 || r1.From != "192.168.1.0/24" {
		t.Errorf("rule[1] %+v", r1)
	}
	r2 := st.Rules[2]
	if r2.Port != 1000 || r2.PortEnd != 2000 || r2.Proto != "udp" || r2.Action != "deny" {
		t.Errorf("rule[2] %+v", r2)
	}
	r3 := st.Rules[3]
	if !r3.V6 || r3.Port != 22 {
		t.Errorf("rule[3] %+v", r3)
	}
}

func TestFindUfwRuleIndex_ExactMatch(t *testing.T) {
	target := FirewallRule{Port: 80, Proto: "tcp", Direction: "in", Action: "allow", From: "192.168.1.0/24"}
	idx, ok := findUfwRuleIndex(ufwNumbered, target)
	if !ok || idx != 2 {
		t.Fatalf("got idx=%d ok=%v, want 2/true", idx, ok)
	}
}

func TestFindUfwRuleIndex_RangeMatch(t *testing.T) {
	target := FirewallRule{Port: 1000, PortEnd: 2000, Proto: "udp", Direction: "in", Action: "deny", From: "Anywhere"}
	idx, ok := findUfwRuleIndex(ufwNumbered, target)
	if !ok || idx != 3 {
		t.Fatalf("got idx=%d ok=%v, want 3/true", idx, ok)
	}
}

func TestFindUfwRuleIndex_V6IsDistinct(t *testing.T) {
	// Looking for IPv4 22/tcp should pick row 1, not row 4.
	target := FirewallRule{Port: 22, Proto: "tcp", Direction: "in", Action: "allow", From: "Anywhere"}
	idx, ok := findUfwRuleIndex(ufwNumbered, target)
	if !ok || idx != 1 {
		t.Fatalf("got idx=%d ok=%v, want 1/true", idx, ok)
	}
	// IPv6 variant should pick row 4.
	target.V6 = true
	idx, ok = findUfwRuleIndex(ufwNumbered, target)
	if !ok || idx != 4 {
		t.Fatalf("v6 got idx=%d ok=%v, want 4/true", idx, ok)
	}
}

func TestFindUfwRuleIndex_NoMatch(t *testing.T) {
	target := FirewallRule{Port: 9999, Proto: "tcp", Direction: "in", Action: "allow"}
	_, ok := findUfwRuleIndex(ufwNumbered, target)
	if ok {
		t.Fatalf("expected no match")
	}
}

func TestBuildUfwAddArgs(t *testing.T) {
	cases := []struct {
		name string
		rule FirewallRule
		want []string
	}{
		{
			name: "bare port/proto",
			rule: FirewallRule{Port: 22, Proto: "tcp", Action: "allow", Direction: "in"},
			want: []string{"/usr/sbin/ufw", "allow", "in", "22/tcp"},
		},
		{
			name: "with source CIDR",
			rule: FirewallRule{Port: 80, Proto: "tcp", Action: "allow", Direction: "in", From: "192.168.1.0/24"},
			want: []string{"/usr/sbin/ufw", "allow", "in", "from", "192.168.1.0/24", "to", "any", "port", "80", "proto", "tcp"},
		},
		{
			name: "port range",
			rule: FirewallRule{Port: 1000, PortEnd: 2000, Proto: "udp", Action: "deny", Direction: "in"},
			want: []string{"/usr/sbin/ufw", "deny", "in", "1000:2000/udp"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := buildUfwAddArgs("/usr/sbin/ufw", c.rule)
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if !eqStrings(got, c.want) {
				t.Fatalf("got %v\nwant %v", got, c.want)
			}
		})
	}
}

func TestBuildUfwAddArgs_Validation(t *testing.T) {
	bad := []FirewallRule{
		{Port: 22, Proto: "tcp", Action: "burninate", Direction: "in"},                 // bad action
		{Port: 22, Proto: "tcp", Action: "allow", Direction: "sideways"},               // bad direction
		{Port: 22, Proto: "smtp", Action: "allow", Direction: "in"},                    // bad proto
		{Port: -1, Proto: "tcp", Action: "allow", Direction: "in"},                     // bad port
		{Port: 100, PortEnd: 50, Proto: "tcp", Action: "allow", Direction: "in"},       // inverted range
		{Action: "allow", Direction: "in"},                                             // no address or port
		{Port: 22, Proto: "tcp", Action: "allow", Direction: "in", From: "not-an-ip"},  // bad CIDR
	}
	for i, r := range bad {
		if _, err := buildUfwAddArgs("/usr/sbin/ufw", r); err == nil {
			t.Errorf("case %d: expected error for %+v", i, r)
		}
	}
}

func eqStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
