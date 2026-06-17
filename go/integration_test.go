//go:build integration

package beam

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func newIntegrationClient(t *testing.T, ctx context.Context) *Client {
	t.Helper()

	var opts []Option
	if useLocalIntegrationGateway() {
		opts = append(opts, localIntegrationOptions(t)...)
	}

	client, err := NewClient(ctx, opts...)
	if err != nil {
		t.Fatal(err)
	}
	cfg := client.Config()
	if cfg.Token == "" {
		client.Close()
		t.Skip("Beam token is required for integration tests")
	}
	if isProdGateway(cfg.GatewayHost) && os.Getenv("BEAM_CLIENT_ALLOW_PROD_INTEGRATION") != "1" {
		client.Close()
		t.Fatalf("integration tests resolved prod gateway %s:%d; set local BETA9 config/env or BEAM_CLIENT_ALLOW_PROD_INTEGRATION=1", cfg.GatewayHost, cfg.GatewayPort)
	}
	if os.Getenv("BEAM_CLIENT_REQUIRE_LOCAL_GATEWAY") == "1" && !isLocalGatewayHost(cfg.GatewayHost) {
		client.Close()
		t.Fatalf("integration tests require a local gateway, resolved %s:%d", cfg.GatewayHost, cfg.GatewayPort)
	}
	t.Logf("using Beam integration gateway %s:%d tls=%t config=%s context=%s", cfg.GatewayHost, cfg.GatewayPort, cfg.TLS, cfg.ConfigPath, cfg.ContextName)
	return client
}

func useLocalIntegrationGateway() bool {
	if os.Getenv("BEAM_CLIENT_LOCAL_GATEWAY") == "0" {
		return false
	}
	return os.Getenv("BEAM_CLIENT_ALLOW_PROD_INTEGRATION") != "1" || os.Getenv("BEAM_CLIENT_LOCAL_GATEWAY") == "1"
}

func localIntegrationOptions(t *testing.T) []Option {
	t.Helper()

	configPath := firstEnv("BETA9_CONFIG_PATH", "CONFIG_PATH")
	if configPath == "" {
		configPath = filepath.Join(homeDir(), ".beta9", "config.ini")
	}
	contextName := firstEnv("BETA9_CONFIG_CONTEXT", "BEAM_CONFIG_CONTEXT")
	if contextName == "" {
		contextName = defaultContextName
	}

	fileCtx, err := readConfigContext(configPath, contextName)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read local beta9 config: %v", err)
	}

	token := firstEnv("BETA9_TOKEN")
	if token == "" {
		token = fileCtx.token
	}
	if token == "" {
		token = os.Getenv("BEAM_TOKEN")
	}

	host := firstEnv("BETA9_GATEWAY_HOST", "GATEWAY_HOST")
	if host == "" {
		host = fileCtx.gatewayHost
	}
	if host == "" {
		host = "0.0.0.0"
	}
	host = strings.TrimSpace(host)

	port := 0
	if portText := firstEnv("BETA9_GATEWAY_PORT", "GATEWAY_PORT"); portText != "" {
		parsed, err := strconv.Atoi(portText)
		if err != nil {
			t.Fatalf("invalid local gateway port %q: %v", portText, err)
		}
		port = parsed
	}
	if port == 0 {
		port = fileCtx.gatewayPort
	}
	if port == 0 {
		port = 1993
	}

	if !isLocalGatewayHost(host) {
		t.Fatalf("local integration gateway must resolve to localhost/loopback, got %s:%d", host, port)
	}

	return []Option{
		WithToken(token),
		WithGateway(host, port),
		WithTLS(false),
		WithConfigPath(configPath),
		WithConfigContext(contextName),
	}
}

func isLocalGatewayHost(host string) bool {
	switch strings.ToLower(strings.TrimSpace(host)) {
	case "localhost", "127.0.0.1", "::1", "0.0.0.0":
		return true
	default:
		return false
	}
}

func isProdGateway(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "gateway.beam.cloud" || host == "gateway.stage.beam.cloud"
}

func TestIntegrationAuthorizeOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	workspace, err := client.Authorize(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if workspace.ID == "" {
		t.Fatal("authorize returned empty workspace ID")
	}
	t.Logf("authorized local integration workspace %s", workspace.ID)
}

func integrationBaseImageID(ctx context.Context, t *testing.T, client *Client) string {
	t.Helper()
	if imageID := os.Getenv("BEAM_TEST_IMAGE_ID"); imageID != "" {
		return imageID
	}
	baseImage := NewImage(
		WithPythonVersion("python3.11"),
		WithBuildLogSink(func(log ImageBuildLog) {
			if log.Message != "" {
				t.Logf("image build: %s", strings.TrimSpace(log.Message))
			}
		}),
	)
	buildResult, err := baseImage.Build(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	if buildResult.ImageID == "" {
		t.Fatal("base image build returned empty image ID")
	}
	return buildResult.ImageID
}

func integrationSandboxConfig(config SandboxConfig) SandboxConfig {
	if config.Pool == nil {
		if pool := os.Getenv("BEAM_TEST_POOL"); pool != "" {
			config.Pool = &PoolConfig{Name: pool}
		}
	}
	return config
}

func TestIntegrationExistingImageSandboxSmoke(t *testing.T) {
	imageID := os.Getenv("BEAM_TEST_IMAGE_ID")
	if imageID == "" {
		t.Skip("BEAM_TEST_IMAGE_ID is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:         "go-sdk-existing-image-smoke",
		App:          "go-sdk-existing-image-smoke",
		Image:        ImageFromID(imageID),
		CPU:          1,
		MemoryMiB:    256,
		SyncLocalDir: false,
		KeepWarm:     5 * time.Minute,
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer sb.Terminate(context.Background())
	if err := sb.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	result, err := sb.RunCode(ctx, "print('existing-image-ok')", ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || !strings.Contains(result.Stdout, "existing-image-ok") {
		t.Fatalf("unexpected smoke output: %#v", result)
	}
}

func TestIntegrationFileSyncOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hello local sync"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := NewFileSyncer(dir, WithoutDefaultIgnoreFile()).Sync(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	if result.ObjectID == "" || result.Hash == "" || result.Size == 0 {
		t.Fatalf("bad sync result: %#v", result)
	}
	t.Logf("synced local object %s size=%d cached=%t", result.ObjectID, result.Size, result.Cached)
}

func TestIntegrationSandboxLifecycle(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	baseImageID := integrationBaseImageID(ctx, t, client)

	const count = 3
	sandboxes := make([]*Sandbox, count)
	var wg sync.WaitGroup
	errs := make(chan error, count)
	for i := range sandboxes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
				Name:          fmt.Sprintf("go-sdk-integration-%d", i),
				App:           "go-sdk-local-integration",
				Image:         ImageFromID(baseImageID),
				CPU:           1,
				MemoryMiB:     256,
				SyncLocalDir:  false,
				Ports:         []int{8080},
				KeepWarm:      10 * time.Minute,
				DockerEnabled: false,
			}))
			if err != nil {
				errs <- err
				return
			}
			sandboxes[i] = sb
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, sb := range sandboxes {
		if sb != nil {
			defer sb.Terminate(context.Background())
			if err := sb.WaitReady(ctx); err != nil {
				t.Fatal(err)
			}
			requireListProcesses(ctx, t, sb)
		}
	}

	sb := sandboxes[0]

	var streamed strings.Builder
	proc, err := sb.Exec(ctx, []string{"sh", "-lc", "echo stdout && echo stderr >&2"}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	exit, err := proc.Stream(ctx, func(entry LogEntry) {
		streamed.WriteString(entry.Stream)
		streamed.WriteString(":")
		streamed.WriteString(entry.Data)
	})
	if err != nil {
		t.Fatal(err)
	}
	if exit != 0 || !strings.Contains(streamed.String(), "stdout") || !strings.Contains(streamed.String(), "stderr") {
		t.Fatalf("unexpected stream exit=%d output=%q", exit, streamed.String())
	}

	if err := sb.FS.Mkdir(ctx, "/workspace/go-sdk", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := sb.FS.Upload(ctx, "/workspace/go-sdk/file.txt", []byte("hello beam"), 0o644); err != nil {
		t.Fatal(err)
	}
	stat, err := sb.FS.Stat(ctx, "/workspace/go-sdk/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if stat.Size != int64(len("hello beam")) {
		t.Fatalf("unexpected stat size: %d", stat.Size)
	}
	files, err := sb.FS.List(ctx, "/workspace/go-sdk")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("expected uploaded file in list")
	}
	data, err := sb.FS.Download(ctx, "/workspace/go-sdk/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello beam" {
		t.Fatalf("unexpected download: %q", data)
	}
	if err := sb.FS.Replace(ctx, "/workspace/go-sdk", "beam", "sandbox"); err != nil {
		t.Fatal(err)
	}
	results, err := sb.FS.Find(ctx, "/workspace/go-sdk", "sandbox")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) == 0 {
		t.Fatal("expected find result")
	}

	server, err := sb.Exec(ctx, []string{"python3", "-m", "http.server", "8080", "--directory", "/workspace/go-sdk"}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Kill(context.Background())
	time.Sleep(2 * time.Second)
	url, err := sb.ExposePort(ctx, 8080)
	if err != nil {
		t.Fatal(err)
	}
	urls, err := sb.ListURLs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if urls[8080] == "" {
		t.Fatalf("expected listed URL for 8080, got %#v", urls)
	}
	resp, err := httpGetSandboxURL(ctx, client, url+"/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "hello sandbox") {
		t.Fatalf("unexpected HTTP response %d %q", resp.StatusCode, string(body))
	}

	if err := sb.UpdateTTL(ctx, 20*time.Minute); err != nil {
		t.Fatal(err)
	}
	if err := sb.UpdateNetworkPermissions(ctx, NetworkPermissions{AllowList: []string{"8.8.8.8/32"}}); err != nil {
		t.Fatal(err)
	}
	if err := sb.UpdateNetworkPermissions(ctx, NetworkPermissions{}); err != nil {
		t.Fatal(err)
	}

	sleeper, err := sb.Exec(ctx, []string{"sh", "-lc", "sleep 30"}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	processes := requireListProcesses(ctx, t, sb)
	t.Logf("server-backed process list returned %d process(es)", len(processes))
	if err := sleeper.Kill(ctx); err != nil {
		t.Fatal(err)
	}

	imageID, err := sb.CreateImageFromFilesystem(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fromImage, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:         "go-sdk-from-fs-image",
		App:          "go-sdk-local-integration",
		Image:        ImageFromID(imageID),
		SyncLocalDir: false,
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer fromImage.Terminate(context.Background())
}

func requireListProcesses(ctx context.Context, t *testing.T, sandbox *Sandbox) []ProcessInfo {
	t.Helper()
	var lastErr error
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	for {
		processes, err := sandbox.ListProcesses(ctx)
		if err == nil {
			return processes
		}
		lastErr = err

		select {
		case <-ctx.Done():
			t.Fatalf("list processes for %s: %v", sandbox.SandboxID(), ctx.Err())
		case <-deadline.C:
			t.Fatalf("list processes for %s: %v", sandbox.SandboxID(), lastErr)
		case <-ticker.C:
		}
	}
}

func httpGetSandboxURL(ctx context.Context, client *Client, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		return resp, err
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	token := client.Config().Token
	if token == "" {
		return resp, nil
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return http.DefaultClient.Do(req)
}

func TestIntegrationImageBuildsAndAppNames(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	dockerfileDir := t.TempDir()
	dockerfilePath := filepath.Join(dockerfileDir, "Dockerfile")
	if err := os.WriteFile(dockerfilePath, []byte("FROM python:3.11-slim\nRUN echo go-sdk-dockerfile-image > /go-sdk-image.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dockerfileImage, err := ImageFromDockerfile(dockerfilePath)
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name  string
		image *Image
		check []string
	}{
		{
			name:  "managed",
			image: NewImage(WithPythonVersion("python3.11"), WithCommands("echo go-sdk-managed-image")),
			check: []string{"python3", "-c", "print('managed-ok')"},
		},
		{
			name:  "dockerfile",
			image: dockerfileImage,
			check: []string{"sh", "-lc", "test -f /go-sdk-image.txt && python3 -c 'print(\"dockerfile-ok\")'"},
		},
		{
			name:  "registry",
			image: ImageFromRegistry("python:3.11-slim", WithIgnorePython(true)),
			check: []string{"python3", "-c", "print('registry-ok')"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result, err := tc.image.Build(ctx, client)
			if err != nil {
				t.Fatal(err)
			}
			if result.ImageID == "" {
				t.Fatal("image build returned empty image ID")
			}
			sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
				Name:         "go-sdk-image-" + tc.name,
				App:          "go-sdk-image-builds",
				Image:        ImageFromID(result.ImageID),
				CPU:          1,
				MemoryMiB:    256,
				SyncLocalDir: false,
				KeepWarm:     10 * time.Minute,
				Env:          map[string]string{"GO_SDK_IMAGE_CASE": tc.name},
			}))
			if err != nil {
				t.Fatal(err)
			}
			defer sb.Terminate(context.Background())
			if err := sb.WaitReady(ctx); err != nil {
				t.Fatal(err)
			}
			proc, err := sb.Exec(ctx, tc.check, ExecOptions{})
			if err != nil {
				t.Fatal(err)
			}
			output, err := proc.Output(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if output.ExitCode != 0 {
				t.Fatalf("image check failed: %#v", output)
			}
		})
	}
}

func TestIntegrationDockerSmoke(t *testing.T) {
	if os.Getenv("BEAM_TEST_DOCKER") != "1" {
		t.Skip("BEAM_TEST_DOCKER=1 is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:          "go-sdk-docker",
		App:           "go-sdk-docker",
		Image:         NewImage(WithPythonVersion("python3.11")).WithDocker(),
		CPU:           2,
		MemoryMiB:     2048,
		SyncLocalDir:  false,
		KeepWarm:      10 * time.Minute,
		DockerEnabled: true,
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer sb.Terminate(context.Background())
	if err := sb.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}

	version, err := sb.Docker.Raw(ctx, "version", "--format", "{{.Server.Version}}")
	if err != nil {
		t.Fatal(err)
	}
	versionResult, err := version.Output(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if versionResult.ExitCode != 0 || strings.TrimSpace(versionResult.Stdout) == "" {
		t.Fatalf("docker version failed: %#v", versionResult)
	}

	dockerProc, err := sb.Docker.Run(ctx, "hello-world", DockerRunOptions{Remove: true})
	if err != nil {
		t.Fatal(err)
	}
	result, err := dockerProc.Output(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("docker smoke failed: %#v", result)
	}
}

func TestIntegrationSandboxMemorySnapshot(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	baseImageID := integrationBaseImageID(ctx, t, client)
	sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:         "go-sdk-snapshot",
		App:          "go-sdk-snapshot",
		Image:        ImageFromID(baseImageID),
		CPU:          1,
		MemoryMiB:    256,
		SyncLocalDir: false,
		KeepWarm:     10 * time.Minute,
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer sb.Terminate(context.Background())
	if err := sb.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	if err := sb.FS.Upload(ctx, "/workspace/checkpoint.txt", []byte("checkpoint-data"), 0o644); err != nil {
		t.Fatal(err)
	}

	checkpointID, err := sb.SnapshotMemory(ctx)
	if err != nil {
		if os.Getenv("BEAM_TEST_ALLOW_SNAPSHOT_UNSUPPORTED") == "1" {
			t.Skip(err)
		}
		t.Fatal(err)
	}
	restored, err := client.CreateSandboxFromMemorySnapshot(ctx, checkpointID)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Terminate(context.Background())
	if err := restored.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	data, err := restored.FS.Download(ctx, "/workspace/checkpoint.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "checkpoint-data" {
		t.Fatalf("checkpoint did not restore file state: %q", string(data))
	}
}
