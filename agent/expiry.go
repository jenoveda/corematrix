package main

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type rentalDeadline struct {
	DeploymentID string    `json:"deploymentId"`
	ExpiresAt    time.Time `json:"expiresAt"`
	Revision     int64     `json:"revision"`
}

// Persist boot-relative uptime so wall-clock corrections cannot extend paid rentals.
type expiryState struct {
	BootID    string             `json:"bootId"`
	Deadlines map[string]float64 `json:"deadlines"`
	Revisions map[string]int64   `json:"revisions,omitempty"`
}

func nodeUptime() (float64, error) {
	raw, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, diagnostic("uptime_unavailable")
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return 0, diagnostic("uptime_unavailable")
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, diagnostic("uptime_unavailable")
	}
	return value, nil
}
func (a *agent) uptimeSeconds() (float64, error) {
	if a.uptime != nil {
		return a.uptime()
	}
	return nodeUptime()
}
func (a *agent) loadExpiries() error {
	raw, err := os.ReadFile(filepath.Join(a.cfg.StateDir, "rental-expiries.json"))
	if os.IsNotExist(err) {
		a.expiries = map[string]time.Time{}
		a.expiryRevisions = map[string]int64{}
		return nil
	}
	if err != nil || len(raw) > 1024*1024 {
		return diagnostic("expiry_state_invalid")
	}
	var state expiryState
	if json.Unmarshal(raw, &state) != nil || state.BootID == "" || state.Deadlines == nil {
		return diagnostic("expiry_state_invalid")
	}
	uptime, err := a.uptimeSeconds()
	if err != nil {
		return err
	}
	a.expiries = map[string]time.Time{}
	a.expiryRevisions = map[string]int64{}
	for id, deadline := range state.Deadlines {
		if state.Revisions[id] < 0 || state.Revisions[id] > 9007199254740991 || !uuidPattern.MatchString(id) || math.IsNaN(deadline) || math.IsInf(deadline, 0) || math.Abs(deadline) > 1e12 || (state.BootID == a.boot && deadline > uptime+720*3600) {
			return diagnostic("expiry_state_invalid")
		}
		remaining := deadline - uptime
		if state.BootID != a.boot {
			remaining = 0
		}
		a.expiries[id] = time.Now().Add(time.Duration(remaining * float64(time.Second)))
		a.expiryRevisions[id] = state.Revisions[id]
	}
	return nil
}
func (a *agent) saveExpiries() error {
	uptime, err := a.uptimeSeconds()
	if err != nil {
		return err
	}
	state := expiryState{BootID: a.boot, Deadlines: map[string]float64{}, Revisions: a.expiryRevisions}
	for id, deadline := range a.expiries {
		state.Deadlines[id] = uptime + time.Until(deadline).Seconds()
	}
	raw, err := json.Marshal(state)
	if err != nil || len(raw) > 1024*1024 {
		return diagnostic("expiry_state_invalid")
	}
	file, err := os.CreateTemp(a.cfg.StateDir, "expiry-*.tmp")
	if err != nil {
		return diagnostic("expiry_state_unavailable")
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if file.Chmod(0600) != nil {
		return diagnostic("expiry_state_unavailable")
	}
	if _, err = file.Write(raw); err != nil {
		return diagnostic("expiry_state_unavailable")
	}
	if file.Sync() != nil || file.Close() != nil {
		return diagnostic("expiry_state_unavailable")
	}
	if os.Rename(file.Name(), filepath.Join(a.cfg.StateDir, "rental-expiries.json")) != nil {
		return diagnostic("expiry_state_unavailable")
	}
	dir, err := os.Open(a.cfg.StateDir)
	if err != nil {
		return diagnostic("expiry_state_unavailable")
	}
	defer dir.Close()
	if dir.Sync() != nil {
		return diagnostic("expiry_state_unavailable")
	}
	return nil
}
func (a *agent) updateExpiries(values []rentalDeadline, serverTime time.Time, elapsed time.Duration, containers []container, inventoryOK bool) error {
	if serverTime.IsZero() {
		return diagnostic("invalid_expiry_time")
	}
	a.expiryMu.Lock()
	defer a.expiryMu.Unlock()
	if a.expiries == nil {
		a.expiries = map[string]time.Time{}
		a.expiryRevisions = map[string]int64{}
	}
	next := map[string]time.Time{}
	revisions := map[string]int64{}
	accepted := []rentalDeadline{}
	for _, value := range values {
		if value.Revision < 0 || value.Revision > 9007199254740991 || !uuidPattern.MatchString(value.DeploymentID) || value.ExpiresAt.IsZero() || value.ExpiresAt.Sub(serverTime) > 720*time.Hour {
			return diagnostic("invalid_expiry_time")
		}
		deadline := time.Now().Add(value.ExpiresAt.Sub(serverTime) - elapsed)
		if previous, ok := a.expiries[value.DeploymentID]; ok {
			revision := a.expiryRevisions[value.DeploymentID]
			if value.Revision < revision {
				next[value.DeploymentID] = previous
				revisions[value.DeploymentID] = revision
				continue
			}
			if value.Revision > revision && previous.Before(deadline) && !time.Now().Before(previous) {
				next[value.DeploymentID] = previous
				revisions[value.DeploymentID] = revision
				continue
			}
			if value.Revision == revision && previous.Before(deadline) {
				deadline = previous
			}
		}
		next[value.DeploymentID] = deadline
		revisions[value.DeploymentID] = value.Revision
		if time.Now().Before(deadline) || !value.ExpiresAt.After(serverTime) {
			accepted = append(accepted, value)
		}
	}
	// Missing entries remain until a confirmed absence prevents resurrecting an expired container.
	for id, deadline := range a.expiries {
		if _, ok := next[id]; !ok {
			present := !inventoryOK
			for _, c := range containers {
				if c.DeploymentID == id {
					present = true
				}
			}
			if present {
				next[id] = deadline
				revisions[id] = a.expiryRevisions[id]
			}
		}
	}
	a.expiries = next
	a.expiryRevisions = revisions
	if err := a.saveExpiries(); err != nil {
		return err
	}
	a.expiryAcks = append([]rentalDeadline{}, accepted...)
	return nil
}
func (a *agent) expirySnapshot() []rentalDeadline {
	a.expiryMu.Lock()
	defer a.expiryMu.Unlock()
	return append([]rentalDeadline{}, a.expiryAcks...)
}
func (a *agent) enforceExpiries(ctx context.Context) error {
	a.expiryMu.Lock()
	due := []string{}
	for id, deadline := range a.expiries {
		if !time.Now().Before(deadline) {
			due = append(due, id)
		}
	}
	a.expiryMu.Unlock()
	var failure error
	for _, id := range due {
		raw, err := a.run(ctx, []string{"docker", "ps", "-aq", "--filter", "label=corematrix.deployment=" + id}, 20*time.Second, nil)
		if err != nil {
			failure = err
			continue
		}
		for _, container := range strings.Fields(raw) {
			if _, err = a.run(ctx, []string{"docker", "stop", "--time", "20", container}, 30*time.Second, nil); err != nil {
				failure = err
				continue
			}
			if _, err = a.run(ctx, []string{"docker", "rm", container}, 20*time.Second, nil); err != nil {
				failure = err
				continue
			}
		}
	}
	return failure
}
func (a *agent) rentalExpired(id string) bool {
	a.expiryMu.Lock()
	defer a.expiryMu.Unlock()
	deadline, ok := a.expiries[id]
	return ok && !time.Now().Before(deadline)
}
