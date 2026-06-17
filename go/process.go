package beam

import (
	"context"
	"strings"
	"time"

	pb "github.com/beam-cloud/beta9/proto"
)

type ExecOptions struct {
	Workdir string
	Env     map[string]string
	Timeout time.Duration
}

type Process struct {
	sandbox *Sandbox
	PID     int
	Stdout  *OutputReader
	Stderr  *OutputReader
}

type ProcessStatus struct {
	Running  bool
	Status   string
	ExitCode int
}

type ProcessInfo struct {
	PID      int
	Running  bool
	Command  string
	Workdir  string
	Env      map[string]string
	ExitCode int
}

type ProcessResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

type LogEntry struct {
	Stream string
	Data   string
}

type OutputReader struct {
	process *Process
	stream  string
}

func (s *Sandbox) Exec(ctx context.Context, argv []string, opts ExecOptions) (*Process, error) {
	if len(argv) == 0 {
		return nil, sdkError(ErrValidation, "exec", "argv must not be empty", nil)
	}
	return s.ExecShell(ctx, quoteArgv(argv), opts)
}

func (s *Sandbox) ExecShell(ctx context.Context, command string, opts ExecOptions) (*Process, error) {
	if strings.TrimSpace(command) == "" {
		return nil, sdkError(ErrValidation, "exec", "command must not be empty", nil)
	}
	callCtx := ctx
	cancel := func() {}
	if opts.Timeout > 0 {
		callCtx, cancel = context.WithTimeout(ctx, opts.Timeout)
	}
	defer cancel()
	cwd := opts.Workdir
	if cwd == "" {
		cwd = "/workspace"
	}
	res, err := s.client.pod.SandboxExec(callCtx, &pb.PodSandboxExecRequest{
		ContainerId: s.containerID,
		Command:     command,
		Cwd:         cwd,
		Env:         copyStringMap(opts.Env),
	})
	if err != nil {
		return nil, wrapError(ErrProcess, "exec", err)
	}
	if !res.GetOk() {
		return nil, sdkError(ErrProcess, "exec", res.GetErrorMsg(), nil)
	}
	p := &Process{sandbox: s, PID: int(res.GetPid())}
	p.Stdout = &OutputReader{process: p, stream: "stdout"}
	p.Stderr = &OutputReader{process: p, stream: "stderr"}
	return p, nil
}

func (s *Sandbox) RunCode(ctx context.Context, code string, opts ExecOptions) (*ProcessResult, error) {
	p, err := s.Exec(ctx, []string{"python3", "-c", code}, opts)
	if err != nil {
		return nil, err
	}
	return p.Output(ctx)
}

func (p *Process) Status(ctx context.Context) (ProcessStatus, error) {
	res, err := p.sandbox.client.pod.SandboxStatus(ctx, &pb.PodSandboxStatusRequest{
		ContainerId: p.sandbox.containerID,
		Pid:         int32(p.PID),
	})
	if err != nil {
		return ProcessStatus{}, wrapError(ErrProcess, "process status", err)
	}
	if !res.GetOk() {
		return ProcessStatus{}, sdkError(ErrProcess, "process status", res.GetErrorMsg(), nil)
	}
	status := res.GetStatus()
	return ProcessStatus{
		Running:  status == "running",
		Status:   status,
		ExitCode: int(res.GetExitCode()),
	}, nil
}

func (p *Process) Wait(ctx context.Context) (int, error) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, err := p.Status(ctx)
		if err != nil {
			return 0, err
		}
		if !status.Running {
			return status.ExitCode, nil
		}
		select {
		case <-ctx.Done():
			return 0, wrapError(ErrProcess, "wait", ctx.Err())
		case <-ticker.C:
		}
	}
}

func (p *Process) Kill(ctx context.Context) error {
	res, err := p.sandbox.client.pod.SandboxKill(ctx, &pb.PodSandboxKillRequest{
		ContainerId: p.sandbox.containerID,
		Pid:         int32(p.PID),
	})
	if err != nil {
		return wrapError(ErrProcess, "kill", err)
	}
	if !res.GetOk() {
		return sdkError(ErrProcess, "kill", res.GetErrorMsg(), nil)
	}
	return nil
}

func (p *Process) Output(ctx context.Context) (*ProcessResult, error) {
	exit, err := p.Wait(ctx)
	if err != nil {
		return nil, err
	}
	stdout, err := p.Stdout.Read(ctx)
	if err != nil {
		return nil, err
	}
	stderr, err := p.Stderr.Read(ctx)
	if err != nil {
		return nil, err
	}
	return &ProcessResult{ExitCode: exit, Stdout: stdout, Stderr: stderr}, nil
}

