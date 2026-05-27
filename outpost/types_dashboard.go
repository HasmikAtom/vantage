package main

// ---------------------------------------------------------------------------
// Composite snapshot
// ---------------------------------------------------------------------------

type DashboardSnapshot struct {
	System      SystemInfo     `json:"system"`
	Headline    Headline       `json:"headline"`
	Sensors     []Sensor       `json:"sensors"`
	Disks       []Disk         `json:"disks"`
	Filesystems []Filesystem   `json:"filesystems"`
	Network     Network        `json:"network"`
	Tunnels     []Tunnel       `json:"tunnels"`
	Containers  []Container    `json:"containers"`
	Services    []Service      `json:"services"`
	Ports       []Port         `json:"ports"`
	// New:
	Processes     []ProcessInfo  `json:"processes"`
	Cores         []CoreUsage    `json:"cores"`
	Pressure      Pressure       `json:"pressure"`
	DiskIO        []DiskIO       `json:"diskIo"`
	DockerDF      DockerDF       `json:"dockerDf"`
	Connections   []Connection   `json:"connections"`
	Updates       UpdateInfo     `json:"updates"`
	Journal       []JournalEntry `json:"journal"`
	Users         UsersInfo      `json:"users"`
	Alerts        []AlertEvent   `json:"alerts"`
}

// AlertEvent is one threshold-crossing window — the Glances-style
// "WARNING from T1 to T2, peak X% on metric M" event. Open windows
// (still above threshold) have an empty EndedAt; closed windows are
// retained on a small ring buffer so the UI can show recent history.
type AlertEvent struct {
	ID        string  `json:"id"`        // stable key: <metric>:<beganAt-unix>
	Metric    string  `json:"metric"`    // "cpu" | "mem" | "swap" | "load" | "fs:/mnt" | "sensor:<id>"
	Label     string  `json:"label"`     // human-friendly metric name
	Severity  string  `json:"severity"`  // "warning" | "critical"
	BeganAt   string  `json:"beganAt"`   // RFC3339
	EndedAt   string  `json:"endedAt,omitempty"`
	Threshold float64 `json:"threshold"` // value that originally tripped the alert
	Peak      float64 `json:"peak"`      // worst observed value during the window
	Unit      string  `json:"unit"`      // "%" | "°C" | "" (load avg)
}
