package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

type agent struct {
	uptime               func() (float64, error)
	expiryMu             sync.Mutex
	expiries             map[string]time.Time
	expiryRevisions      map[string]int64
	expiryAcks           []rentalDeadline
	cfg                  config
	client, healthClient *http.Client
	run                  runFunc
	instance, boot       string
	heartbeatMu          sync.Mutex
	mu                   sync.RWMutex
	generation           *int64
	sequence             uint64
	ready                bool
	preflightError       string
	workspaceReady       bool
	workspaceError       string
}

func (a *agent) identity() identity {
	a.mu.RLock()
	defer a.mu.RUnlock()
	var generation *int64
	if a.generation != nil {
		n := *a.generation
		generation = &n
	}
	return identity{a.instance, generation}
}
func (a *agent) heartbeat(ctx context.Context) (string, error) {
	a.heartbeatMu.Lock()
	defer a.heartbeatMu.Unlock()
	a.mu.RLock()
	ready, workspaceReady := a.ready, a.workspaceReady
	inventoryError := ""
	a.mu.RUnlock()
	gpus, containers, err := a.inventory(ctx)
	if err != nil {
		inventoryError = err.Error()
		gpus = []gpu{}
		containers = []container{}
	} else {
		paths := []string{a.cfg.CacheDir}
		if a.cfg.WorkspaceImage != "" {
			paths = append(paths, a.cfg.WorkspaceDir)
		}
		for _, path := range paths {
			free, err := freeDisk(path)
			if err != nil {
				inventoryError = err.Error()
			} else if free < 1024*1024*1024 {
				inventoryError = "insufficient_disk_space"
			}
		}

	}
	a.sequence++
	payload := struct {
		identity
		BootID       string `json:"bootId"`
		Sequence     uint64 `json:"sequence"`
		Capabilities struct {
			Version          string `json:"agentVersion"`
			DockerReady      bool   `json:"dockerReady"`
			Image            string `json:"runtimeImageDigest"`
			WorkspaceImage   string `json:"workspaceImageDigest"`
			InferenceReady   bool   `json:"inferenceReady"`
			WorkspaceReady   bool   `json:"workspaceReady"`
			WorkspaceKeyEnv  string `json:"workspaceKeyEnv"`
			InferenceError   string `json:"inferenceError"`
			WorkspaceError   string `json:"workspaceError"`
			ExpirySupported  bool   `json:"expirySupported"`
			RenewalSupported bool   `json:"renewalSupported"`
		} `json:"capabilities"`
		ExpiryAcks     []rentalDeadline `json:"expiryAcks"`
		InventoryError *string          `json:"inventoryError"`
		GPUs           []gpu            `json:"gpus"`
		Containers     []container      `json:"containers"`
	}{identity: a.identity(), BootID: a.boot, Sequence: a.sequence, GPUs: gpus, Containers: containers}
	payload.Capabilities.Version = "4-go"
	payload.Capabilities.RenewalSupported = true
	payload.Capabilities.ExpirySupported = true
	payload.ExpiryAcks = a.expirySnapshot()
	payload.Capabilities.DockerReady = ready || workspaceReady
	payload.Capabilities.InferenceReady = ready
	payload.Capabilities.WorkspaceReady = workspaceReady
	payload.Capabilities.WorkspaceImage = a.cfg.WorkspaceDigest
	payload.Capabilities.WorkspaceKeyEnv = a.cfg.WorkspaceKeyEnv
	a.mu.RLock()
	payload.Capabilities.InferenceError = a.preflightError
	payload.Capabilities.WorkspaceError = a.workspaceError
	a.mu.RUnlock()
	payload.Capabilities.Image = a.cfg.Digest
	if inventoryError != "" {
		payload.InventoryError = &inventoryError
	}
	var reply struct {
		OK              bool             `json:"ok"`
		Generation      int64            `json:"generation"`
		ServerTime      time.Time        `json:"serverTime"`
		RentalDeadlines []rentalDeadline `json:"rentalDeadlines"`
	}
	started := time.Now()
	_, err = a.api(ctx, "/api/agent/heartbeat", payload, &reply)
	if err != nil {
		return inventoryError, err
	}
	if !reply.OK || reply.Generation < 1 {
		return inventoryError, diagnostic("invalid_heartbeat_response")
	}
	if reply.RentalDeadlines != nil {
		if err = a.updateExpiries(reply.RentalDeadlines, reply.ServerTime, time.Since(started), containers, inventoryError == ""); err != nil {
			return inventoryError, err
		}
	}
	a.mu.Lock()
	a.generation = &reply.Generation
	a.mu.Unlock()
	return inventoryError, nil
}
func (a *agent) runJob(ctx context.Context, j job, serverTime time.Time, started time.Time) {
	deadline, err := leaseDeadline(j.LeaseExpiresAt, serverTime, started)
	if err != nil {
		fmt.Println("agent_retry_pending")
		return
	}
	l := &lease{deadline: deadline}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); a.maintainLease(ctx, cancel, j, l) }()
	err = a.execute(ctx, j, l)
	if err != nil {
		_ = a.report(ctx, j, l, "failed", err.Error())
	}
	cancel()
	<-done
}
func (a *agent) runLoop(ctx context.Context) {
	var workers sync.WaitGroup
	workers.Add(4)
	go func() {
		defer workers.Done()
		for {
			if _, err := a.heartbeat(ctx); err != nil && ctx.Err() == nil {
				fmt.Println("agent_retry_pending")
			}
			if !wait(ctx, 10*time.Second) {
				return
			}
		}
	}()
	go func() {
		defer workers.Done()
		for {
			a.mu.RLock()
			ready := a.ready
			a.mu.RUnlock()
			if !ready && a.cfg.Image != "" {
				err := a.preflight(ctx)
				a.mu.Lock()
				a.ready = err == nil
				a.preflightError = ""
				if err != nil {
					a.preflightError = err.Error()
				}
				a.mu.Unlock()
			}
			if !wait(ctx, time.Minute) {
				return
			}
		}
	}()
	go func() {
		defer workers.Done()
		for {
			a.mu.RLock()
			ready := a.workspaceReady
			a.mu.RUnlock()
			if !ready && a.cfg.WorkspaceImage != "" {
				err := a.preflightImage(ctx, a.cfg.WorkspaceImage, a.cfg.WorkspaceDigest)
				a.mu.Lock()
				a.workspaceReady = err == nil
				a.workspaceError = ""
				if err != nil {
					a.workspaceError = err.Error()
				}
				a.mu.Unlock()
			}
			if !wait(ctx, time.Minute) {
				return
			}
		}
	}()
	go func() {
		defer workers.Done()
		for {
			if err := a.enforceExpiries(ctx); err != nil && ctx.Err() == nil {
				fmt.Println("expiry_cleanup_pending")
			}
			if !wait(ctx, time.Second) {
				return
			}
		}
	}()
	for ctx.Err() == nil {
		id := a.identity()
		if id.Generation != nil {
			var reply struct {
				Job *job `json:"job"`
			}
			started := time.Now()
			serverTime, err := a.api(ctx, "/api/agent/jobs/claim", id, &reply)
			if err != nil {
				if ctx.Err() == nil {
					fmt.Println("agent_retry_pending")
				}
			} else if reply.Job != nil {
				a.runJob(ctx, *reply.Job, serverTime, started)
			}
		}
		if !wait(ctx, 5*time.Second) {
			break
		}
	}
	workers.Wait()
}
func main() {
	if runtime.GOOS != "linux" {
		fmt.Fprintln(os.Stderr, "linux_required")
		os.Exit(1)
	}
	syscall.Umask(0077)
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	lock, err := lockNode(cfg.StateDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	defer lock.Close()
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || strings.TrimSpace(string(raw)) == "" {
		fmt.Fprintln(os.Stderr, "boot_id_unavailable")
		os.Exit(1)
	}
	a := &agent{cfg: cfg, client: httpClient(10 * time.Second), healthClient: httpClient(3 * time.Second), run: command, instance: newID(), boot: strings.TrimSpace(string(raw)), preflightError: "runtime_preflight_pending"}
	if err = a.loadExpiries(); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a.runLoop(ctx)
}
