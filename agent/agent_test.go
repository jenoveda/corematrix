package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

const testID = "12345678-1234-1234-1234-123456789012"
const testJobID = "12345678-1234-1234-1234-123456789013"
const legacySpec = `{"imageDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","gpuUuids":["GPU-a","GPU-b"],"tensorParallelSize":2,"artifact":"Example/model","revision":"abc123","dtype":"auto","endpointPort":8000,"maxModelLen":4096,"minGpuMemoryMiB":24000,"servedModelName":"public-model","apiKeyEnv":"INFERENCE_TEST"}`

func testConfig(t *testing.T) config {
	t.Helper()
	dir := t.TempDir()
	return config{Image: "runtime@sha256:" + strings.Repeat("a", 64), Digest: "sha256:" + strings.Repeat("a", 64), ModelDir: dir, CacheDir: dir, WorkspaceDir: dir, WorkspaceImage: "lab@sha256:" + strings.Repeat("b", 64), WorkspaceDigest: "sha256:" + strings.Repeat("b", 64), WorkspaceKeyEnv: "INFERENCE_JUPYTER_KEY", WorkspaceBindIP: "127.0.0.1", WorkspaceCPUs: 4, WorkspaceMemoryMiB: 16384, ShmSize: "8g"}
}
func TestInventory(t *testing.T) {
	g, err := parseGPUs("0, GPU-a, Example, 24000, 500, N/A, 43, Disabled\n1, GPU-b, Example, 24000, 0, 0, N/A, N/A", "GPU-a, 22\nGPU-b, 11", map[string]bool{"11": true})
	if err != nil || len(g) != 2 || !g[0].ExternalBusy || g[0].UtilizationPercent != nil || g[1].ExternalBusy || g[1].TemperatureC != nil {
		t.Fatalf("invalid parsed inventory: %+v %v", g, err)
	}
	for _, raw := range []string{"", "bad,csv", "0, GPU-a, X, 24000, 0, 0, 43, Enabled", "0, GPU-a, X, N/A, 0, 0, 43, Disabled", "0, GPU-a, X, 24000, 0, 101, 43, Disabled"} {
		if _, err := parseGPUs(raw, "", nil); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	if _, err := parseGPUs("0, GPU-a, X, 24000, 0, 0, 43, Disabled", "GPU-a, invalid", nil); err == nil {
		t.Fatal("invalid PID accepted")
	}
}
func TestLegacyHashAndSpecBoundaries(t *testing.T) {
	c := testConfig(t)
	t.Setenv("INFERENCE_TEST", "secret-value")
	var s spec
	if err := json.Unmarshal([]byte(legacySpec), &s); err != nil {
		t.Fatal(err)
	}
	if err := c.validateSpec(s); err != nil {
		t.Fatal(err)
	}
	args, hash, err := runArgs(c, job{ID: testJobID, DeploymentID: testID, Spec: json.RawMessage(legacySpec)}, s)
	if err != nil || hash != "20c1b8410a67a18b27f900300fa2a28a1a8732dff29cb8392f8fa7ed3bcc751c" {
		t.Fatalf("Python container hash changed: %s %v", hash, err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, `"device=GPU-a,GPU-b"`) || strings.Contains(joined, "secret-value") || strings.Contains(joined, "--privileged") {
		t.Fatal("unsafe Docker args")
	}
	for _, change := range []func(*spec){func(s *spec) { s.Artifact = "/models/../etc" }, func(s *spec) { s.Artifact = "bad;echo" }, func(s *spec) { s.ImageDigest = "wrong" }, func(s *spec) { s.Revision = "main" }, func(s *spec) { s.TensorParallelSize = 1 }, func(s *spec) { s.ServedModelName = "--evil" }, func(s *spec) { s.GPUUUIDs = []string{"GPU-a", "GPU-a"} }} {
		copy := s
		change(&copy)
		if c.validateSpec(copy) == nil {
			t.Fatal("unsafe spec accepted")
		}
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(c.ModelDir, "escape")); err != nil {
		t.Fatal(err)
	}
	s.Artifact = "/models/escape"
	if c.validateSpec(s) == nil {
		t.Fatal("symlink escaped model root")
	}
}
func TestWorkspaceIsolationAndCredentials(t *testing.T) {
	c := testConfig(t)
	t.Setenv(c.WorkspaceKeyEnv, strings.Repeat("s", 32))
	s := spec{WorkloadType: "gpu-rental", ImageDigest: c.WorkspaceDigest, APIKeyEnv: c.WorkspaceKeyEnv, GPUUUIDs: []string{"GPU-a"}, EndpointPort: 8000}
	if err := c.validateWorkspace(s); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(s)
	args, _, err := workspaceArgs(c, job{ID: testJobID, DeploymentID: testID, Spec: raw}, s)
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Join(args, " ")
	for _, required := range []string{"--user 1000:1000", "--cap-drop ALL", "--security-opt no-new-privileges", "--cpus 4", "--memory 16384m", "--env JUPYTER_TOKEN", "--ServerApp.trust_xheaders=True", labBase(testID)} {
		if !strings.Contains(text, required) {
			t.Fatalf("missing isolation flag: %s", required)
		}
	}
	c.WorkspaceBindIP = "0.0.0.0"
	publicArgs, _, err := workspaceArgs(c, job{ID: testJobID, DeploymentID: testID, Spec: raw}, s)
	if err != nil || strings.Contains(strings.Join(publicArgs, " "), "trust_xheaders") {
		t.Fatal("public binding trusted unvalidated proxy headers")
	}
	token := workspaceToken(strings.Repeat("s", 32), testID)
	if len(token) != 64 || token == workspaceToken(strings.Repeat("s", 32), testJobID) || strings.Contains(text, token) || strings.Contains(text, strings.Repeat("s", 32)) {
		t.Fatal("workspace credentials exposed or shared")
	}
	s.ImageDigest = c.Digest
	if c.validateWorkspace(s) == nil {
		t.Fatal("inference image accepted for workspace")
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(c.WorkspaceDir, testID)); err != nil {
		t.Fatal(err)
	}
	if prepareWorkspace(c, testID) == nil {
		t.Fatal("workspace symlink accepted")
	}
}
func TestConfigValidationAndLock(t *testing.T) {
	root := t.TempDir()
	for key, value := range map[string]string{"COREMATRIX_URL": "https://control.example.com", "COREMATRIX_AGENT_TOKEN": "node_" + strings.Repeat("a", 43), "COREMATRIX_RUNTIME_IMAGE": "", "COREMATRIX_WORKSPACE_IMAGE": "lab@sha256:" + strings.Repeat("b", 64), "COREMATRIX_WORKSPACE_KEY_ENV": "INFERENCE_JUPYTER_KEY", "INFERENCE_JUPYTER_KEY": strings.Repeat("s", 32), "COREMATRIX_SHM_SIZE": "8g", "COREMATRIX_MODEL_DIR": root + "/models", "COREMATRIX_CACHE_DIR": root + "/cache", "COREMATRIX_AGENT_STATE_DIR": root + "/state", "COREMATRIX_WORKSPACE_DIR": root + "/workspaces"} {
		t.Setenv(key, value)
	}
	c, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.Image != "" || c.WorkspaceDigest == "" {
		t.Fatal("rental-only node requires model runtime")
	}
	t.Setenv("COREMATRIX_NODE_SCOPED_KEYS", "invalid")
	if _, err := loadConfig(); err == nil {
		t.Fatal("invalid scoped key mode accepted")
	}
	t.Setenv("COREMATRIX_NODE_SCOPED_KEYS", "1")
	t.Setenv("INFERENCE_JUPYTER_KEY", "")
	if scoped, err := loadConfig(); err != nil || !scoped.NodeScopedKeys || scoped.WorkspaceKeyEnv != "INFERENCE_COREMATRIX_NODE_WORKSPACE" {
		t.Fatal("scoped node required a platform-wide secret", err)
	}
	lock, err := lockNode(c.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := lockNode(c.StateDir); err == nil {
		second.Close()
		t.Fatal("duplicate agent allowed")
	}
	lock.Close()
	t.Setenv("COREMATRIX_URL", "http://remote.example.com")
	if _, err := loadConfig(); err == nil {
		t.Fatal("insecure remote URL accepted")
	}
	t.Setenv("COREMATRIX_URL", "https://control.example.com?token=secret")
	if _, err := loadConfig(); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("URL query accepted or leaked")
	}
}
func TestScopedHeartbeatBootstrapsOnlyValidatedCredentials(t *testing.T) {
	inference, workspace := strings.Repeat("a", 64), strings.Repeat("b", 64)
	t.Setenv("INFERENCE_COREMATRIX_NODE_INFERENCE", "")
	t.Setenv("INFERENCE_COREMATRIX_NODE_WORKSPACE", "")
	valid := false
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Capabilities struct {
				NodeScopedKeys bool `json:"nodeScopedKeys"`
			} `json:"capabilities"`
		}
		json.NewDecoder(r.Body).Decode(&payload)
		if !payload.Capabilities.NodeScopedKeys {
			t.Error("scoped capability missing")
		}
		w.Header().Set("Content-Type", "application/json")
		if valid {
			fmt.Fprintf(w, `{"ok":true,"generation":1,"credentials":{"inference":%q,"workspace":%q}}`, inference, workspace)
		} else {
			w.Write([]byte(`{"ok":true,"generation":1,"credentials":{"inference":"bad","workspace":"bad"}}`))
		}
	}))
	defer source.Close()
	c := testConfig(t)
	c.NodeScopedKeys = true
	c.URL = source.URL
	a := agent{cfg: c, client: httpClient(time.Second), instance: testID, boot: testID}
	a.run = func(_ context.Context, args []string, _ time.Duration, _ []string) (string, error) {
		if args[0] == "nvidia-smi" && strings.HasPrefix(args[1], "--query-gpu") {
			return "0, GPU-a, Test, 24000, 0, 0, 43, Disabled", nil
		}
		return "", nil
	}
	if _, err := a.heartbeat(context.Background()); err == nil || a.identity().Generation != nil || os.Getenv("INFERENCE_COREMATRIX_NODE_INFERENCE") != "" {
		t.Fatal("invalid keys enabled job claims")
	}
	valid = true
	if _, err := a.heartbeat(context.Background()); err != nil || a.identity().Generation == nil {
		t.Fatal("valid bootstrap failed", err)
	}
	if os.Getenv("INFERENCE_COREMATRIX_NODE_INFERENCE") != inference || os.Getenv("INFERENCE_COREMATRIX_NODE_WORKSPACE") != workspace {
		t.Fatal("credentials not installed")
	}
}
func TestAPIRejectsRedirectAndOversize(t *testing.T) {
	hits := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; w.Write([]byte(`{}`)) }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/large" {
			w.Write([]byte(strings.Repeat("x", 1024*1024+1)))
			return
		}
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	a := agent{cfg: config{URL: source.URL, Token: "secret"}, client: httpClient(time.Second)}
	var out any
	if _, err := a.api(context.Background(), "/redirect", map[string]any{}, &out); err == nil || hits != 0 {
		t.Fatal("token followed redirect")
	}
	if _, err := a.api(context.Background(), "/large", map[string]any{}, &out); err == nil {
		t.Fatal("oversize response accepted")
	}
}
func TestLeaseClockAndIdempotentReport(t *testing.T) {
	server := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	deadline, err := leaseDeadline(server.Add(time.Minute), server, time.Now())
	if err != nil || time.Until(deadline) < 44*time.Second || time.Until(deadline) > 45*time.Second {
		t.Fatalf("clock skew handling: %v %v", deadline, err)
	}
	if _, err := leaseDeadline(server, server, time.Now()); err == nil {
		t.Fatal("expired lease accepted")
	}
	ids := []string{}
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		json.NewDecoder(r.Body).Decode(&p)
		ids = append(ids, p["eventId"].(string))
		if len(ids) == 1 {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer source.Close()
	a := agent{cfg: config{URL: source.URL}, client: httpClient(time.Second), instance: testID}
	j := job{ID: testJobID, Generation: 1, Attempt: 1, LeaseToken: "lease"}
	l := &lease{deadline: time.Now().Add(10 * time.Second)}
	if err := a.report(context.Background(), j, l, "healthy", ""); err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != ids[1] {
		t.Fatal("report retry generated a new event ID")
	}
}
func TestExecutorStartReconcileStopAndLease(t *testing.T) {
	for _, mode := range []string{"inference", "gpu-rental"} {
		t.Run(mode, func(t *testing.T) {
			c := testConfig(t)
			t.Setenv("INFERENCE_TEST", "secret")
			t.Setenv(c.WorkspaceKeyEnv, strings.Repeat("s", 32))
			reports := []string{}
			heartbeats := 0
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.URL.Path == "/api/agent/heartbeat":
					heartbeats++
					w.Write([]byte(`{"ok":true,"generation":1}`))
				case strings.HasSuffix(r.URL.Path, "/report"):
					var p map[string]any
					json.NewDecoder(r.Body).Decode(&p)
					reports = append(reports, p["event"].(string))
					w.Write([]byte(`{"ok":true}`))
				case r.URL.Path == "/v1/models":
					w.Write([]byte(`{"data":[{"id":"public-model"}]}`))
				case strings.HasSuffix(r.URL.Path, "api/status"):
					w.Write([]byte(`{"started":"2026-01-01T00:00:00Z"}`))
				default:
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
			}))
			defer source.Close()
			_, port, _ := net.SplitHostPort(strings.TrimPrefix(source.URL, "http://"))
			n, _ := strconv.Atoi(port)
			var s spec
			json.Unmarshal([]byte(legacySpec), &s)
			s.EndpointPort = n
			if mode == "gpu-rental" {
				s.WorkloadType = mode
				s.ImageDigest = c.WorkspaceDigest
				s.APIKeyEnv = c.WorkspaceKeyEnv
			}
			raw, _ := json.Marshal(s)
			j := job{ID: testJobID, DeploymentID: testID, Kind: "start", Generation: 1, Attempt: 1, LeaseToken: "lease", Spec: raw}
			fingerprint, _ := specHash(raw)
			c.URL = source.URL
			exists := mode == "gpu-rental"
			running := exists
			calls := []string{}
			gen := int64(1)
			a := agent{cfg: c, client: httpClient(time.Second), healthClient: httpClient(time.Second), instance: testID, boot: testID, generation: &gen, ready: true, workspaceReady: true}
			a.run = func(_ context.Context, args []string, _ time.Duration, env []string) (string, error) {
				calls = append(calls, strings.Join(args, " "))
				switch {
				case len(args) > 2 && args[1] == "ps":
					if exists {
						return "container", nil
					}
					return "", nil
				case args[1] == "run":
					exists = true
					running = true
					return "container", nil
				case args[1] == "stop":
					running = false
					return "", nil
				case args[1] == "rm":
					exists = false
					return "", nil
				case args[1] == "inspect":
					return fmt.Sprintf(`[{"Id":"container","Config":{"Labels":{"corematrix.deployment":%q,"corematrix.port":%q,"corematrix.spec":%q}},"State":{"Status":"running","Running":%t}}]`, testID, port, fingerprint, running), nil
				case args[1] == "top":
					return "PID\n11\n22", nil
				case strings.HasPrefix(args[1], "--query-compute-apps"):
					if !exists {
						return "", nil
					}
					return "GPU-a, 11", nil
				case strings.HasPrefix(args[1], "--query-gpu"):
					return "0, GPU-a, X, 24000, 0, 0, 40, Disabled\n1, GPU-b, X, 24000, 0, 0, 40, Disabled", nil
				}
				return "", diagnostic("unexpected_command")
			}
			l := &lease{deadline: time.Now().Add(45 * time.Second)}
			if err := a.execute(context.Background(), j, l); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(reports, []string{"starting", "healthy"}) || heartbeats != 1 {
				t.Fatalf("wrong execution reports: %v", reports)
			}
			calls = nil
			reports = nil
			if err := a.execute(context.Background(), j, l); err != nil {
				t.Fatal(err)
			}
			for _, call := range calls {
				if strings.HasPrefix(call, "docker run") {
					t.Fatal("reconciliation duplicated container")
				}
			}
			calls = nil
			reports = nil
			j.Kind = "stop"
			if err := a.execute(context.Background(), j, l); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(reports, []string{"stopped"}) || exists {
				t.Fatal("stop did not confirm removal")
			}
			calls = nil
			j.Kind = "start"
			l.set(time.Now().Add(-time.Second))
			if err := a.execute(context.Background(), j, l); err == nil {
				t.Fatal("expired lease accepted")
			}
			for _, call := range calls {
				if strings.HasPrefix(call, "docker run") {
					t.Fatal("expired lease started container")
				}
			}
		})
	}
}
func TestPreflightValidatesDigest(t *testing.T) {
	c := testConfig(t)
	calls := []string{}
	a := agent{cfg: c}
	a.run = func(_ context.Context, args []string, _ time.Duration, _ []string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		if args[1] == "image" {
			return `[{"RepoDigests":["runtime@` + c.Digest + `"]}]`, nil
		}
		return "ok", nil
	}
	if err := a.preflight(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(calls, "\n"), "--gpus all --entrypoint nvidia-smi") {
		t.Fatal("GPU preflight missing")
	}
}

