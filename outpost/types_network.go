package main

type NetInterface struct {
	Name   string `json:"name"`
	IP     string `json:"ip"`
	RX     int    `json:"rx"`
	TX     int    `json:"tx"`
	Status string `json:"status"`
}

type Network struct {
	Interfaces []NetInterface `json:"interfaces"`
	Sparkline  []int          `json:"sparkline"`
}

type Tunnel struct {
	ID          string `json:"id"`
	TunnelID    string `json:"tunnelId,omitempty"`
	TunnelName  string `json:"tunnelName,omitempty"`
	Hostname    string `json:"hostname"`
	Service     string `json:"service"`
	Target      string `json:"target"`
	Status      string `json:"status"`
	Requests24h int    `json:"requests24h"`
	LatencyMs   int    `json:"latencyMs"`
	Origin      string `json:"origin"`
}

type Port struct {
	Port    int    `json:"port"`
	Proto   string `json:"proto"`
	Service string `json:"service"`
	Exposed string `json:"exposed"`
	PID     *int   `json:"pid"`
	Process string `json:"process"`
}

// ---------------------------------------------------------------------------
// New: established TCP connections
// ---------------------------------------------------------------------------

type Connection struct {
	RemoteIP   string `json:"remoteIp"`
	LocalPort  int    `json:"localPort"`
	Service    string `json:"service"` // taken from the ports collector
	Count      int    `json:"count"`   // duplicate connections from same remote→port
}
