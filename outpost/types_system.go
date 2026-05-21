package main

type SystemInfo struct {
	Hostname    string     `json:"hostname"`
	Fingerprint string     `json:"fingerprint"`
	OS          string     `json:"os"`
	Kernel      string     `json:"kernel"`
	CPUModel    string     `json:"cpuModel"`
	CPUClock    string     `json:"cpuClock"`
	// CPUCores is the LOGICAL CPU count (= threads on SMT/HT systems). Kept
	// under this name for compatibility; CPUPhysicalCores is the count of
	// actual silicon execution units. On a 4-core/8-thread chip you get
	// CPUPhysicalCores=4, CPUCores=8.
	CPUCores         int `json:"cpuCores"`
	CPUPhysicalCores int `json:"cpuPhysicalCores"`
	UptimeText  string     `json:"uptimeText"`
	UptimeDays  int        `json:"uptimeDays"`
	BootedAt    string     `json:"bootedAt"`
	TimeText    string     `json:"timeText"`
	LoadAvg     [3]float64 `json:"loadAvg"`
}

type CPUHeadline struct {
	Pct        float64 `json:"pct"`
	User       float64 `json:"user"`
	System     float64 `json:"system"`
	Idle       float64 `json:"idle"`
	Iowait     float64 `json:"iowait"`
	CtxSwitch  int     `json:"ctxSwitch"`
	Interrupts int     `json:"interrupts"`
	SoftInt    int     `json:"softInt"`
	Temp       int     `json:"temp"`
	PowerW     float64 `json:"powerW"` // RAPL package draw, watts (0 when RAPL unavailable)
}

type VRAM struct {
	Used  float64 `json:"used"`
	Total float64 `json:"total"`
	Unit  string  `json:"unit"`
}

type GPUHeadline struct {
	Name   string  `json:"name"`
	Driver string  `json:"driver"` // "nouveau" / "amdgpu" / "nvidia"
	Pct    float64 `json:"pct"`
	VRAM   VRAM    `json:"vram"`
	Temp   int     `json:"temp"`
	Fan    int     `json:"fan"`

	// New Nouveau-friendly fields. Some may stay zero on drivers/cards that
	// don't expose them; the UI treats null/zero gracefully.
	PowerW       float64       `json:"powerW"`         // current GPU power draw, watts
	VoltageV     float64       `json:"voltageV"`       // GPU core voltage, volts
	CoreMHz      int           `json:"coreMhz"`        // current core clock
	MemMHz       int           `json:"memMhz"`         // current memory clock
	PState       string        `json:"pstate"`         // active p-state line label e.g. "07"
	PCIe         PCIeLink      `json:"pcie"`           // current vs max link
	Processes    []GPUProcess  `json:"processes"`      // processes with /dev/dri/* open
}

type PCIeLink struct {
	CurrentSpeed string `json:"currentSpeed"` // "8 GT/s"
	CurrentWidth int    `json:"currentWidth"` // 16
	MaxSpeed     string `json:"maxSpeed"`
	MaxWidth     int    `json:"maxWidth"`
}

type GPUProcess struct {
	PID    int    `json:"pid"`
	Name   string `json:"name"`
	Device string `json:"device"` // "/dev/dri/card1" or "/dev/dri/renderD128"
}

type MemHeadline struct {
	Pct      float64 `json:"pct"`
	Total    float64 `json:"total"`
	Used     float64 `json:"used"`
	Free     float64 `json:"free"`
	Active   float64 `json:"active"`
	Inactive float64 `json:"inactive"`
	Buffers  float64 `json:"buffers"`
	Cached   float64 `json:"cached"`
	Unit     string  `json:"unit"`
	PowerW   float64 `json:"powerW"` // RAPL DRAM domain, watts (0 when not exposed)
}

type SwapHeadline struct {
	Pct   float64 `json:"pct"`
	Total float64 `json:"total"`
	Used  float64 `json:"used"`
	Free  float64 `json:"free"`
	Unit  string  `json:"unit"`
}

