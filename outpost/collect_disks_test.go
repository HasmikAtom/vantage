package main

import (
	"strings"
	"testing"
)

func TestCommandTimeoutCount(t *testing.T) {
	cases := []struct {
		raw  uint64
		want uint64
	}{
		{0, 0},
		{3, 3},
		{150, 150},                 // plain count (non-Seagate)
		{12885098499, 3},           // disk2 Exos ZL2AQXBS, 2026-10-22: 0x0003_0003_0003
		{0x0000_0000_0001_0000, 1}, // one counter set, low word zero
		{0x0000_00C8_0001_0002, 200},
	}
	for _, c := range cases {
		if got := commandTimeoutCount(c.raw); got != c.want {
			t.Errorf("commandTimeoutCount(%d) = %d, want %d", c.raw, got, c.want)
		}
	}
}

func TestScoreSmartSeagateCommandTimeout(t *testing.T) {
	sm := passingSmart()

	d := &SmartDetail{AtaAttrs: []SmartAttr{
		{ID: 188, Name: "Command_Timeout", RawValue: 12885098499, RawString: "12885098499"},
	}}
	if s := scoreSmart(sm, d); s.Rating != "healthy" {
		t.Fatalf("3 packed timeouts: rating %q, reasons %v; want healthy", s.Rating, s.Reasons)
	}

	d.AtaAttrs[0].RawValue = 0x0000_00C8_00C8_00C8 // 200 in each counter
	s := scoreSmart(sm, d)
	if s.Rating != "warning" || len(s.Reasons) != 1 || !strings.HasPrefix(s.Reasons[0], "Command_Timeout: 200 ") {
		t.Fatalf("200 packed timeouts: rating %q, reasons %v; want warning with decoded count", s.Rating, s.Reasons)
	}
}

func passingSmart() *smartctlOutput {
	sm := &smartctlOutput{}
	sm.SmartStatus = &struct {
		Passed bool `json:"passed"`
	}{Passed: true}
	return sm
}

// Trimmed `smartctl -aj /dev/sda` from a VPS (forge server,
// 2026-10-22): a QEMU "scsi" disk that answers but has no smart_status.
const vpsSmartctl = `{"json_format_version":[1,0],"smartctl":{"version":[7,4],"exit_status":0},
"device":{"name":"/dev/sda","info_name":"/dev/sda","type":"scsi","protocol":"SCSI"}}`

func TestParseSmartctlNoHealthStatus(t *testing.T) {
	sm, err := parseSmartctl("/dev/sda", []byte(vpsSmartctl))
	if err == nil {
		t.Fatalf("virtual disk without smart_status parsed as %+v; want an error so it shows as unknown", sm)
	}
}

func TestParseSmartctlStatus(t *testing.T) {
	for _, c := range []struct {
		json string
		want bool
	}{
		{`{"smart_status":{"passed":true}}`, true},
		{`{"smart_status":{"passed":false}}`, false},
	} {
		sm, err := parseSmartctl("/dev/sdx", []byte(c.json))
		if err != nil {
			t.Fatalf("%s: %v", c.json, err)
		}
		if smartPassed(sm) != c.want {
			t.Errorf("%s: smartPassed = %v, want %v", c.json, !c.want, c.want)
		}
		if got := scoreSmart(sm, &SmartDetail{}).Rating == "failed"; got == c.want {
			t.Errorf("%s: rating failed = %v", c.json, got)
		}
	}
}
