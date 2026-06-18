package beam

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

const (
	dockerReadyTimeout = 60 * time.Second
	dockerReadyPoll    = 500 * time.Millisecond
)

type Docker struct {
	sandbox *Sandbox
}

type DockerRunOptions struct {
	Detach     bool
	Remove     bool
	Privileged bool
	Name       string
	Ports      map[string]string
	Env        map[string]string
	Volumes    map[string]string
	Network    string
	PID        string
	IPC        string
	CgroupNS   string
	Command    []string
	Workdir    string
}

type DockerBuildOptions struct {
	Tag     string
	File    string
	Network string
	NoCache bool
	Pull    bool
	Workdir string
}

type DockerComposeOptions struct {
	File    string
	Build   bool
	Detach  bool
	Workdir string
}

type composeConfig struct {
	Services map[string]composeService `json:"services"`
}

type composeService struct {
	Build json.RawMessage `json:"build"`
}

func (d *Docker) Run(ctx context.Context, image string, opts DockerRunOptions) (*Process, error) {
	args := []string{"docker", "run"}
	if opts.Detach {
		args = append(args, "-d")
	}
	if opts.Remove {
		args = append(args, "--rm")
	}
	if opts.Privileged {
		args = append(args, "--privileged")
	}
	if opts.Name != "" {
		args = append(args, "--name", opts.Name)
	}
	if opts.Network != "" {
		args = append(args, "--network", opts.Network)
	} else {
		args = append(args, "--network", "host")
	}
	pidMode := opts.PID
	if pidMode == "" {
		pidMode = "host"
	}
	if pidMode != "" {
		args = append(args, "--pid", pidMode)
	}
	if opts.IPC != "" {
		args = append(args, "--ipc", opts.IPC)
	}
	if opts.CgroupNS != "" {
		args = append(args, "--cgroupns", opts.CgroupNS)
	}
	for _, host := range sortedMapKeys(opts.Ports) {
		args = append(args, "-p", host+":"+opts.Ports[host])
	}
	for _, key := range sortedMapKeys(opts.Env) {
		args = append(args, "-e", key+"="+opts.Env[key])
	}
	for _, host := range sortedMapKeys(opts.Volumes) {
		args = append(args, "-v", host+":"+opts.Volumes[host])
	}
	args = append(args, image)
	args = append(args, opts.Command...)
	return d.exec(ctx, args, ExecOptions{Workdir: opts.Workdir})
}

func (d *Docker) Pull(ctx context.Context, image string) (*Process, error) {
	return d.exec(ctx, []string{"docker", "pull", image}, ExecOptions{})
}

func (d *Docker) Build(ctx context.Context, contextPath string, opts DockerBuildOptions) (*Process, error) {
	if contextPath == "" {
		contextPath = "."
	}
	args := []string{"docker", "build"}
	if opts.Tag != "" {
		args = append(args, "-t", opts.Tag)
	}
	if opts.File != "" {
		args = append(args, "-f", opts.File)
	}
	network := opts.Network
	if network == "" {
		network = "host"
	}
	if network != "" {
		args = append(args, "--network", network)
	}
	if opts.NoCache {
		args = append(args, "--no-cache")
	}
	if opts.Pull {
		args = append(args, "--pull")
	}
	args = append(args, contextPath)
	return d.exec(ctx, args, ExecOptions{Workdir: opts.Workdir})
}

func (d *Docker) Ps(ctx context.Context, all bool) (*Process, error) {
	args := []string{"docker", "ps"}
	if all {
		args = append(args, "-a")
	}
	return d.exec(ctx, args, ExecOptions{})
}

func (d *Docker) Logs(ctx context.Context, container string, follow bool) (*Process, error) {
	args := []string{"docker", "logs"}
	if follow {
		args = append(args, "-f")
	}
	args = append(args, container)
	return d.exec(ctx, args, ExecOptions{})
}

