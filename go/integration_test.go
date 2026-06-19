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

	configPath := firstEnv("BETA9_CONFIG_PATH", "BEAM_CONFIG_PATH", "CONFIG_PATH")
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

	token := firstEnv("BEAM_TOKEN", "BETA9_TOKEN")
	if token == "" {
		token = fileCtx.token
	}

	host := firstEnv("BEAM_GATEWAY_HOST", "BETA9_GATEWAY_HOST", "GATEWAY_HOST")
	if host == "" {
		host = fileCtx.gatewayHost
	}
	if host == "" {
		host = "0.0.0.0"
	}
	host = strings.TrimSpace(host)
	if host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}

	port := 0
	if portText := firstEnv("BEAM_GATEWAY_PORT", "BETA9_GATEWAY_PORT", "GATEWAY_PORT"); portText != "" {
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
		Name:      "go-sdk-existing-image-smoke",
		App:       "go-sdk-existing-image-smoke",
		Image:     ImageFromID(imageID),
		CPU:       1,
		MemoryMiB: 256,
		KeepWarm:  5 * time.Minute,
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
	payload := fmt.Sprintf("hello local sync %d", time.Now().UnixNano())
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte(payload), 0o644); err != nil {
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

func TestIntegrationCreateSandboxWithSyncLocalDir(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	baseImageID := integrationBaseImageID(ctx, t, client)

	dir := t.TempDir()
	payload := fmt.Sprintf("synced local dir %d\n", time.Now().UnixNano())
	if err := os.MkdirAll(filepath.Join(dir, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "nested", "input.txt"), []byte(payload), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".beamignore"), []byte("ignored.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ignored.txt"), []byte("should not sync\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:         "go-sdk-sync-local-dir",
		App:          "go-sdk-sync-local-dir",
		Image:        ImageFromID(baseImageID),
		CPU:          1,
		MemoryMiB:    256,
		Workdir:      dir,
		SyncLocalDir: true,
		KeepWarm:     5 * time.Minute,
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer sb.Terminate(context.Background())

	if err := sb.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}

	result, err := sb.RunCode(ctx, fmt.Sprintf(`
from pathlib import Path
expected = %q
p = Path("nested/input.txt")
assert p.read_text() == expected
assert not Path("ignored.txt").exists()
print(p.read_text().strip())
`, payload), ExecOptions{Workdir: "/mnt/code"})
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("sync local dir check failed: stdout=%q stderr=%q", result.Stdout, result.Stderr)
	}
	if !strings.Contains(result.Stdout, strings.TrimSpace(payload)) {
		t.Fatalf("unexpected sync local dir output: %#v", result)
	}
}

