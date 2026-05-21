package main

// FirewallRule is the dashboard-level, provider-agnostic representation of a
// host firewall rule. Identity for delete is the tuple (Port, PortEnd, Proto,
// Direction, Action, From, To, V6) — the index a provider may use (e.g. ufw's
// numbered position) is NOT stable across operators, so the API takes the
// tuple and the provider re-resolves to whatever native handle it needs.
type FirewallRule struct {
	Port      int    `json:"port"`              // 0 = any port
	PortEnd   int    `json:"portEnd,omitempty"` // non-zero = range Port..PortEnd
	Proto     string `json:"proto"`             // "tcp" | "udp" | "" (any)
	Direction string `json:"direction"`         // "in" | "out"
	Action    string `json:"action"`            // "allow" | "deny" | "reject" | "limit"
	From      string `json:"from,omitempty"`    // source CIDR/IP/"Anywhere"
	To        string `json:"to,omitempty"`      // dest CIDR/IP/"Anywhere"
	V6        bool   `json:"v6,omitempty"`      // true for IPv6 rule
	Comment   string `json:"comment,omitempty"`
	Raw       string `json:"raw,omitempty"` // verbatim source line, for display
}

// FirewallStatus is the response shape for GET /firewall.
type FirewallStatus struct {
	Available bool           `json:"available"` // false = no supported backend detected
	Backend   string         `json:"backend"`   // "ufw" when Available
	Active    bool           `json:"active"`    // true if the backend reports enabled
	Default   string         `json:"default,omitempty"`
	Rules     []FirewallRule `json:"rules"`
}