func (d *Docker) Exec(ctx context.Context, container string, argv ...string) (*Process, error) {
	if container == "" {
		return nil, sdkError(ErrValidation, "docker exec", "container is required", nil)
	}
	args := append([]string{"docker", "exec", container}, argv...)
	return d.exec(ctx, args, ExecOptions{})
}

func (d *Docker) ComposeUp(ctx context.Context, opts DockerComposeOptions) (*Process, error) {
	args := []string{"docker", "compose"}
	files, err := d.composeFiles(ctx, opts.File, opts.Workdir)
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		args = append(args, "-f", file)
	}
	args = append(args, "up")
	if opts.Detach {
		args = append(args, "-d")
	}
	if opts.Build {
		args = append(args, "--build")
	}
	return d.exec(ctx, args, ExecOptions{Workdir: opts.Workdir})
}

func (d *Docker) ComposeDown(ctx context.Context, file string, volumes bool, workdir string) (*Process, error) {
	args := []string{"docker", "compose"}
	files, err := d.composeFiles(ctx, file, workdir)
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		args = append(args, "-f", file)
	}
	args = append(args, "down")
	if volumes {
		args = append(args, "-v")
	}
	return d.exec(ctx, args, ExecOptions{Workdir: workdir})
}

func (d *Docker) ComposeLogs(ctx context.Context, file string, follow bool, workdir string) (*Process, error) {
	args := []string{"docker", "compose"}
	files, err := d.composeFiles(ctx, file, workdir)
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		args = append(args, "-f", file)
	}
	args = append(args, "logs")
	if follow {
		args = append(args, "-f")
	}
	return d.exec(ctx, args, ExecOptions{Workdir: workdir})
}

func (d *Docker) Raw(ctx context.Context, args ...string) (*Process, error) {
	if len(args) == 0 {
		return nil, sdkError(ErrValidation, "docker", "docker arguments are required", nil)
	}
	if args[0] == "docker" {
		return d.exec(ctx, args, ExecOptions{})
	}
	return d.exec(ctx, append([]string{"docker"}, args...), ExecOptions{})
}

func (d *Docker) Compose(ctx context.Context, args ...string) (*Process, error) {
	if len(args) == 0 {
		return nil, sdkError(ErrValidation, "docker compose", "compose arguments are required", nil)
	}
	return d.exec(ctx, append([]string{"docker", "compose"}, args...), ExecOptions{})
}

func (d *Docker) composeFiles(ctx context.Context, file, workdir string) ([]string, error) {
	if file == "" {
		return nil, nil
	}
	overridePath, err := d.createComposeOverride(ctx, file, workdir)
	if err != nil {
		return nil, err
	}
	if overridePath == "" {
		return []string{file}, nil
	}
	return []string{file, overridePath}, nil
}

func (d *Docker) createComposeOverride(ctx context.Context, file, workdir string) (string, error) {
	services, buildServices, err := d.readComposeConfig(ctx, file, workdir)
	if err != nil {
		return "", err
	}
	if len(services) == 0 {
		return "", nil
	}

	var content strings.Builder
	content.WriteString("services:\n")
	for _, service := range services {
		fmt.Fprintf(&content, "  %q:\n", service)
		content.WriteString("    network_mode: host\n")
		content.WriteString("    pid: host\n")
		if len(services) > 1 {
			content.WriteString("    extra_hosts:\n")
			for _, other := range services {
				fmt.Fprintf(&content, "      - %q\n", other+":127.0.0.1")
			}
		}
		if buildServices[service] {
			content.WriteString("    build:\n")
			content.WriteString("      network: host\n")
		}
	}

	sum := sha256.Sum256([]byte(workdir + "\x00" + file))
	overridePath := fmt.Sprintf("/tmp/.beam-compose-%x.yml", sum[:8])
	if err := d.sandbox.FS.Upload(ctx, overridePath, []byte(content.String()), os.FileMode(0o644)); err != nil {
		return "", err
	}
	return overridePath, nil
}

