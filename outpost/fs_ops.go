package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// newTrashID generates a unique trash entry identifier in the form
// "<unix-millis>-<8 hex chars>". The timestamp prefix gives a
// chronological sort order; the random suffix prevents collisions
// when two deletes land in the same millisecond.
func newTrashID() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d-%s", time.Now().UnixMilli(), hex.EncodeToString(b[:])), nil
}