func TestCommandArgumentsErrorsAndTimeout(t *testing.T) {
	env := append(os.Environ(), "COREMATRIX_TEST_HELPER=1", "GORACE=atexit_sleep_ms=0")
	args := []string{os.Args[0], "-test.run=^TestCommandHelper$", "--", "literal", "$(do-not-run); *"}
	output, err := command(context.Background(), args, time.Second, env)
	if err != nil || output != "$(do-not-run); *" {
		t.Fatalf("arguments were not literal: %q %v", output, err)
	}
	for _, mode := range []string{"fail", "timeout", "large"} {
		args[3] = mode
		_, err = command(context.Background(), args, 100*time.Millisecond, env)
		if err == nil || err.Error() != "command_failed" {
			t.Fatalf("unsafe command error for %s: %v", mode, err)
		}
	}
}
func TestCommandHelper(t *testing.T) {
	if os.Getenv("COREMATRIX_TEST_HELPER") != "1" {
		return
	}
	switch os.Args[3] {
	case "literal":
		fmt.Print(os.Args[4])
	case "fail":
		fmt.Fprint(os.Stderr, "sensitive-stderr")
		os.Exit(1)
	case "timeout":
		time.Sleep(time.Second)
	case "large":
		fmt.Print(strings.Repeat("x", 2*1024*1024))
	}
	os.Exit(0)
}

