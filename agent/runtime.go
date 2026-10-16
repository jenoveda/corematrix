package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

type runFunc func(context.Context, []string, time.Duration, []string) (string, error)
type boundedOutput struct{ buffer bytes.Buffer }

func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > 1024*1024 {
		return 0, diagnostic("command_output_too_large")
	}
	return b.buffer.Write(p)
}
func command(ctx context.Context, args []string, timeout time.Duration, env []string) (string, error) {
	if len(args) == 0 {
		return "", diagnostic("command_failed")
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Env = env
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	var out boundedOutput
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", diagnostic("command_failed")
	}
	return strings.TrimSpace(out.buffer.String()), nil
}

type gpu struct {
	UUID               string `json:"uuid"`
	Index              int    `json:"index"`
	Name               string `json:"name"`
	TotalMemoryMiB     int    `json:"totalMemoryMiB"`
	UsedMemoryMiB      *int   `json:"usedMemoryMiB"`
	UtilizationPercent *int   `json:"utilizationPercent"`
	TemperatureC       *int   `json:"temperatureC"`
	ExternalBusy       bool   `json:"externalBusy"`
}
type container struct {
	DeploymentID string `json:"deploymentId"`
	ContainerID  string `json:"containerId"`
	State        string `json:"state"`
	EndpointPort int    `json:"endpointPort"`
}
type dockerItem struct {
	ID          string   `json:"Id"`
	RepoDigests []string `json:"RepoDigests"`
	Config      struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	State struct {
		Status  string `json:"Status"`
		Running bool   `json:"Running"`
	} `json:"State"`
}

