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
	sm := &smartctlOutput{}
	sm.SmartStatus.Passed = true

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
