package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoleAtLeast(t *testing.T) {
	cases := []struct {
		min, got string
		want     bool
	}{
		// Exact and higher pass.
		{roleViewer, roleViewer, true},
		{roleViewer, roleOperator, true},
		{roleViewer, roleAdmin, true},
		{roleOperator, roleOperator, true},
		{roleOperator, roleAdmin, true},
		{roleAdmin, roleAdmin, true},
		// Lower role denied.
		{roleOperator, roleViewer, false},
		{roleAdmin, roleViewer, false},
		{roleAdmin, roleOperator, false},
		// Unknown / empty got fails closed.
		{roleViewer, "", false},
		{roleViewer, "root", false},
		{roleAdmin, "Admin", false}, // case-sensitive
	}
	for _, tc := range cases {
		got := roleAtLeast(tc.min, tc.got)
		if got != tc.want {
			t.Errorf("roleAtLeast(min=%q, got=%q) = %v, want %v", tc.min, tc.got, got, tc.want)
		}
	}
}

func TestRequireRoleAllowsSufficient(t *testing.T) {
	called := false
	h := requireRole(roleOperator, func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set(roleHeader, roleAdmin)
	rr := httptest.NewRecorder()
	h(rr, req)
	if !called {
		t.Fatal("handler not called for admin against operator-min")
	}
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
}

func TestRequireRoleDeniesInsufficient(t *testing.T) {
	called := false
	h := requireRole(roleOperator, func(w http.ResponseWriter, r *http.Request) {
		called = true
	})
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set(roleHeader, roleViewer)
	rr := httptest.NewRecorder()
	h(rr, req)
	if called {
		t.Fatal("handler invoked despite viewer-vs-operator deny")
	}
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
}

func TestRequireRoleDeniesMissingHeader(t *testing.T) {
	// Defense in depth: if the proxy ever forgets to set the header (bug),
	// we still fail closed rather than letting an unrolled request through.
	called := false
	h := requireRole(roleViewer, func(w http.ResponseWriter, r *http.Request) {
		called = true
	})
	req := httptest.NewRequest("POST", "/", nil)
	rr := httptest.NewRecorder()
	h(rr, req)
	if called {
		t.Fatal("handler invoked with no role header")
	}
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
}