func csvRows(raw string) ([][]string, error) {
	r := csv.NewReader(strings.NewReader(raw))
	r.TrimLeadingSpace = true
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return nil, diagnostic("invalid_gpu_inventory")
	}
	for i := range rows {
		for j := range rows[i] {
			rows[i][j] = strings.TrimSpace(rows[i][j])
		}
	}
	return rows, nil
}
func metric(raw string, max int) (*int, error) {
	switch strings.ToLower(raw) {
	case "n/a", "[n/a]", "not supported", "[not supported]", "":
		return nil, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || n > max {
		return nil, diagnostic("invalid_gpu_inventory")
	}
	return &n, nil
}
func parseGPUs(raw, processes string, owned map[string]bool) ([]gpu, error) {
	busy := map[string]bool{}
	rows, err := csvRows(processes)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		if len(r) != 2 || !gpuPattern.MatchString(r[0]) {
			return nil, diagnostic("invalid_process_inventory")
		}
		pid, err := strconv.Atoi(r[1])
		if err != nil || pid <= 0 {
			return nil, diagnostic("invalid_process_inventory")
		}
		if !owned[r[1]] {
			busy[r[0]] = true
		}
	}
	rows, err = csvRows(raw)
	if err != nil {
		return nil, err
	}
	gpus := make([]gpu, 0, len(rows))
	seen := map[string]bool{}
	for _, r := range rows {
		if len(r) != 8 {
			return nil, diagnostic("invalid_gpu_inventory")
		}
		switch strings.ToLower(r[7]) {
		case "disabled", "n/a", "[n/a]", "not supported", "[not supported]":
		default:
			return nil, diagnostic("mig_not_supported")
		}
		index, e1 := strconv.Atoi(r[0])
		total, e2 := strconv.Atoi(r[3])
		if e1 != nil || index < 0 || index > 255 || e2 != nil || total < 1 || total > 10000000 || !gpuPattern.MatchString(r[1]) || seen[r[1]] || r[2] == "" {
			return nil, diagnostic("invalid_gpu_inventory")
		}
		seen[r[1]] = true
		used, err := metric(r[4], 10000000)
		if err != nil {
			return nil, err
		}
		util, err := metric(r[5], 100)
		if err != nil {
			return nil, err
		}
		temp, err := metric(r[6], 200)
		if err != nil {
			return nil, err
		}
		gpus = append(gpus, gpu{r[1], index, r[2], total, used, util, temp, busy[r[1]]})
	}
	if len(gpus) == 0 || len(gpus) > 64 {
		return nil, diagnostic("no_supported_gpus")
	}
	return gpus, nil
}
func (a *agent) inventory(ctx context.Context) ([]gpu, []container, error) {
	raw, err := a.run(ctx, []string{"docker", "ps", "-aq", "--filter", "label=corematrix.deployment"}, 20*time.Second, nil)
	if err != nil {
		return nil, nil, err
	}
	ids := strings.Fields(raw)
	if len(ids) > 256 {
		return nil, nil, diagnostic("container_inventory_too_large")
	}
	items := []dockerItem{}
	if len(ids) > 0 {
		raw, err = a.run(ctx, append([]string{"docker", "inspect"}, ids...), 20*time.Second, nil)
		if err != nil {
			return nil, nil, err
		}
		if json.Unmarshal([]byte(raw), &items) != nil || len(items) != len(ids) {
			return nil, nil, diagnostic("invalid_container_inventory")
		}
	}
	containers := make([]container, 0, len(items))
	owned := map[string]bool{}
	for _, item := range items {
		labels := item.Config.Labels
		port, err := strconv.Atoi(labels["corematrix.port"])
		if err != nil || port < 1024 || port > 65535 || !uuidPattern.MatchString(labels["corematrix.deployment"]) || item.ID == "" {
			return nil, nil, diagnostic("invalid_container_inventory")
		}
		containers = append(containers, container{labels["corematrix.deployment"], item.ID, item.State.Status, port})
		if item.State.Running {
			top, err := a.run(ctx, []string{"docker", "top", item.ID, "-eo", "pid"}, 20*time.Second, nil)
			if err != nil {
				return nil, nil, err
			}
			lines := strings.Split(strings.TrimSpace(top), "\n")
			if len(lines) < 2 {
				return nil, nil, diagnostic("invalid_process_inventory")
			}
			for _, line := range lines[1:] {
				pid := strings.TrimSpace(line)
				n, err := strconv.Atoi(pid)
				if err != nil || n <= 0 {
					return nil, nil, diagnostic("invalid_process_inventory")
				}
				owned[pid] = true
			}
		}
	}
	raw, err = a.run(ctx, []string{"nvidia-smi", "--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu,mig.mode.current", "--format=csv,noheader,nounits"}, 20*time.Second, nil)
	if err != nil {
		return nil, nil, err
	}
	processes, err := a.run(ctx, []string{"nvidia-smi", "--query-compute-apps=gpu_uuid,pid", "--format=csv,noheader,nounits"}, 20*time.Second, nil)
	if err != nil {
		return nil, nil, err
	}
	gpus, err := parseGPUs(raw, processes, owned)
	return gpus, containers, err
}
func (a *agent) preflight(ctx context.Context) error {
	return a.preflightImage(ctx, a.cfg.Image, a.cfg.Digest)
}
func (a *agent) preflightImage(ctx context.Context, image, expectedDigest string) error {
	if _, err := a.run(ctx, []string{"docker", "info", "--format", "{{.ServerVersion}}"}, 20*time.Second, nil); err != nil {
		return err
	}
	args := []string{"docker", "image", "inspect", image}
	raw, err := a.run(ctx, args, 20*time.Second, nil)
	if err != nil {
		if _, err = a.run(ctx, []string{"docker", "pull", image}, 20*time.Minute, nil); err != nil {
			return err
		}
		raw, err = a.run(ctx, args, 20*time.Second, nil)
		if err != nil {
			return err
		}
	}
	var info []dockerItem
	if json.Unmarshal([]byte(raw), &info) != nil || len(info) != 1 {
		return diagnostic("image_digest_mismatch")
	}
	valid := false
	for _, digest := range info[0].RepoDigests {
		if strings.HasSuffix(digest, "@"+expectedDigest) {
			valid = true
		}
	}
	if !valid {
		return diagnostic("image_digest_mismatch")
	}
	_, err = a.run(ctx, []string{"docker", "run", "--rm", "--gpus", "all", "--entrypoint", "nvidia-smi", image, "--query-gpu=uuid", "--format=csv,noheader"}, time.Minute, nil)
	if err == nil && image == a.cfg.WorkspaceImage {
		_, err = a.run(ctx, []string{"docker", "run", "--rm", "--entrypoint", "python", image, "-c", "import jupyterlab"}, time.Minute, nil)
	}
	return err
}

