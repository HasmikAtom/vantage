package main

type Smart struct {
	Passed      bool `json:"passed"`
	Reallocated int  `json:"reallocated"`
	Pending     int  `json:"pending"`
	LifeLeft    int  `json:"lifeLeft"`
}

// SmartAttr mirrors one row of `ata_smart_attributes.table` from `smartctl -aj`.
// `WhenFailed` is "" when the drive isn't flagging the attribute, or
// "in_the_past" / "FAILING_NOW" when it is.
type SmartAttr struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	Value      int    `json:"value"`
	Worst      int    `json:"worst"`
	Threshold  int    `json:"threshold"`
	RawValue   uint64 `json:"rawValue"`
	RawString  string `json:"rawString"`
	Prefailure bool   `json:"prefailure"`
	WhenFailed string `json:"whenFailed"`
}

// NvmeHealthLog mirrors the full nvme_smart_health_information_log block.
// Counts use uint64 because data_units_* on long-lived drives can exceed 2^32.
type NvmeHealthLog struct {
	CriticalWarning         int    `json:"criticalWarning"`
	Temperature             int    `json:"temperature"`
	AvailableSpare          int    `json:"availableSpare"`
	AvailableSpareThreshold int    `json:"availableSpareThreshold"`
	PercentageUsed          int    `json:"percentageUsed"`
	DataUnitsRead           uint64 `json:"dataUnitsRead"`
	DataUnitsWritten        uint64 `json:"dataUnitsWritten"`
	HostReads               uint64 `json:"hostReads"`
	HostWrites              uint64 `json:"hostWrites"`
	ControllerBusyTime      uint64 `json:"controllerBusyTime"` // minutes
	PowerCycles             uint64 `json:"powerCycles"`
	PowerOnHours            uint64 `json:"powerOnHours"`
	UnsafeShutdowns         uint64 `json:"unsafeShutdowns"`
	MediaErrors             uint64 `json:"mediaErrors"`
	NumErrLogEntries        uint64 `json:"numErrLogEntries"`
	WarningTempTime         int    `json:"warningTempTime"`
	CriticalCompTime        int    `json:"criticalCompTime"`
	TemperatureSensors      []int  `json:"temperatureSensors"`
}

// ScrutinyScore is the Backblaze-style health verdict, computed on each
// snapshot from current-tick SMART values. No history involved — "growing"
// detection would require a time-series store the project doesn't have.
type ScrutinyScore struct {
	Rating  string   `json:"rating"`  // "healthy" | "warning" | "failed"
	Reasons []string `json:"reasons"` // empty when healthy
}

// SmartDetail is the full Scrutiny-style disclosure: drive identity, the raw
// SMART attribute table or NVMe health log, plus our derived score.
type SmartDetail struct {
	Serial         string         `json:"serial"`
	Firmware       string         `json:"firmware"`
	ModelFamily    string         `json:"modelFamily"`    // e.g. "Seagate BarraCuda 3.5 (SMR)", empty when unknown
	FormFactor     string         `json:"formFactor"`     // "2.5 inches" / "3.5 inches" / "" for NVMe
	RotationRate   int            `json:"rotationRate"`   // 0 = SSD, 5400/7200 etc.
	InterfaceSpeed string         `json:"interfaceSpeed"` // currently negotiated link, e.g. "6.0 Gb/s"
	MaxInterface   string         `json:"maxInterface"`   // best the drive could do, e.g. "6.0 Gb/s"
	PowerCycles    uint64         `json:"powerCycles"`
	AtaAttrs       []SmartAttr    `json:"ataAttrs"`       // [] for NVMe
	NvmeLog        *NvmeHealthLog `json:"nvmeLog"`        // nil for SATA
	Score          ScrutinyScore  `json:"score"`
}

type Disk struct {
	ID           string  `json:"id"`
	Label        string  `json:"label"`
	Model        string  `json:"model"`
	Mount        string  `json:"mount"`
	Type         string  `json:"type"`
	Total        float64 `json:"total"`
	Used         float64 `json:"used"`
	Health       string  `json:"health"`
	TempC        int     `json:"tempC"`
	PowerOnHours int     `json:"powerOnHours"`
	Writes       float64      `json:"writes"`
	Reads        float64      `json:"reads"`
	Smart        Smart        `json:"smart"`
	Detail       *SmartDetail `json:"detail"`
}

type Filesystem struct {
	Mount  string  `json:"mount"`
	Fstype string  `json:"fstype"`
	Used   float64 `json:"used"`
	Total  float64 `json:"total"`
	Unit   string  `json:"unit"`
}

// ---------------------------------------------------------------------------
// New: disk I/O throughput
// ---------------------------------------------------------------------------

type DiskIO struct {
	ID         string  `json:"id"`         // e.g. "nvme0n1"
	ReadBps    float64 `json:"readBps"`    // bytes/sec
	WriteBps   float64 `json:"writeBps"`
	ReadIops   float64 `json:"readIops"`
	WriteIops  float64 `json:"writeIops"`
	UtilPct    float64 `json:"utilPct"`    // % of wall time the disk was busy
}
