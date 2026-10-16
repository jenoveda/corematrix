package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func workspaceToken(secret, id string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("corematrix-jupyter:" + id))
	return hex.EncodeToString(mac.Sum(nil))
}
func labBase(id string) string { return "/api/compute/rentals/" + id + "/lab/" }
func (c config) validateWorkspace(s spec) error {
	if s.WorkloadType != "gpu-rental" || c.WorkspaceImage == "" || s.ImageDigest != c.WorkspaceDigest {
		return diagnostic("workspace_image_mismatch")
	}
	if s.APIKeyEnv != c.WorkspaceKeyEnv || len(os.Getenv(c.WorkspaceKeyEnv)) < 32 {
		return diagnostic("workspace_key_missing")
	}
	if s.EndpointPort < 1024 || s.EndpointPort > 65535 || len(s.GPUUUIDs) < 1 || len(s.GPUUUIDs) > 64 {
		return diagnostic("invalid_gpu_spec")
	}
	seen := map[string]bool{}
	for _, id := range s.GPUUUIDs {
		if !gpuPattern.MatchString(id) || seen[id] {
			return diagnostic("invalid_gpu_spec")
		}
		seen[id] = true
	}
	return nil
}
func workspaceArgs(c config, j job, s spec) ([]string, string, error) {
	fingerprint, err := specHash(j.Spec)
	if err != nil {
		return nil, "", err
	}
	args := []string{"docker", "run", "-d", "--name", "corematrix-" + j.DeploymentID, "--restart", "unless-stopped", "--label", "corematrix.deployment=" + j.DeploymentID, "--label", "corematrix.job=" + j.ID, "--label", "corematrix.spec=" + fingerprint, "--label", "corematrix.port=" + strconv.Itoa(s.EndpointPort), "--gpus", `"device=` + strings.Join(s.GPUUUIDs, ",") + `"`, "--shm-size", c.ShmSize, "-p", c.WorkspaceBindIP + ":" + strconv.Itoa(s.EndpointPort) + ":8888", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512", "--cpus", strconv.Itoa(c.WorkspaceCPUs * len(s.GPUUUIDs)), "--memory", strconv.Itoa(c.WorkspaceMemoryMiB*len(s.GPUUUIDs)) + "m", "--memory-swap", strconv.Itoa(c.WorkspaceMemoryMiB*len(s.GPUUUIDs)) + "m", "-v", filepath.Join(c.WorkspaceDir, j.DeploymentID) + ":/workspace", "--workdir", "/workspace", "--env", "HOME=/workspace", "--env", "JUPYTER_CONFIG_DIR=/tmp/jupyter-config", "--env", "JUPYTER_RUNTIME_DIR=/tmp/jupyter-runtime", "--env", "JUPYTER_TOKEN", "--entrypoint", "python", c.WorkspaceImage, "-m", "jupyterlab", "--ServerApp.ip=0.0.0.0", "--ServerApp.port=8888", "--ServerApp.port_retries=0", "--ServerApp.open_browser=False", "--ServerApp.show_banner=False", "--ServerApp.allow_remote_access=True", "--ServerApp.root_dir=/workspace", "--ServerApp.base_url=" + labBase(j.DeploymentID)}
	if c.WorkspaceBindIP == "127.0.0.1" {
		args = append(args, "--ServerApp.trust_xheaders=True")
	}
	return args, fingerprint, nil
}
func prepareWorkspace(c config, id string) error {
	path := filepath.Join(c.WorkspaceDir, id)
	if !uuidPattern.MatchString(id) {
		return diagnostic("invalid_deployment_id")
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return diagnostic("invalid_workspace_path")
		}
	} else if !os.IsNotExist(err) {
		return diagnostic("workspace_directory_unavailable")
	}
	if os.MkdirAll(path, 0700) != nil || os.Chown(path, 1000, 1000) != nil {
		return diagnostic("workspace_directory_unavailable")
	}
	return nil
}
func (a *agent) workspaceHealthy(ctx context.Context, j job, s spec) bool {
	host := a.cfg.WorkspaceBindIP
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://%s:%d%sapi/status", host, s.EndpointPort, labBase(j.DeploymentID)), nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "token "+workspaceToken(os.Getenv(s.APIKeyEnv), j.DeploymentID))
	res, err := a.healthClient.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return false
	}
	var status struct {
		Started string `json:"started"`
	}
	return readJSON(res.Body, &status) == nil && status.Started != ""
}
func (a *agent) executeWorkspace(ctx context.Context, j job, s spec, l *lease, mutate func([]string, time.Duration, []string) error, find func() ([]string, error)) error {
	if a.rentalExpired(j.DeploymentID) {
		return diagnostic("rental_expired")
	}
	a.mu.RLock()
	ready := a.workspaceReady
	a.mu.RUnlock()
	if !ready || j.Kind != "start" {
		return diagnostic("workspace_not_ready")
	}
	if err := a.cfg.validateWorkspace(s); err != nil {
		return err
	}
	gpus, _, err := a.inventory(ctx)
	if err != nil {
		return err
	}
	for _, id := range s.GPUUUIDs {
		valid := false
		for _, g := range gpus {
			if g.UUID == id && !g.ExternalBusy {
				valid = true
			}
		}
		if !valid {
			return diagnostic("gpu_no_longer_available")
		}
	}
	args, fingerprint, err := workspaceArgs(a.cfg, j, s)
	if err != nil {
		return err
	}
	ids, err := find()
	if err != nil {
		return err
	}
	if len(ids) > 0 {
		raw, err := a.run(ctx, append([]string{"docker", "inspect"}, ids...), 20*time.Second, nil)
		if err != nil {
			return err
		}
		var items []dockerItem
		if json.Unmarshal([]byte(raw), &items) != nil || len(items) != 1 || items[0].Config.Labels["corematrix.spec"] != fingerprint || !items[0].State.Running {
			return diagnostic("container_reconciliation_required")
		}
	} else {
		if err = l.check(ctx); err != nil {
			return err
		}
		if err = prepareWorkspace(a.cfg, j.DeploymentID); err != nil {
			return err
		}
		env := []string{}
		for _, entry := range os.Environ() {
			if !strings.HasPrefix(entry, "JUPYTER_TOKEN=") {
				env = append(env, entry)
			}
		}
		env = append(env, "JUPYTER_TOKEN="+workspaceToken(os.Getenv(s.APIKeyEnv), j.DeploymentID))
		if a.rentalExpired(j.DeploymentID) {
			return diagnostic("rental_expired")
		}
		if err = mutate(args, 30*time.Second, env); err != nil {
			return err
		}
	}
	if err = a.report(ctx, j, l, "starting", ""); err != nil {
		return err
	}
	deadline := time.Now().Add(20 * time.Minute)
	for time.Now().Before(deadline) {
		if err = l.check(ctx); err != nil {
			return err
		}
		raw, err := a.run(ctx, []string{"docker", "inspect", "corematrix-" + j.DeploymentID}, 20*time.Second, nil)
		if err != nil {
			return err
		}
		var items []dockerItem
		if json.Unmarshal([]byte(raw), &items) != nil || len(items) != 1 || !items[0].State.Running {
			return diagnostic("container_exited")
		}
		if a.workspaceHealthy(ctx, j, s) {
			if _, err = a.heartbeat(ctx); err != nil {
				return err
			}
			return a.report(ctx, j, l, "healthy", "")
		}
		if !wait(ctx, 3*time.Second) {
			return diagnostic("lease_expired")
		}
	}
	return diagnostic("startup_timeout")
}
