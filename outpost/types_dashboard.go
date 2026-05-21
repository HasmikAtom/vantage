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
}
