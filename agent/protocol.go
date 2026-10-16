package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

type identity struct {
	InstanceID string `json:"instanceId"`
	Generation *int64 `json:"generation"`
}
type job struct {
	ID             string          `json:"id"`
	DeploymentID   string          `json:"deploymentId"`
	Kind           string          `json:"kind"`
	Attempt        int             `json:"attempt"`
	Generation     int64           `json:"generation"`
	LeaseToken     string          `json:"leaseToken"`
	LeaseExpiresAt time.Time       `json:"leaseExpiresAt"`
	Spec           json.RawMessage `json:"spec"`
}
type jobIdentity struct {
	identity
	Attempt    int    `json:"attempt"`
	LeaseToken string `json:"leaseToken"`
}
type lease struct {
	mu       sync.RWMutex
	deadline time.Time
}

func (l *lease) check(ctx context.Context) error {
	if ctx.Err() != nil {
		return diagnostic("lease_expired")
	}
	l.mu.RLock()
	deadline := l.deadline
	l.mu.RUnlock()
	if !time.Now().Before(deadline) {
		return diagnostic("lease_expired")
	}
	return nil
}
func (l *lease) set(deadline time.Time) { l.mu.Lock(); l.deadline = deadline; l.mu.Unlock() }
func jobAuth(instance string, j job) jobIdentity {
	generation := j.Generation
	return jobIdentity{identity: identity{instance, &generation}, Attempt: j.Attempt, LeaseToken: j.LeaseToken}
}
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("random_source_unavailable")
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func httpClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
}
func readJSON(r io.Reader, dst any) error {
	raw, err := io.ReadAll(io.LimitReader(r, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return diagnostic("invalid_response")
	}
	if json.Unmarshal(raw, dst) != nil {
		return diagnostic("invalid_response")
	}
	return nil
}
func (a *agent) api(ctx context.Context, path string, data, dst any) (time.Time, error) {
	raw, err := json.Marshal(data)
	if err != nil {
		return time.Time{}, diagnostic("invalid_request")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.cfg.URL+path, bytes.NewReader(raw))
	if err != nil {
		return time.Time{}, diagnostic("control_plane_unavailable")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	res, err := a.client.Do(req)
	if err != nil {
		return time.Time{}, diagnostic("control_plane_unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if res.StatusCode == 401 || res.StatusCode == 409 {
			return time.Time{}, diagnostic("control_plane_rejected")
		}
		return time.Time{}, diagnostic("control_plane_unavailable")
	}
	if err = readJSON(res.Body, dst); err != nil {
		return time.Time{}, err
	}
	serverTime, _ := http.ParseTime(res.Header.Get("Date"))
	return serverTime, nil
}

// Derive a conservative monotonic lease window from server time, independent of node clock skew.
func leaseDeadline(expiry, serverTime time.Time, started time.Time) (time.Time, error) {
	if serverTime.IsZero() {
		return time.Time{}, diagnostic("invalid_lease")
	}
	remaining := expiry.Sub(serverTime) - time.Since(started) - 5*time.Second
	if remaining > 45*time.Second {
		remaining = 45 * time.Second
	}
	if remaining <= 0 {
		return time.Time{}, diagnostic("lease_expired")
	}
	return time.Now().Add(remaining), nil
}
func wait(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
func (a *agent) report(ctx context.Context, j job, l *lease, event, message string) error {
	payload := struct {
		jobIdentity
		EventID string `json:"eventId"`
		Event   string `json:"event"`
		Message string `json:"message"`
	}{jobAuth(a.instance, j), newID(), event, message}
	for {
		if err := l.check(ctx); err != nil {
			return err
		}
		var reply struct {
			OK bool `json:"ok"`
		}
		_, err := a.api(ctx, "/api/agent/jobs/"+j.ID+"/report", payload, &reply)
		if err == nil && reply.OK {
			return nil
		}
		if err != nil && err.Error() == "control_plane_rejected" {
			return err
		}
		if !wait(ctx, 3*time.Second) {
			return diagnostic("lease_expired")
		}
	}
}
func (a *agent) maintainLease(ctx context.Context, cancel context.CancelFunc, j job, l *lease) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	last := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if l.check(ctx) != nil {
				cancel()
				return
			}
			if time.Since(last) < 20*time.Second {
				continue
			}
			started := time.Now()
			var reply struct {
				Expires time.Time `json:"leaseExpiresAt"`
			}
			serverTime, err := a.api(ctx, "/api/agent/jobs/"+j.ID+"/renew", jobAuth(a.instance, j), &reply)
			if err != nil {
				if err.Error() == "control_plane_rejected" {
					cancel()
					return
				}
				last = time.Now().Add(-15 * time.Second)
				continue
			}
			deadline, err := leaseDeadline(reply.Expires, serverTime, started)
			if err != nil || l.check(ctx) != nil {
				cancel()
				return
			}
			l.set(deadline)
			last = time.Now()
		}
	}
}
