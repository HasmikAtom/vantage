package main

import (
	"context"
	"os"
)

// App is the Go-side context exposed to the webview via Wails' Bind.
// The JS shell calls TargetURL() during boot to learn where to navigate.
type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// TargetURL is the dashboard URL the shell page redirects to. Override via
// the VANTAGE_URL env var; defaults to the prod docker-compose port.
func (a *App) TargetURL() string {
	if u := os.Getenv("VANTAGE_URL"); u != "" {
		return u
	}
	return "http://localhost:8088"
}
