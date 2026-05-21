package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// journalctl --output=json emits one event per line. We only pull the fields
// we need; everything else gets dropped on the floor.
type journalEvent struct {
	RealtimeTS string `json:"__REALTIME_TIMESTAMP"` // microseconds since epoch
	Unit       string `json:"_SYSTEMD_UNIT"`
	UserUnit   string `json:"USER_UNIT"`
	SyslogID   string `json:"SYSLOG_IDENTIFIER"`
	Priority   string `json:"PRIORITY"` // "0".."7"
	Message    any    `json:"MESSAGE"`  // sometimes a string, sometimes an int array
}

// findJournalDir picks the first existing host-side journal location.
func findJournalDir() string {
	candidates := []string{
		hostFsPath("/var/log/journal"), // persistent
		hostFsPath("/run/log/journal"), // volatile
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c
		}
	}
	return ""
}

func collectJournal(ctx context.Context, maxLines int) ([]JournalEntry, error) {
	if _, err := exec.LookPath("journalctl"); err != nil {
		return nil, fmt.Errorf("journalctl not in PATH")
	}
	dir := findJournalDir()
	if dir == "" {
		return nil, fmt.Errorf("no journal directory mounted from host")
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	args := []string{
		"-D", dir,
		"-p", "warning", // priority warn and above (warn/err/crit/alert/emerg)
		"-n", strconv.Itoa(maxLines),
		"--no-pager",
		"--output=json",
	}
	cmd := exec.CommandContext(ctx, "journalctl", args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("journalctl: %w", err)
	}

	var entries []JournalEntry
	s := bufio.NewScanner(bytes.NewReader(out))
	s.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for s.Scan() {
		line := s.Bytes()
		if len(line) == 0 {
			continue
		}
		if entry, ok := parseJournalLine(line); ok {
			entries = append(entries, entry)
		}
	}

	// journalctl returns newest last; flip so the UI shows newest first.
	for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
		entries[i], entries[j] = entries[j], entries[i]
	}
	return entries, nil
}

// parseJournalLine decodes one --output=json line into a JournalEntry,
// normalising MESSAGE (string or int-array), unit (preferring _SYSTEMD_UNIT
// then USER_UNIT then SYSLOG_IDENTIFIER), priority, and timestamp. Returns
// ok=false for malformed lines or empty messages so the caller can skip.
func parseJournalLine(line []byte) (JournalEntry, bool) {
	var ev journalEvent
	if err := json.Unmarshal(line, &ev); err != nil {
		return JournalEntry{}, false
	}
	// MESSAGE can be a string or a JSON-array of ints (raw binary message).
	msg := ""
	switch v := ev.Message.(type) {
	case string:
		msg = v
	case []any:
		b := make([]byte, 0, len(v))
		for _, n := range v {
			if f, ok := n.(float64); ok {
				b = append(b, byte(f))
			}
		}
		msg = string(b)
	}
	msg = strings.TrimSpace(msg)
	if msg == "" {
		return JournalEntry{}, false
	}

	unit := ev.Unit
	if unit == "" {
		unit = ev.UserUnit
	}
	if unit == "" {
		unit = ev.SyslogID
	}
	prio, _ := strconv.Atoi(ev.Priority)

	var ts string
	if us, err := strconv.ParseInt(ev.RealtimeTS, 10, 64); err == nil {
		ts = time.Unix(0, us*1000).UTC().Format(time.RFC3339)
	}

	return JournalEntry{
		Timestamp: ts,
		Unit:      unit,
		Priority:  prio,
		Message:   msg,
	}, true
}