func TestInferenceLoopbackBindingAndConfiguration(t *testing.T) {
	c := testConfig(t)
	var s spec
	json.Unmarshal([]byte(legacySpec), &s)
	j := job{ID: testJobID, DeploymentID: testID, Spec: []byte(legacySpec)}
	original, originalHash, err := runArgs(c, j, s)
	if err != nil {
		t.Fatal(err)
	}
	c.InferenceLoopback = true
	args, hash, err := runArgs(c, j, s)
	if err != nil {
		t.Fatal(err)
	}
	mapping := func(args []string) string {
		for i, arg := range args {
			if arg == "-p" {
				return args[i+1]
			}
		}
		return ""
	}
	if mapping(original) != "8000:8000" || mapping(args) != "127.0.0.1:8000:8000" || hash != originalHash {
		t.Fatal("binding or legacy fingerprint changed")
	}
	root := t.TempDir()
	for name, value := range map[string]string{"COREMATRIX_URL": "https://control.example.com", "COREMATRIX_AGENT_TOKEN": "node_" + strings.Repeat("a", 43), "COREMATRIX_RUNTIME_IMAGE": c.Image, "COREMATRIX_WORKSPACE_IMAGE": "", "COREMATRIX_SHM_SIZE": "8g", "COREMATRIX_MODEL_DIR": root + "/models", "COREMATRIX_CACHE_DIR": root + "/cache", "COREMATRIX_AGENT_STATE_DIR": root + "/state", "COREMATRIX_WORKSPACE_DIR": root + "/workspaces"} {
		t.Setenv(name, value)
	}
	for _, value := range []string{"", "0", "1"} {
		t.Setenv("COREMATRIX_INFERENCE_LOOPBACK", value)
		config, err := loadConfig()
		if err != nil || config.InferenceLoopback != (value == "1") {
			t.Fatalf("flag rejected: %q", value)
		}
	}
	for _, value := range []string{"true", "2", "127.0.0.1"} {
		t.Setenv("COREMATRIX_INFERENCE_LOOPBACK", value)
		_, err := loadConfig()
		if err == nil || err.Error() != "invalid_inference_loopback" {
			t.Fatal("invalid flag accepted")
		}
	}
}