// Preserve the previous Agent's sorted, ASCII JSON hash so existing containers are reusable.
func specHash(raw json.RawMessage) (string, error) {
	var value map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil || value == nil {
		return "", diagnostic("invalid_runtime_spec")
	}
	var canonical bytes.Buffer
	encoder := json.NewEncoder(&canonical)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(value) != nil {
		return "", diagnostic("invalid_runtime_spec")
	}
	var ascii strings.Builder
	for _, r := range strings.TrimSuffix(canonical.String(), "\n") {
		if r < 128 {
			ascii.WriteRune(r)
		} else if r <= 0xffff {
			fmt.Fprintf(&ascii, `\u%04x`, r)
		} else {
			high, low := utf16.EncodeRune(r)
			fmt.Fprintf(&ascii, `\u%04x\u%04x`, high, low)
		}
	}
	sum := sha256.Sum256([]byte(ascii.String()))
	return hex.EncodeToString(sum[:]), nil
}
func runArgs(c config, j job, s spec) ([]string, string, error) {
	fingerprint, err := specHash(j.Spec)
	if err != nil {
		return nil, "", err
	}
	published := strconv.Itoa(s.EndpointPort) + ":8000"
	if c.InferenceLoopback {
		published = "127.0.0.1:" + published
	}
	// Docker parses --gpus as CSV; quote the whole device field for multiple UUIDs.
	args := []string{"docker", "run", "-d", "--name", "corematrix-" + j.DeploymentID, "--restart", "unless-stopped", "--label", "corematrix.deployment=" + j.DeploymentID, "--label", "corematrix.job=" + j.ID, "--label", "corematrix.spec=" + fingerprint, "--label", "corematrix.port=" + strconv.Itoa(s.EndpointPort), "--gpus", `"device=` + strings.Join(s.GPUUUIDs, ",") + `"`, "--shm-size", c.ShmSize, "-p", published, "-v", c.ModelDir + ":/models:ro", "-v", c.CacheDir + ":/root/.cache/huggingface", "--env", "VLLM_API_KEY", c.Image, "--model", s.Artifact, "--revision", s.Revision, "--served-model-name", s.ServedModelName, "--tensor-parallel-size", strconv.Itoa(s.TensorParallelSize), "--dtype", s.DType, "--max-model-len", strconv.Itoa(s.MaxModelLen), "--host", "0.0.0.0", "--port", "8000"}
	return args, fingerprint, nil
}
func (a *agent) localHealthy(ctx context.Context, s spec) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/v1/models", s.EndpointPort), nil)
	if err != nil {
		return false
	}
	if s.WorkloadType == "gpu-rental" {
		return false
	}
	if s.APIKeyEnv != "" {
		req.Header.Set("Authorization", "Bearer "+os.Getenv(s.APIKeyEnv))
	}
	res, err := a.healthClient.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return false
	}
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if readJSON(res.Body, &list) != nil {
		return false
	}
	for _, m := range list.Data {
		if m.ID == s.ServedModelName {
			return true
		}
	}
	return false
}
func (a *agent) execute(ctx context.Context, j job, l *lease) error {
	if !uuidPattern.MatchString(j.DeploymentID) || !uuidPattern.MatchString(j.ID) || j.Attempt < 1 || j.Generation < 1 || j.LeaseToken == "" {
		return diagnostic("invalid_job")
	}
	var s spec
	if json.Unmarshal(j.Spec, &s) != nil {
		return diagnostic("invalid_runtime_spec")
	}
	// Every Docker mutation checks the current lease immediately before execution.
	mutate := func(args []string, timeout time.Duration, env []string) error {
		if err := l.check(ctx); err != nil {
			return err
		}
		_, err := a.run(ctx, args, timeout, env)
		return err
	}
	find := func() ([]string, error) {
		raw, err := a.run(ctx, []string{"docker", "ps", "-aq", "--filter", "label=corematrix.deployment=" + j.DeploymentID}, 20*time.Second, nil)
		return strings.Fields(raw), err
	}
	if j.Kind == "stop" {
		if err := l.check(ctx); err != nil {
			return err
		}
		ids, err := find()
		if err != nil {
			return err
		}
		for _, id := range ids {
			if err = mutate([]string{"docker", "stop", "--time", "20", id}, 30*time.Second, nil); err != nil {
				return err
			}
			if err = mutate([]string{"docker", "rm", id}, 20*time.Second, nil); err != nil {
				return err
			}
		}
		inventoryError, err := a.heartbeat(ctx)
		if err != nil {
			return err
		}
		if inventoryError != "" {
			return diagnostic("stop_inventory_unavailable")
		}
		return a.report(ctx, j, l, "stopped", "")
	}
	a.mu.RLock()
	ready := a.ready
	a.mu.RUnlock()
	if s.WorkloadType == "gpu-rental" {
		return a.executeWorkspace(ctx, j, s, l, mutate, find)
	}
	if s.WorkloadType != "" && s.WorkloadType != "inference" {
		return diagnostic("invalid_workload_type")
	}
	if j.Kind != "start" || !ready {
		return diagnostic("runtime_not_ready")
	}
	if err := a.cfg.validateSpec(s); err != nil {
		return err
	}
	gpus, _, err := a.inventory(ctx)
	if err != nil {
		return err
	}
	for _, id := range s.GPUUUIDs {
		valid := false
		for _, g := range gpus {
			if g.UUID == id && !g.ExternalBusy && g.TotalMemoryMiB >= s.MinGPUMemoryMiB {
				valid = true
			}
		}
		if !valid {
			return diagnostic("gpu_no_longer_available")
		}
	}
	args, fingerprint, err := runArgs(a.cfg, j, s)
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
	}
	if len(ids) == 0 {
		env := []string{}
		for _, entry := range os.Environ() {
			if !strings.HasPrefix(entry, "VLLM_API_KEY=") {
				env = append(env, entry)
			}
		}
		env = append(env, "VLLM_API_KEY="+os.Getenv(s.APIKeyEnv))
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
		if a.localHealthy(ctx, s) {
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
