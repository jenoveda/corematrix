package main

import (
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type config struct {
	InferenceLoopback                                                bool
	URL, Token, Image, Digest, ModelDir, CacheDir, StateDir, ShmSize string
	WorkspaceImage, WorkspaceDigest, WorkspaceDir, WorkspaceKeyEnv   string
	WorkspaceBindIP                                                  string
	WorkspaceCPUs, WorkspaceMemoryMiB                                int
}

var gpuPattern = regexp.MustCompile(`^GPU-[a-zA-Z0-9-]+$`)
var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var repoPattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$`)
var revisionPattern = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
var modelPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
var keyPattern = regexp.MustCompile(`^INFERENCE_[A-Z0-9_]+$`)

func diagnostic(code string) error { return errors.New(code) }
func loadConfig() (config, error) {
	c := config{URL: strings.TrimRight(os.Getenv("COREMATRIX_URL"), "/"), Token: os.Getenv("COREMATRIX_AGENT_TOKEN"), Image: os.Getenv("COREMATRIX_RUNTIME_IMAGE"), ShmSize: os.Getenv("COREMATRIX_SHM_SIZE")}
	u, err := url.Parse(c.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return c, diagnostic("invalid_control_plane_url")
	}
	if u.Scheme != "https" && u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1" && u.Hostname() != "::1" && os.Getenv("COREMATRIX_ALLOW_HTTP") != "1" {
		return c, diagnostic("https_required")
	}
	if !regexp.MustCompile(`^node_[a-zA-Z0-9_-]{43}$`).MatchString(c.Token) {
		return c, diagnostic("invalid_agent_token")
	}
	c.WorkspaceImage = os.Getenv("COREMATRIX_WORKSPACE_IMAGE")
	c.WorkspaceKeyEnv = os.Getenv("COREMATRIX_WORKSPACE_KEY_ENV")
	if c.WorkspaceKeyEnv == "" {
		c.WorkspaceKeyEnv = "INFERENCE_JUPYTER_KEY"
	}
	if c.Image == "" && c.WorkspaceImage == "" {
		return c, diagnostic("image_digest_required")
	}
	for _, pair := range []struct {
		image  string
		digest *string
	}{{c.Image, &c.Digest}, {c.WorkspaceImage, &c.WorkspaceDigest}} {
		if pair.image != "" {
			if !regexp.MustCompile(`^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$`).MatchString(pair.image) {
				return c, diagnostic("image_digest_required")
			}
			*pair.digest = strings.Split(pair.image, "@")[1]
		}
	}
	if c.WorkspaceImage != "" && (!keyPattern.MatchString(c.WorkspaceKeyEnv) || len(os.Getenv(c.WorkspaceKeyEnv)) < 32) {
		return c, diagnostic("workspace_key_missing")
	}
	loopback := os.Getenv("COREMATRIX_INFERENCE_LOOPBACK")
	if loopback != "" && loopback != "0" && loopback != "1" {
		return c, diagnostic("invalid_inference_loopback")
	}
	c.InferenceLoopback = loopback == "1"
	c.WorkspaceBindIP = os.Getenv("COREMATRIX_WORKSPACE_BIND_IP")
	if c.WorkspaceBindIP == "" {
		c.WorkspaceBindIP = "127.0.0.1"
	}
	if net.ParseIP(c.WorkspaceBindIP) == nil || strings.Contains(c.WorkspaceBindIP, ":") {
		return c, diagnostic("invalid_workspace_bind_ip")
	}
	c.WorkspaceCPUs = 4
	c.WorkspaceMemoryMiB = 16384
	for _, setting := range []struct {
		name   string
		target *int
		max    int
	}{{"COREMATRIX_WORKSPACE_CPUS", &c.WorkspaceCPUs, 1024}, {"COREMATRIX_WORKSPACE_MEMORY_MIB", &c.WorkspaceMemoryMiB, 10000000}} {
		if value := os.Getenv(setting.name); value != "" {
			n, err := strconv.Atoi(value)
			if err != nil || n < 1 || n > setting.max {
				return c, diagnostic("invalid_workspace_limit")
			}
			*setting.target = n
		}
	}
	if !regexp.MustCompile(`^[1-9][0-9]*[mg]$`).MatchString(c.ShmSize) {
		return c, diagnostic("invalid_shared_memory_size")
	}
	paths := []struct {
		name, fallback string
		target         *string
	}{{"COREMATRIX_MODEL_DIR", "/opt/corematrix/models", &c.ModelDir}, {"COREMATRIX_CACHE_DIR", "/var/cache/corematrix", &c.CacheDir}, {"COREMATRIX_AGENT_STATE_DIR", "/var/lib/corematrix-agent", &c.StateDir}, {"COREMATRIX_WORKSPACE_DIR", "/var/lib/corematrix-workspaces", &c.WorkspaceDir}}
	for _, p := range paths {
		value := os.Getenv(p.name)
		if value == "" {
			value = p.fallback
		}
		value, err = filepath.Abs(value)
		if err != nil || strings.ContainsAny(value, ":\x00\r\n") {
			return c, diagnostic("invalid_mount_path")
		}
		if err = os.MkdirAll(value, 0700); err != nil {
			return c, diagnostic("directory_unavailable")
		}
		value, err = filepath.EvalSymlinks(value)
		if err != nil {
			return c, diagnostic("directory_unavailable")
		}
		*p.target = value
	}
	return c, nil
}

type spec struct {
	WorkloadType       string   `json:"workloadType,omitempty"`
	Artifact           string   `json:"artifact"`
	Revision           string   `json:"revision"`
	DType              string   `json:"dtype"`
	MaxModelLen        int      `json:"maxModelLen"`
	MinGPUMemoryMiB    int      `json:"minGpuMemoryMiB"`
	TensorParallelSize int      `json:"tensorParallelSize"`
	GPUUUIDs           []string `json:"gpuUuids"`
	EndpointPort       int      `json:"endpointPort"`
	ServedModelName    string   `json:"servedModelName"`
	APIKeyEnv          string   `json:"apiKeyEnv"`
	ImageDigest        string   `json:"imageDigest"`
}

func (c config) validateSpec(s spec) error {
	if s.ImageDigest != c.Digest {
		return diagnostic("runtime_image_mismatch")
	}
	if len(s.GPUUUIDs) == 0 || len(s.GPUUUIDs) > 64 {
		return diagnostic("invalid_gpu_spec")
	}
	seen := map[string]bool{}
	for _, id := range s.GPUUUIDs {
		if !gpuPattern.MatchString(id) || seen[id] {
			return diagnostic("invalid_gpu_spec")
		}
		seen[id] = true
	}
	if s.TensorParallelSize != len(s.GPUUUIDs) || (s.DType != "auto" && s.DType != "float16" && s.DType != "bfloat16") {
		return diagnostic("invalid_runtime_spec")
	}
	if strings.HasPrefix(s.Artifact, "/models/") {
		relative := strings.TrimPrefix(s.Artifact, "/models/")
		if !regexp.MustCompile(`^[a-zA-Z0-9_./-]+$`).MatchString(relative) {
			return diagnostic("invalid_model_path")
		}
		for _, part := range strings.Split(relative, "/") {
			if part == ".." {
				return diagnostic("invalid_model_path")
			}
		}
		path, err := filepath.EvalSymlinks(filepath.Join(c.ModelDir, relative))
		if err != nil {
			return diagnostic("invalid_model_path")
		}
		rel, err := filepath.Rel(c.ModelDir, path)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return diagnostic("invalid_model_path")
		}
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() {
			return diagnostic("invalid_model_path")
		}
	} else if !repoPattern.MatchString(s.Artifact) {
		return diagnostic("invalid_model_repository")
	}
	if !revisionPattern.MatchString(s.Revision) || s.Revision == "main" || s.Revision == "master" || s.Revision == "latest" {
		return diagnostic("revision_not_pinned")
	}
	if !modelPattern.MatchString(s.ServedModelName) {
		return diagnostic("invalid_served_name")
	}
	if s.EndpointPort < 1024 || s.EndpointPort > 65535 || s.MaxModelLen < 1 || s.MaxModelLen > 1100000 || s.MinGPUMemoryMiB < 1 || s.MinGPUMemoryMiB > 10000000 {
		return diagnostic("invalid_runtime_number")
	}
	if s.APIKeyEnv != "" && (!keyPattern.MatchString(s.APIKeyEnv) || os.Getenv(s.APIKeyEnv) == "") {
		return diagnostic("inference_key_missing")
	}
	return nil
}