func TestIntegrationProcessLogStreaming(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	baseImageID := integrationBaseImageID(ctx, t, client)
	sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:      "go-sdk-log-streaming",
		App:       "go-sdk-local-integration",
		Image:     ImageFromID(baseImageID),
		CPU:       1,
		MemoryMiB: 256,
		KeepWarm:  5 * time.Minute,
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer sb.Terminate(context.Background())
	if err := sb.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}

	script := `printf 'stdout-stream-start\n'; sleep 3; printf 'stderr-stream-middle\n' >&2; sleep 1; printf 'stdout-stream-end\n'; printf 'stderr-stream-end\n' >&2`
	proc, err := sb.Exec(ctx, []string{"sh", "-lc", script}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}

	capture := requireProcessStream(ctx, t, proc, 2*time.Second)
	requireContainsAll(t, "stdout", capture.stdout, "stdout-stream-start", "stdout-stream-end")
	requireContainsAll(t, "stderr", capture.stderr, "stderr-stream-middle", "stderr-stream-end")
	requireReadersConsumed(ctx, t, proc)
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
	requireSandboxStatus(ctx, t, sb)

	connected, err := client.ConnectSandbox(ctx, sb.SandboxID())
	if err != nil {
		t.Fatal(err)
	}
	requireSandboxStatus(ctx, t, connected)

	shellProc, err := connected.ExecShell(ctx, `sh -lc 'printf "%s:%s" "$GO_SDK_EXEC_SHELL" "$PWD"'`, ExecOptions{
		Workdir: "/workspace",
		Env:     map[string]string{"GO_SDK_EXEC_SHELL": "exec-shell-ok"},
	})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, shellProc, "exec-shell-ok:/workspace")

	readerProc, err := sb.Exec(ctx, []string{"sh", "-lc", "printf stdout-reader-ok; printf stderr-reader-ok >&2"}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessReaders(ctx, t, readerProc, "stdout-reader-ok", "stderr-reader-ok")

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
	requireLocalFileRoundTrip(ctx, t, sb, "/workspace/go-sdk/uploaded.txt", "upload-file-ok")
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
	if err := sb.FS.RemoveFile(ctx, "/workspace/go-sdk/uploaded.txt"); err != nil {
		t.Fatal(err)
	}
	if err := sb.FS.Mkdir(ctx, "/workspace/go-sdk/remove-me", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := sb.FS.RemoveDir(ctx, "/workspace/go-sdk/remove-me"); err != nil {
		t.Fatal(err)
	}

	server, err := sb.Exec(ctx, []string{"python3", "-m", "http.server", "8080", "--bind", "::", "--directory", "/workspace/go-sdk"}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Kill(context.Background())
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
	waitSandboxURLContains(ctx, t, client, url+"/file.txt", "hello sandbox")

	ipv4Server, err := sb.Exec(ctx, []string{"python3", "-m", "http.server", "8081", "--bind", "0.0.0.0", "--directory", "/workspace/go-sdk"}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer ipv4Server.Kill(context.Background())
	ipv4URL, err := sb.ExposePort(ctx, 8081)
	if err != nil {
		t.Fatal(err)
	}
	waitSandboxURLContains(ctx, t, client, ipv4URL+"/file.txt", "hello sandbox")

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
		Name:  "go-sdk-from-fs-image",
		App:   "go-sdk-local-integration",
		Image: ImageFromID(imageID),
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer fromImage.Terminate(context.Background())
}

func TestIntegrationASGIListenerFamilies(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name: "go-sdk-asgi-listeners",
		App:  "go-sdk-local-integration",
		Image: NewImage(
			WithPythonVersion("python3.11"),
			WithPythonPackages("uvicorn"),
		),
		CPU:       1,
		MemoryMiB: 512,
		Ports:     []int{8090, 8091},
		KeepWarm:  10 * time.Minute,
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer sb.Terminate(context.Background())
	if err := sb.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}

	app := `import os

async def app(scope, receive, send):
    body = f"asgi-ok host={os.environ.get('BEAM_ASGI_HOST', '')}".encode()
    await send({
        "type": "http.response.start",
        "status": 200,
        "headers": [(b"content-type", b"text/plain")],
    })
    await send({"type": "http.response.body", "body": body})
`
	if err := sb.FS.Upload(ctx, "/workspace/asgi_app.py", []byte(app), 0o644); err != nil {
		t.Fatal(err)
	}

	ipv4Server, err := sb.Exec(ctx, []string{"python3", "-m", "uvicorn", "asgi_app:app", "--host", "0.0.0.0", "--port", "8090"}, ExecOptions{
		Workdir: "/workspace",
		Env:     map[string]string{"BEAM_ASGI_HOST": "0.0.0.0"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ipv4Server.Kill(context.Background())

	ipv6Server, err := sb.Exec(ctx, []string{"python3", "-m", "uvicorn", "asgi_app:app", "--host", "::", "--port", "8091"}, ExecOptions{
		Workdir: "/workspace",
		Env:     map[string]string{"BEAM_ASGI_HOST": "::"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer ipv6Server.Kill(context.Background())

	ipv4URL, err := sb.ExposePort(ctx, 8090)
	if err != nil {
		t.Fatal(err)
	}
	waitSandboxURLContains(ctx, t, client, ipv4URL, "asgi-ok", "0.0.0.0")

	ipv6URL, err := sb.ExposePort(ctx, 8091)
	if err != nil {
		t.Fatal(err)
	}
	waitSandboxURLContains(ctx, t, client, ipv6URL, "asgi-ok", "::")
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

func requireSandboxStatus(ctx context.Context, t *testing.T, sandbox *Sandbox) SandboxStatus {
	t.Helper()
	status, err := sandbox.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status == "" {
		t.Fatalf("expected sandbox status, got %#v", status)
	}
	return status
}

func requireLocalFileRoundTrip(ctx context.Context, t *testing.T, sandbox *Sandbox, sandboxPath, payload string) {
	t.Helper()
	localUpload := filepath.Join(t.TempDir(), "upload.txt")
	if err := os.WriteFile(localUpload, []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := sandbox.FS.UploadFile(ctx, localUpload, sandboxPath); err != nil {
		t.Fatal(err)
	}

	localDownload := filepath.Join(t.TempDir(), "downloaded.txt")
	if err := sandbox.FS.DownloadFile(ctx, sandboxPath, localDownload); err != nil {
		t.Fatal(err)
	}
	downloaded, err := os.ReadFile(localDownload)
	if err != nil {
		t.Fatal(err)
	}
	if string(downloaded) != payload {
		t.Fatalf("unexpected downloaded file contents: %q", downloaded)
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

func readSandboxURLBody(ctx context.Context, client *Client, url string) (int, string, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := httpGetSandboxURL(requestCtx, client, url)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, "", err
	}
	return resp.StatusCode, string(body), nil
}

func waitSandboxURLContains(ctx context.Context, t *testing.T, client *Client, url string, values ...string) string {
	t.Helper()

	deadline := time.NewTimer(90 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	var lastStatus int
	var lastBody string
	var lastErr error
	for {
		status, body, err := readSandboxURLBody(ctx, client, url)
		if err == nil {
			lastStatus = status
			lastBody = body
			if status == http.StatusOK {
				matched := true
				for _, value := range values {
					if !strings.Contains(body, value) {
						matched = false
						break
					}
				}
				if matched {
					return body
				}
			}
		} else {
			lastErr = err
		}

		select {
		case <-ctx.Done():
			t.Fatalf("waiting for %s: status=%d body=%q err=%v ctx=%v", url, lastStatus, lastBody, lastErr, ctx.Err())
		case <-deadline.C:
			t.Fatalf("timed out waiting for %s to contain %q: status=%d body=%q err=%v", url, values, lastStatus, lastBody, lastErr)
		case <-ticker.C:
		}
	}
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
				Name:      "go-sdk-image-" + tc.name,
				App:       "go-sdk-image-builds",
				Image:     ImageFromID(result.ImageID),
				CPU:       1,
				MemoryMiB: 256,
				KeepWarm:  10 * time.Minute,
				Env:       map[string]string{"GO_SDK_IMAGE_CASE": tc.name},
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

func TestIntegrationVolumeMountPersistsAcrossSandboxes(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	baseImageID := integrationBaseImageID(ctx, t, client)
	runtimeName := integrationRuntimeName()
	volumeName := fmt.Sprintf("go-sdk-volume-%s-%d", runtimeName, time.Now().UnixNano())
	mountPath := "/mnt/beam-go-volume"
	payload := "volume-ok-" + runtimeName

	first, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:      "go-sdk-volume-writer-" + runtimeName,
		App:       "go-sdk-volume-" + runtimeName,
		Image:     ImageFromID(baseImageID),
		CPU:       1,
		MemoryMiB: 256,
		KeepWarm:  10 * time.Minute,
		Volumes:   []VolumeMount{NewVolume(volumeName, mountPath)},
	}))
	if err != nil {
		t.Fatal(err)
	}
	firstTerminated := false
	defer func() {
		if !firstTerminated {
			_ = first.Terminate(context.Background())
		}
	}()
	if err := first.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	writeProc, err := first.Exec(ctx, []string{"sh", "-lc", "mkdir -p /mnt/beam-go-volume/nested && printf " + shellQuote(payload) + " > /mnt/beam-go-volume/nested/value.txt && cat /mnt/beam-go-volume/nested/value.txt"}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, writeProc, payload)
	if err := first.Terminate(ctx); err != nil {
		t.Fatal(err)
	}
	firstTerminated = true

	second, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:      "go-sdk-volume-reader-" + runtimeName,
		App:       "go-sdk-volume-" + runtimeName,
		Image:     ImageFromID(baseImageID),
		CPU:       1,
		MemoryMiB: 256,
		KeepWarm:  10 * time.Minute,
		Volumes:   []VolumeMount{NewVolume(volumeName, mountPath)},
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer second.Terminate(context.Background())
	if err := second.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	readProc, err := second.Exec(ctx, []string{"sh", "-lc", "test -d /mnt/beam-go-volume && cat /mnt/beam-go-volume/nested/value.txt"}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, readProc, payload)
}

func TestIntegrationDockerWorkspaceAndVolumeVisibility(t *testing.T) {
	if os.Getenv("BEAM_TEST_DOCKER") != "1" {
		t.Skip("BEAM_TEST_DOCKER=1 is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	runtimeName := integrationRuntimeName()
	suffix := fmt.Sprintf("%s-%d", runtimeName, time.Now().UnixNano())
	volumeName := "go-sdk-docker-visible-" + suffix
	mountPath := "/mnt/beam-visible"
	const visiblePort = 8776

	dir := t.TempDir()
	workspacePayload := "workspace-visible-" + suffix
	if err := os.MkdirAll(filepath.Join(dir, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app", "payload.txt"), []byte(workspacePayload), 0o644); err != nil {
		t.Fatal(err)
	}

	sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:          "go-sdk-docker-visible-" + runtimeName,
		App:           "go-sdk-docker-visible-" + runtimeName,
		Image:         NewImage(WithPythonVersion("python3.11")).WithDocker(),
		CPU:           1,
		MemoryMiB:     1024,
		Ports:         []int{visiblePort},
		Workdir:       dir,
		SyncLocalDir:  true,
		Volumes:       []VolumeMount{NewVolume(volumeName, mountPath)},
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

	volumePayload := "volume-visible-" + suffix
	if err := sb.FS.Upload(ctx, mountPath+"/payload.txt", []byte(volumePayload), 0o644); err != nil {
		t.Fatal(err)
	}

	serverScript := fmt.Sprintf(`
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import socket

workspace_payload = Path("/mnt/code/app/payload.txt").read_text()
volume_payload = Path(%q).read_text()

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_GET(self):
        body = f"workspace={workspace_payload} volume={volume_payload}\n"
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def log_message(self, format, *args):
        pass

class DualStackHTTPServer(HTTPServer):
    address_family = socket.AF_INET6
    allow_reuse_address = True

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()

DualStackHTTPServer(("::", %d), Handler).serve_forever()
`, mountPath+"/payload.txt", visiblePort)
	server, err := sb.Exec(ctx, []string{"python3", "-c", serverScript}, ExecOptions{Workdir: "/workspace"})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Kill(context.Background())

	url, err := sb.ExposePort(ctx, visiblePort)
	if err != nil {
		t.Fatal(err)
	}
	waitSandboxURLContains(ctx, t, client, url, workspacePayload, volumePayload)
}

func TestIntegrationDockerSmoke(t *testing.T) {
	if os.Getenv("BEAM_TEST_DOCKER") != "1" {
		t.Skip("BEAM_TEST_DOCKER=1 is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	runtimeName := integrationRuntimeName()
	suffix := fmt.Sprintf("%s-%d", runtimeName, time.Now().UnixNano())
	logContainer := "beam-go-docker-log-" + suffix
	composeContainer4 := "beam-go-docker-compose-v4-" + suffix
	composeContainer6 := "beam-go-docker-compose-v6-" + suffix
	const (
		composePort4 = 8781
		composePort6 = 8782
	)
	imageTag := "beam-go-docker-built:" + suffix
	buildDir := "/workspace/docker-build-" + suffix
	composeDir := "/workspace/docker-compose-" + suffix

	sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:          "go-sdk-docker-" + runtimeName,
		App:           "go-sdk-docker-" + runtimeName,
		Image:         NewImage(WithPythonVersion("python3.11")).WithDocker(),
		CPU:           2,
		MemoryMiB:     2048,
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
	if err := sb.Docker.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	defer cleanupDockerContainer(context.Background(), sb, logContainer)

	version, err := sb.Docker.Raw(ctx, "version", "--format", "{{.Server.Version}}")
	if err != nil {
		t.Fatal(err)
	}
	versionResult := requireProcessSuccess(ctx, t, version)
	if strings.TrimSpace(versionResult.Stdout) == "" {
		t.Fatalf("docker version returned empty output: %#v", versionResult)
	}

	composeVersion, err := sb.Docker.Compose(ctx, "version")
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, composeVersion, "Docker Compose")

	pull, err := sb.Docker.Pull(ctx, "busybox:1.36")
	if err != nil {
		t.Fatal(err)
	}
	requireProcessSuccess(ctx, t, pull)

	if err := sb.FS.Mkdir(ctx, "/workspace/docker-volume", 0o755); err != nil {
		t.Fatal(err)
	}
	if err := sb.FS.Upload(ctx, "/workspace/docker-volume/input.txt", []byte("volume-option-ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	runWithOptions, err := sb.Docker.Run(ctx, "busybox:1.36", DockerRunOptions{
		Remove: true,
		Env:    map[string]string{"BEAM_DOCKER_ENV": "env-option-ok"},
		Volumes: map[string]string{
			"/workspace/docker-volume": "/mounted:ro",
		},
		Command: []string{"sh", "-c", "cat /mounted/input.txt && echo $BEAM_DOCKER_ENV"},
	})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, runWithOptions, "volume-option-ok", "env-option-ok")

	logRun, err := sb.Docker.Run(ctx, "busybox:1.36", DockerRunOptions{
		Detach:  true,
		Name:    logContainer,
		Command: []string{"sh", "-c", "echo log-helper-ok; while true; do sleep 1; done"},
	})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessSuccess(ctx, t, logRun)

	ps, err := sb.Docker.Ps(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, ps, logContainer)

	logs := requireProcessContainsEventually(ctx, t, func() (*Process, error) {
		return sb.Docker.Logs(ctx, logContainer, false)
	}, "log-helper-ok")
	t.Logf("docker logs output: %s", strings.TrimSpace(logs.Stdout+logs.Stderr))

	exec, err := sb.Docker.Exec(ctx, logContainer, "sh", "-c", "echo exec-helper-ok > /tmp/exec.txt && cat /tmp/exec.txt")
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, exec, "exec-helper-ok")

	if err := sb.FS.Mkdir(ctx, buildDir, 0o755); err != nil {
		t.Fatal(err)
	}
	dockerfile := "FROM busybox:1.36\nCMD [\"sh\", \"-c\", \"echo build-helper-ok\"]\n"
	if err := sb.FS.Upload(ctx, buildDir+"/Dockerfile", []byte(dockerfile), 0o644); err != nil {
		t.Fatal(err)
	}
	build, err := sb.Docker.Build(ctx, ".", DockerBuildOptions{Tag: imageTag, Workdir: buildDir})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessSuccess(ctx, t, build)

	builtRun, err := sb.Docker.Run(ctx, imageTag, DockerRunOptions{Remove: true})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, builtRun, "build-helper-ok")

	if err := sb.FS.Mkdir(ctx, composeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := sb.FS.Mkdir(ctx, composeDir+"/site", 0o755); err != nil {
		t.Fatal(err)
	}
	composePayload := "compose-http-ok-" + suffix
	if err := sb.FS.Upload(ctx, composeDir+"/site/index.txt", []byte(composePayload+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	composeServer := fmt.Sprintf(`
from http.server import HTTPServer, SimpleHTTPRequestHandler
import os
import socket

host = os.environ["BEAM_TEST_HOST"]
port = int(os.environ["BEAM_TEST_PORT"])
label = os.environ["BEAM_TEST_LABEL"]
family = socket.AF_INET6 if ":" in host else socket.AF_INET

class SandboxHTTPServer(HTTPServer):
    address_family = family
    allow_reuse_address = True

    def server_bind(self):
        if self.address_family == socket.AF_INET6:
            try:
                self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            except OSError:
                pass
        super().server_bind()

os.chdir("/site")
print(f"compose-http-ready-{label}", flush=True)
SandboxHTTPServer((host, port), SimpleHTTPRequestHandler).serve_forever()
`)
	if err := sb.FS.Upload(ctx, composeDir+"/site/server.py", []byte(composeServer), 0o644); err != nil {
		t.Fatal(err)
	}
	composeFile := fmt.Sprintf(`services:
  app4:
    image: python:3.11-alpine
    container_name: %s
    volumes:
      - "%s/site:/site:ro"
    environment:
      BEAM_TEST_HOST: "0.0.0.0"
      BEAM_TEST_PORT: "%d"
      BEAM_TEST_LABEL: "v4"
    command: python3 /site/server.py
  app6:
    image: python:3.11-alpine
    container_name: %s
    volumes:
      - "%s/site:/site:ro"
    environment:
      BEAM_TEST_HOST: "::"
      BEAM_TEST_PORT: "%d"
      BEAM_TEST_LABEL: "v6"
    command: python3 /site/server.py
`, composeContainer4, composeDir, composePort4, composeContainer6, composeDir, composePort6)
	if err := sb.FS.Upload(ctx, composeDir+"/compose.yml", []byte(composeFile), 0o644); err != nil {
		t.Fatal(err)
	}
	composeUp, err := sb.Docker.ComposeUp(ctx, DockerComposeOptions{File: "compose.yml", Detach: true, Workdir: composeDir})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessSuccess(ctx, t, composeUp)
	defer cleanupDockerCompose(context.Background(), sb, composeDir)

	composeLogs := requireProcessContainsEventually(ctx, t, func() (*Process, error) {
		return sb.Docker.ComposeLogs(ctx, "compose.yml", false, composeDir)
	}, "compose-http-ready-v4")
	composeLogs = requireProcessContainsEventually(ctx, t, func() (*Process, error) {
		return sb.Docker.ComposeLogs(ctx, "compose.yml", false, composeDir)
	}, "compose-http-ready-v6")
	t.Logf("docker compose logs output: %s", strings.TrimSpace(composeLogs.Stdout+composeLogs.Stderr))

	directCompose4, err := sb.Exec(ctx, []string{"python3", "-c", fmt.Sprintf("import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:%d/index.txt', timeout=5).read().decode())", composePort4)}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, directCompose4, composePayload)

	directCompose6, err := sb.Exec(ctx, []string{"python3", "-c", fmt.Sprintf("import urllib.request; print(urllib.request.urlopen('http://[::1]:%d/index.txt', timeout=5).read().decode())", composePort6)}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, directCompose6, composePayload)

	composeURL4, err := sb.ExposePort(ctx, composePort4)
	if err != nil {
		t.Fatal(err)
	}
	waitSandboxURLContains(ctx, t, client, composeURL4+"/index.txt", composePayload)

	composeURL6, err := sb.ExposePort(ctx, composePort6)
	if err != nil {
		t.Fatal(err)
	}
	waitSandboxURLContains(ctx, t, client, composeURL6+"/index.txt", composePayload)

	composePs, err := sb.Docker.Compose(ctx, "-f", composeDir+"/compose.yml", "ps", "--all")
	if err != nil {
		t.Fatal(err)
	}
	requireProcessContains(ctx, t, composePs, composeContainer4, composeContainer6)

	composeDown, err := sb.Docker.ComposeDown(ctx, "compose.yml", true, composeDir)
	if err != nil {
		t.Fatal(err)
	}
	requireProcessSuccess(ctx, t, composeDown)
}

func integrationRuntimeName() string {
	if runtime := os.Getenv("BEAM_TEST_RUNTIME_NAME"); runtime != "" {
		return strings.ToLower(strings.ReplaceAll(runtime, "_", "-"))
	}
	if pool := os.Getenv("BEAM_TEST_POOL"); pool != "" {
		return strings.ToLower(strings.ReplaceAll(pool, "_", "-"))
	}
	return "default"
}

type processStreamCapture struct {
	stdout  string
	stderr  string
	entries []LogEntry
	firstAt time.Duration
}

func requireProcessStream(ctx context.Context, t *testing.T, proc *Process, firstChunkBy time.Duration) processStreamCapture {
	t.Helper()
	start := time.Now()
	var stdout, stderr strings.Builder
	capture := processStreamCapture{}

	exit, err := proc.Stream(ctx, func(entry LogEntry) {
		if capture.firstAt == 0 {
			capture.firstAt = time.Since(start)
		}
		capture.entries = append(capture.entries, entry)
		switch entry.Stream {
		case "stdout":
			stdout.WriteString(entry.Data)
		case "stderr":
			stderr.WriteString(entry.Data)
		default:
			t.Fatalf("unexpected stream name %q", entry.Stream)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	if exit != 0 {
		t.Fatalf("unexpected stream exit=%d entries=%#v", exit, capture.entries)
	}
	if capture.firstAt == 0 || capture.firstAt > firstChunkBy {
		t.Fatalf("first log chunk was not streamed live, first_at=%s entries=%#v", capture.firstAt, capture.entries)
	}

	capture.stdout = stdout.String()
	capture.stderr = stderr.String()
	return capture
}

func requireContainsAll(t *testing.T, name, value string, needles ...string) {
	t.Helper()
	for _, needle := range needles {
		if !strings.Contains(value, needle) {
			t.Fatalf("%s missing %q: %q", name, needle, value)
		}
	}
}

func requireProcessSuccess(ctx context.Context, t *testing.T, proc *Process) *ProcessResult {
	t.Helper()
	result, err := proc.Output(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 {
		t.Fatalf("process failed exit=%d stdout=%q stderr=%q", result.ExitCode, result.Stdout, result.Stderr)
	}
	return result
}

func requireProcessReaders(ctx context.Context, t *testing.T, proc *Process, wantStdout, wantStderr string) {
	t.Helper()
	if exit, err := proc.Wait(ctx); err != nil || exit != 0 {
		t.Fatalf("reader process wait exit=%d err=%v", exit, err)
	}
	stdout, err := proc.Stdout.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := proc.Stderr.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stdout != wantStdout || stderr != wantStderr {
		t.Fatalf("unexpected direct reader output stdout=%q stderr=%q", stdout, stderr)
	}
	requireReadersConsumed(ctx, t, proc)
}

func requireReadersConsumed(ctx context.Context, t *testing.T, proc *Process) {
	t.Helper()
	if stdout, err := proc.Stdout.Read(ctx); err != nil || stdout != "" {
		t.Fatalf("stdout reader should be empty, got %q err=%v", stdout, err)
	}
	if stderr, err := proc.Stderr.Read(ctx); err != nil || stderr != "" {
		t.Fatalf("stderr reader should be empty, got %q err=%v", stderr, err)
	}
}

func requireProcessContains(ctx context.Context, t *testing.T, proc *Process, values ...string) *ProcessResult {
	t.Helper()
	result := requireProcessSuccess(ctx, t, proc)
	combined := result.Stdout + result.Stderr
	for _, value := range values {
		if !strings.Contains(combined, value) {
			t.Fatalf("process output missing %q: stdout=%q stderr=%q", value, result.Stdout, result.Stderr)
		}
	}
	return result
}

func requireProcessContainsEventually(ctx context.Context, t *testing.T, start func() (*Process, error), value string) *ProcessResult {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var lastResult *ProcessResult
	var lastErr error
	for {
		proc, err := start()
		if err == nil {
			result, outputErr := proc.Output(ctx)
			if outputErr == nil && result.ExitCode == 0 {
				lastResult = result
				if strings.Contains(result.Stdout+result.Stderr, value) {
					return result
				}
			} else if outputErr != nil {
				lastErr = outputErr
			} else {
				lastResult = result
			}
		} else {
			lastErr = err
		}

		if time.Now().After(deadline) {
			if lastResult != nil {
				t.Fatalf("process output never contained %q: stdout=%q stderr=%q", value, lastResult.Stdout, lastResult.Stderr)
			}
			t.Fatalf("process did not produce %q: %v", value, lastErr)
		}

		select {
		case <-ctx.Done():
			t.Fatalf("waiting for process output %q: %v", value, ctx.Err())
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func cleanupDockerContainer(ctx context.Context, sandbox *Sandbox, name string) {
	cleanupCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	proc, err := sandbox.Docker.Raw(cleanupCtx, "rm", "-f", name)
	if err == nil {
		_, _ = proc.Output(cleanupCtx)
	}
}

func cleanupDockerCompose(ctx context.Context, sandbox *Sandbox, workdir string) {
	cleanupCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	proc, err := sandbox.Docker.ComposeDown(cleanupCtx, "compose.yml", true, workdir)
	if err == nil {
		_, _ = proc.Output(cleanupCtx)
	}
}

func TestIntegrationSandboxMemorySnapshot(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()

	client := newIntegrationClient(t, ctx)
	defer client.Close()

	baseImageID := integrationBaseImageID(ctx, t, client)
	const snapshotPort = 8765
	token := fmt.Sprintf("snapshot-%d", time.Now().UnixNano())
	sb, err := client.CreateSandbox(ctx, integrationSandboxConfig(SandboxConfig{
		Name:      "go-sdk-snapshot",
		App:       "go-sdk-snapshot",
		Image:     ImageFromID(baseImageID),
		CPU:       1,
		MemoryMiB: 512,
		Ports:     []int{snapshotPort},
		KeepWarm:  10 * time.Minute,
	}))
	if err != nil {
		t.Fatal(err)
	}
	originalTerminated := false
	defer func() {
		if !originalTerminated {
			_ = sb.Terminate(context.Background())
		}
	}()
	if err := sb.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}

	serverScript := fmt.Sprintf(`
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import os
import socket

token = %q
state = {"count": 0}

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            body = f"token={token} ok pid={os.getpid()}\n"
        elif parsed.path == "/inc":
            values = parse_qs(parsed.query).get("by", ["1"])
            state["count"] += int(values[0])
            body = f"token={token} count={state['count']} pid={os.getpid()}\n"
        elif parsed.path == "/state":
            body = f"token={token} count={state['count']} pid={os.getpid()}\n"
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()
        self.close_connection = True

    def log_message(self, format, *args):
        pass

class DualStackHTTPServer(HTTPServer):
    address_family = socket.AF_INET6
    allow_reuse_address = True

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()

DualStackHTTPServer(("::", %d), Handler).serve_forever()
`, token, snapshotPort)
	server, err := sb.Exec(ctx, []string{"python3", "-c", serverScript}, ExecOptions{Workdir: "/workspace"})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Kill(context.Background())
	requireProcessContainsEventually(ctx, t, func() (*Process, error) {
		return sb.Exec(ctx, []string{
			"python3",
			"-c",
			fmt.Sprintf("import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:%d/health', timeout=3).read().decode())", snapshotPort),
		}, ExecOptions{Workdir: "/workspace"})
	}, token)

	url, err := sb.ExposePort(ctx, snapshotPort)
	if err != nil {
		t.Fatal(err)
	}
	urls, err := sb.ListURLs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if urls[snapshotPort] == "" {
		t.Fatalf("expected listed URL for %d, got %#v", snapshotPort, urls)
	}

	waitSandboxURLContains(ctx, t, client, url+"/health", token, "ok")
	waitSandboxURLContains(ctx, t, client, url+"/inc?by=7", token, "count=7")
	waitSandboxURLContains(ctx, t, client, url+"/state", token, "count=7")

	processes, err := sb.ListProcesses(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(processes) == 0 {
		t.Fatal("expected server process before snapshot")
	}

	checkpointID, err := sb.SnapshotMemory(ctx)
	if err != nil {
		if os.Getenv("BEAM_TEST_ALLOW_SNAPSHOT_UNSUPPORTED") == "1" {
			t.Skip(err)
		}
		t.Fatal(err)
	}

	if err := sb.Terminate(ctx); err != nil {
		t.Fatal(err)
	}
	originalTerminated = true

	restored, err := client.CreateSandboxFromMemorySnapshot(ctx, checkpointID)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Terminate(context.Background())
	if err := restored.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	if restored.SandboxID() == sb.SandboxID() {
		t.Fatalf("restore reused original sandbox id %s", restored.SandboxID())
	}

	restoredURLs, err := restored.ListURLs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	restoredURL := restoredURLs[snapshotPort]
	if restoredURL == "" {
		t.Fatalf("expected restored listed URL for %d, got %#v", snapshotPort, restoredURLs)
	}

	body := waitSandboxURLContains(ctx, t, client, restoredURL+"/state", token, "count=7")
	t.Logf("restored snapshot state: %s", strings.TrimSpace(body))
	waitSandboxURLContains(ctx, t, client, restoredURL+"/inc?by=5", token, "count=12")
	waitSandboxURLContains(ctx, t, client, restoredURL+"/state", token, "count=12")

	restoredProcesses, err := restored.ListProcesses(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(restoredProcesses) == 0 {
		t.Fatal("expected server process after restore")
	}
}
