package main

import (
	"errors"
	"testing"
	"time"
)

func TestErrorsPrunesStaleEntries(t *testing.T) {
	m := NewManager()
	// Fresh entry — should survive.
	m.setErr("fresh", errors.New("just now"))
	// Stale entry — backdate its timestamp past errTTL.
	m.mu.Lock()
	m.errs["stale"] = errEntry{msg: "old", at: time.Now().Add(-2 * errTTL)}
	m.mu.Unlock()

	out := m.Errors()
	if _, ok := out["fresh"]; !ok {
		t.Errorf("fresh entry missing from output: %v", out)
	}
	if _, ok := out["stale"]; ok {
		t.Errorf("stale entry should have been pruned: %v", out)
	}

	// Pruning must also delete from the underlying map, not just the output.
	m.mu.RLock()
	_, stillThere := m.errs["stale"]
	m.mu.RUnlock()
	if stillThere {
		t.Error("stale entry still present in m.errs after Errors()")
	}
}

func TestErrorsClearsOnNilErr(t *testing.T) {
	m := NewManager()
	m.setErr("flap", errors.New("first"))
	m.setErr("flap", nil) // collector recovered
	out := m.Errors()
	if _, ok := out["flap"]; ok {
		t.Errorf("entry cleared with nil err should not appear: %v", out)
	}
}
