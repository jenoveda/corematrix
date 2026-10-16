package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func expiryAgent(t *testing.T) *agent {
	t.Helper()
	c := testConfig(t)
	c.StateDir = t.TempDir()
	return &agent{cfg: c, boot: "boot-a", uptime: func() (float64, error) { return 10000, nil }, expiries: map[string]time.Time{}}
}
func TestExpiryPersistenceAndBootChange(t *testing.T) {
	a := expiryAgent(t)
	now := time.Now()
	values := []rentalDeadline{{testID, now.Add(time.Hour), 0}}
	if err := a.updateExpiries(values, now, 2*time.Second, nil, true); err != nil {
		t.Fatal(err)
	}
	original := a.expiries[testID]
	if err := a.updateExpiries(values, now.Add(-time.Minute), 0, nil, true); err != nil {
		t.Fatal(err)
	}
	if a.expiries[testID].After(original) {
		t.Fatal("clock correction extended paid rental")
	}
	if len(a.expirySnapshot()) != 1 {
		t.Fatal("persisted expiry not acknowledged")
	}
	info, err := os.Stat(filepath.Join(a.cfg.StateDir, "rental-expiries.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("expiry state not private")
	}
	b := expiryAgent(t)
	b.cfg.StateDir = a.cfg.StateDir
	b.uptime = func() (float64, error) { return 11800, nil }
	if err = b.loadExpiries(); err != nil {
		t.Fatal(err)
	}
	remaining := time.Until(b.expiries[testID])
	if remaining < 1795*time.Second || remaining > 1800*time.Second {
		t.Fatalf("restart extended deadline: %v", remaining)
	}
	b.boot = "boot-b"
	b.uptime = func() (float64, error) { return 1, nil }
	if err = b.loadExpiries(); err != nil || !b.rentalExpired(testID) {
		t.Fatal("new boot must expire old rentals conservatively", err)
	}
}
func TestExpiryPersistenceFailureNeverAcknowledges(t *testing.T) {
	a := expiryAgent(t)
	a.cfg.StateDir = filepath.Join(a.cfg.StateDir, "missing")
	now := time.Now()
	if a.updateExpiries([]rentalDeadline{{testID, now.Add(time.Hour), 0}}, now, 0, nil, true) == nil {
		t.Fatal("missing state directory accepted")
	}
	if len(a.expirySnapshot()) != 0 {
		t.Fatal("unpersisted protection acknowledged")
	}
	a.cfg.StateDir = t.TempDir()
	if err := os.WriteFile(filepath.Join(a.cfg.StateDir, "rental-expiries.json"), []byte(`{"bootId":"boot-a","deadlines":{"not-a-uuid":123}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if a.loadExpiries() == nil {
		t.Fatal("corrupt state accepted")
	}
}
func TestExpiryOfflineStopAndRetry(t *testing.T) {
	a := expiryAgent(t)
	a.expiries[testID] = time.Now().Add(-time.Second)
	a.expiries[testJobID] = time.Now().Add(time.Hour)
	fail := true
	calls := []string{}
	a.run = func(_ context.Context, args []string, _ time.Duration, _ []string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		switch args[1] {
		case "ps":
			return "container-a", nil
		case "stop":
			if fail {
				return "", diagnostic("docker_unavailable")
			}
		}
		return "", nil
	}
	if a.enforceExpiries(context.Background()) == nil {
		t.Fatal("failed stop ignored")
	}
	for _, c := range calls {
		if strings.Contains(c, "docker rm") {
			t.Fatal("removed before stopped")
		}
	}
	fail = false
	calls = nil
	if err := a.enforceExpiries(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 3 || !strings.Contains(calls[0], testID) || calls[2] != "docker rm container-a" {
		t.Fatalf("incorrect cleanup: %v", calls)
	}
	for _, c := range calls {
		if strings.Contains(c, testJobID) || strings.Contains(c, "-v") {
			t.Fatal("unexpired rental or workspace deleted")
		}
	}
	if !a.rentalExpired(testID) {
		t.Fatal("expired start no longer fenced")
	}
	if err := a.executeWorkspace(context.Background(), job{DeploymentID: testID}, spec{}, &lease{}, nil, nil); err == nil || err.Error() != "rental_expired" {
		t.Fatal("expired start accepted", err)
	}
}
func TestExpiryPruningRequiresConfirmedAbsence(t *testing.T) {
	a := expiryAgent(t)
	a.expiries[testID] = time.Now().Add(-time.Second)
	now := time.Now()
	if err := a.updateExpiries([]rentalDeadline{}, now, 0, nil, false); err != nil {
		t.Fatal(err)
	}
	if !a.rentalExpired(testID) {
		t.Fatal("inventory error removed local protection")
	}
	if err := a.updateExpiries([]rentalDeadline{}, now, 0, []container{{DeploymentID: testID}}, true); err != nil {
		t.Fatal(err)
	}
	if !a.rentalExpired(testID) {
		t.Fatal("present container lost protection")
	}
	if err := a.updateExpiries([]rentalDeadline{}, now, 0, nil, true); err != nil {
		t.Fatal(err)
	}
	if len(a.expiries) != 0 {
		t.Fatal("confirmed historical rental never pruned")
	}
}
func TestExpiryConcurrentHeartbeatAndEnforcement(t *testing.T) {
	a := expiryAgent(t)
	a.run = func(context.Context, []string, time.Duration, []string) (string, error) { return "", nil }
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			now := time.Now()
			if err := a.updateExpiries([]rentalDeadline{{testID, now.Add(time.Hour), 0}}, now, 0, nil, true); err != nil {
				t.Error(err)
			}
			a.expirySnapshot()
			a.rentalExpired(testID)
			if err := a.enforceExpiries(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
}

func TestRenewalRevisionPersistsAndFencesStaleDeadlines(t *testing.T) {
	a := expiryAgent(t)
	now := time.Now()
	original := rentalDeadline{testID, now.Add(time.Hour), 0}
	if err := a.updateExpiries([]rentalDeadline{original}, now, 0, nil, true); err != nil {
		t.Fatal(err)
	}
	before := a.expiries[testID]
	renewed := rentalDeadline{testID, now.Add(2 * time.Hour), 1}
	if err := a.updateExpiries([]rentalDeadline{renewed}, now, 0, nil, true); err != nil {
		t.Fatal(err)
	}
	if !a.expiries[testID].After(before) || a.expirySnapshot()[0].Revision != 1 {
		t.Fatal("renewal did not extend durable deadline")
	}
	saved := a.expiries[testID]
	if err := a.updateExpiries([]rentalDeadline{original}, now, 0, nil, true); err != nil {
		t.Fatal(err)
	}
	if !a.expiries[testID].Equal(saved) || len(a.expirySnapshot()) != 0 {
		t.Fatal("stale heartbeat rolled back renewal")
	}
	b := expiryAgent(t)
	b.cfg.StateDir = a.cfg.StateDir
	if err := b.loadExpiries(); err != nil {
		t.Fatal(err)
	}
	if b.expiryRevisions[testID] != 1 || time.Until(b.expiries[testID]) < 119*time.Minute {
		t.Fatal("restart lost renewal")
	}
	// Same revision may shorten a deadline for termination, but can never lengthen it again.
	stopped := rentalDeadline{testID, now.Add(-time.Second), 1}
	if err := b.updateExpiries([]rentalDeadline{stopped}, now, 0, nil, true); err != nil {
		t.Fatal(err)
	}
	if err := b.updateExpiries([]rentalDeadline{renewed}, now, 0, nil, true); err != nil {
		t.Fatal(err)
	}
	if !b.rentalExpired(testID) || len(b.expirySnapshot()) != 0 {
		t.Fatal("cancelled rental resurrected or falsely acknowledged")
	}
}
func TestRenewalCannotReviveExpiredRentalsOrAcknowledgeFailedPersistence(t *testing.T) {
	a := expiryAgent(t)
	now := time.Now()
	a.expiries[testID] = now.Add(-time.Second)
	if err := a.updateExpiries([]rentalDeadline{{testID, now.Add(time.Hour), 1}}, now, 0, nil, true); err != nil {
		t.Fatal(err)
	}
	if !a.rentalExpired(testID) || len(a.expirySnapshot()) != 0 {
		t.Fatal("late renewal revived an expired rental")
	}
	a = expiryAgent(t)
	if err := a.updateExpiries([]rentalDeadline{{testID, now.Add(time.Hour), 0}}, now, 0, nil, true); err != nil {
		t.Fatal(err)
	}
	a.cfg.StateDir = filepath.Join(a.cfg.StateDir, "missing")
	if a.updateExpiries([]rentalDeadline{{testID, now.Add(2 * time.Hour), 1}}, now, 0, nil, true) == nil {
		t.Fatal("failed renewal persistence ignored")
	}
	if a.expirySnapshot()[0].Revision != 0 {
		t.Fatal("unpersisted renewal acknowledged")
	}
}