func (p *Process) Stream(ctx context.Context, sink func(LogEntry)) (int, error) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		stdout, err := p.Stdout.Read(ctx)
		if err != nil {
			return 0, err
		}
		if stdout != "" && sink != nil {
			sink(LogEntry{Stream: "stdout", Data: stdout})
		}
		stderr, err := p.Stderr.Read(ctx)
		if err != nil {
			return 0, err
		}
		if stderr != "" && sink != nil {
			sink(LogEntry{Stream: "stderr", Data: stderr})
		}
		status, err := p.Status(ctx)
		if err != nil {
			return 0, err
		}
		if !status.Running {
			stdout, err = p.Stdout.Read(ctx)
			if err != nil {
				return 0, err
			}
			if stdout != "" && sink != nil {
				sink(LogEntry{Stream: "stdout", Data: stdout})
			}
			stderr, err = p.Stderr.Read(ctx)
			if err != nil {
				return 0, err
			}
			if stderr != "" && sink != nil {
				sink(LogEntry{Stream: "stderr", Data: stderr})
			}
			return status.ExitCode, nil
		}
		select {
		case <-ctx.Done():
			return 0, wrapError(ErrProcess, "stream", ctx.Err())
		case <-ticker.C:
		}
	}
}

func (r *OutputReader) Read(ctx context.Context) (string, error) {
	if r == nil || r.process == nil {
		return "", sdkError(ErrValidation, "read output", "process is nil", nil)
	}
	switch r.stream {
	case "stdout":
		res, err := r.process.sandbox.client.pod.SandboxStdout(ctx, &pb.PodSandboxStdoutRequest{
			ContainerId: r.process.sandbox.containerID,
			Pid:         int32(r.process.PID),
		})
		if err != nil {
			return "", wrapError(ErrProcess, "read stdout", err)
		}
		if !res.GetOk() {
			return "", sdkError(ErrProcess, "read stdout", res.GetErrorMsg(), nil)
		}
		return res.GetStdout(), nil
	case "stderr":
		res, err := r.process.sandbox.client.pod.SandboxStderr(ctx, &pb.PodSandboxStderrRequest{
			ContainerId: r.process.sandbox.containerID,
			Pid:         int32(r.process.PID),
		})
		if err != nil {
			return "", wrapError(ErrProcess, "read stderr", err)
		}
		if !res.GetOk() {
			return "", sdkError(ErrProcess, "read stderr", res.GetErrorMsg(), nil)
		}
		return res.GetStderr(), nil
	default:
		return "", sdkError(ErrValidation, "read output", "unknown stream", nil)
	}
}

func (s *Sandbox) ListProcesses(ctx context.Context) ([]ProcessInfo, error) {
	res, err := s.client.pod.SandboxListProcesses(ctx, &pb.PodSandboxListProcessesRequest{ContainerId: s.containerID})
	if err != nil {
		return nil, wrapError(ErrProcess, "list processes", err)
	}
	if !res.GetOk() {
		return nil, sdkError(ErrProcess, "list processes", res.GetErrorMsg(), nil)
	}
	out := make([]ProcessInfo, 0, len(res.GetProcesses()))
	for _, proc := range res.GetProcesses() {
		out = append(out, ProcessInfo{
			PID:      int(proc.GetPid()),
			Running:  proc.GetRunning(),
			Command:  proc.GetCmd(),
			Workdir:  proc.GetCwd(),
			Env:      parseEnv(proc.GetEnv()),
			ExitCode: int(proc.GetExitCode()),
		})
	}
	return out, nil
}

func quoteArgv(argv []string) string {
	quoted := make([]string, 0, len(argv))
	for _, arg := range argv {
		quoted = append(quoted, shellQuote(arg))
	}
	return strings.Join(quoted, " ")
}

func shellQuote(arg string) string {
	if arg == "" {
		return "''"
	}
	if strings.IndexFunc(arg, func(r rune) bool {
		return !(r >= 'a' && r <= 'z') &&
			!(r >= 'A' && r <= 'Z') &&
			!(r >= '0' && r <= '9') &&
			!strings.ContainsRune("@%_+=:,./-", r)
	}) == -1 {
		return arg
	}
	return "'" + strings.ReplaceAll(arg, "'", `'"'"'`) + "'"
}

func parseEnv(values []string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	out := map[string]string{}
	for _, value := range values {
		key, val, ok := strings.Cut(value, "=")
		if ok {
			out[key] = val
		}
	}
	return out
}