func (d *Docker) readComposeConfig(ctx context.Context, file, workdir string) ([]string, map[string]bool, error) {
	proc, err := d.exec(ctx, []string{"docker", "compose", "-f", file, "config", "--format", "json"}, ExecOptions{Workdir: workdir})
	if err == nil {
		result, outputErr := proc.Output(ctx)
		if outputErr == nil && result.ExitCode == 0 {
			services, buildServices, parseErr := parseComposeConfig(result.Stdout)
			if parseErr == nil && len(services) > 0 {
				return services, buildServices, nil
			}
		}
	}

	proc, err = d.exec(ctx, []string{"docker", "compose", "-f", file, "config", "--services"}, ExecOptions{Workdir: workdir})
	if err != nil {
		return nil, nil, err
	}
	result, err := proc.Output(ctx)
	if err != nil {
		return nil, nil, err
	}
	if result.ExitCode != 0 {
		message := strings.TrimSpace(result.Stderr)
		if message == "" {
			message = strings.TrimSpace(result.Stdout)
		}
		if message == "" {
			message = "docker compose config failed"
		}
		return nil, nil, sdkError(ErrProcess, "docker compose config", message, nil)
	}

	var services []string
	for _, line := range strings.Split(result.Stdout, "\n") {
		service := strings.TrimSpace(line)
		if service != "" {
			services = append(services, service)
		}
	}
	sort.Strings(services)
	return services, map[string]bool{}, nil
}

func parseComposeConfig(raw string) ([]string, map[string]bool, error) {
	var config composeConfig
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		return nil, nil, err
	}
	services := make([]string, 0, len(config.Services))
	buildServices := map[string]bool{}
	for name, service := range config.Services {
		services = append(services, name)
		build := strings.TrimSpace(string(service.Build))
		if build != "" && build != "null" {
			buildServices[name] = true
		}
	}
	sort.Strings(services)
	return services, buildServices, nil
}

func (d *Docker) WaitReady(ctx context.Context) error {
	if d == nil || d.sandbox == nil {
		return sdkError(ErrValidation, "docker wait ready", "sandbox is nil", nil)
	}
	waitCtx, cancel := context.WithTimeout(ctx, dockerReadyTimeout)
	defer cancel()

	ticker := time.NewTicker(dockerReadyPoll)
	defer ticker.Stop()

	var lastErr error
	var lastResult *ProcessResult
	for {
		proc, err := d.sandbox.Exec(waitCtx, []string{"docker", "info", "--format", "{{.ServerVersion}}"}, ExecOptions{})
		if err == nil {
			lastResult, err = proc.Output(waitCtx)
			if err == nil && lastResult.ExitCode == 0 && strings.TrimSpace(lastResult.Stdout) != "" {
				return nil
			}
		}
		if err != nil {
			lastErr = err
		}

		select {
		case <-waitCtx.Done():
			if lastResult != nil {
				message := strings.TrimSpace(lastResult.Stderr)
				if message == "" {
					message = strings.TrimSpace(lastResult.Stdout)
				}
				if message == "" {
					message = "docker daemon did not become ready"
				}
				return sdkError(ErrSandboxConnection, "docker wait ready", message, waitCtx.Err())
			}
			if lastErr != nil {
				return wrapError(ErrSandboxConnection, "docker wait ready", lastErr)
			}
			return sdkError(ErrSandboxConnection, "docker wait ready", "docker daemon did not become ready", waitCtx.Err())
		case <-ticker.C:
		}
	}
}

func (d *Docker) exec(ctx context.Context, args []string, opts ExecOptions) (*Process, error) {
	if err := d.WaitReady(ctx); err != nil {
		return nil, err
	}
	return d.sandbox.Exec(ctx, args, opts)
}

func sortedMapKeys(values map[string]string) []string {
	if len(values) == 0 {
		return nil
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