type Headline struct {
	CPU          CPUHeadline  `json:"cpu"`
	GPU          GPUHeadline  `json:"gpu"`
	Mem          MemHeadline  `json:"mem"`
	Swap         SwapHeadline `json:"swap"`
	CPUSpark     []float64    `json:"cpuSpark"`
	GPUSpark     []float64    `json:"gpuSpark"`
	MemSpark     []float64    `json:"memSpark"`
	StorageSpark []float64    `json:"storageSpark"`
}

type Sensor struct {
	ID      string    `json:"id"`
	Label   string    `json:"label"`
	Group   string    `json:"group"`
	Value   float64   `json:"value"`
	Unit    string    `json:"unit"`
	Max     float64   `json:"max"`
	History []float64 `json:"history"`
}

type Service struct {
	Name        string  `json:"name"`
	Status      string  `json:"status"`
	Enabled     bool    `json:"enabled"`
	PID         *int    `json:"pid"`
	MemMb       float64 `json:"memMb"`
	User        string  `json:"user"`
	Description string  `json:"description"`
}

// ---------------------------------------------------------------------------
// New: top processes
// ---------------------------------------------------------------------------

type ProcessInfo struct {
	PID      int     `json:"pid"`
	Name     string  `json:"name"`
	User     string  `json:"user"`
	CPU      float64 `json:"cpu"`   // %
	MemMB    float64 `json:"memMb"` // RSS MiB
	Cmd      string  `json:"cmd"`
	Threads  int     `json:"threads"`
}

// ---------------------------------------------------------------------------
// New: pressure (PSI)
// ---------------------------------------------------------------------------

type PressureLine struct {
	Avg10  float64 `json:"avg10"`
	Avg60  float64 `json:"avg60"`
	Avg300 float64 `json:"avg300"`
}

type Pressure struct {
	CPU    PressureLine `json:"cpu"`
	MemSome PressureLine `json:"memSome"`
	MemFull PressureLine `json:"memFull"`
	IOSome  PressureLine `json:"ioSome"`
	IOFull  PressureLine `json:"ioFull"`
	Available bool       `json:"available"`
}

// ---------------------------------------------------------------------------
// New: per-core CPU
// ---------------------------------------------------------------------------

type CoreUsage struct {
	Core int     `json:"core"`
	Pct  float64 `json:"pct"`
}

// ---------------------------------------------------------------------------
// New: updates
// ---------------------------------------------------------------------------

type UpdateInfo struct {
	UpgradableCount int      `json:"upgradableCount"`
	SecurityCount   int      `json:"securityCount"`
	RebootRequired  bool     `json:"rebootRequired"`
	RebootPkgs      []string `json:"rebootPkgs"`
	Summary         string   `json:"summary"` // raw motd line
}

// ---------------------------------------------------------------------------
// New: journal warnings
// ---------------------------------------------------------------------------

type JournalEntry struct {
	Timestamp string `json:"timestamp"` // ISO-8601 UTC
	Unit      string `json:"unit"`
	Priority  int    `json:"priority"` // syslog severity: 0..7
	Message   string `json:"message"`
}

// ---------------------------------------------------------------------------
// New: system users + groups
// ---------------------------------------------------------------------------

type User struct {
	Username string   `json:"username"`
	UID      int      `json:"uid"`
	GID      int      `json:"gid"`        // primary group
	Gecos    string   `json:"gecos"`      // first comma-separated field of the GECOS column ("Full Name")
	Home     string   `json:"home"`
	Shell    string   `json:"shell"`
	System   bool     `json:"system"`     // UID < 1000 OR shell is nologin/false
	Groups   []string `json:"groups"`     // primary group name first, then sorted supplementary
}

type Group struct {
	Name    string   `json:"name"`
	GID     int      `json:"gid"`
	Members []string `json:"members"`    // /etc/group members merged with users whose primary GID matches
}

type UsersInfo struct {
	Users  []User  `json:"users"`
	Groups []Group `json:"groups"`
}
