package main

import "testing"

func TestFailedSince(t *testing.T) {
	// systemd's StateChangeTimestamp is microseconds since the epoch; busctl
	// --json=short delivers it as a JSON number (float64).
	props := map[string]any{"StateChangeTimestamp": float64(1_791_276_138_123_456)}
	if got := failedSince(props, "failed"); got != 1_791_276_138_123 {
		t.Fatalf("failed unit: got %d, want the change time in ms 1791276138123", got)
	}
	if got := failedSince(props, "active"); got != 0 {
		t.Fatalf("healthy unit: got %d, want 0 (only failures carry a time)", got)
	}
	for _, p := range []map[string]any{{}, {"StateChangeTimestamp": "x"}, {"StateChangeTimestamp": float64(0)}} {
		if got := failedSince(p, "failed"); got != 0 {
			t.Fatalf("props %v: got %d, want 0 when systemd gives no usable time", p, got)
		}
	}
}
