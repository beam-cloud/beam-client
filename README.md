# Beam Client

This repository contains Beam client SDKs.

## Layout

- `python/` contains the existing Python package and CLI release inputs.
- `go/` contains the Go SDK module at `github.com/beam-cloud/beam-client/go`.

## Development

Run Go tests:

```bash
make test-go
```

Run live Go sandbox integration tests against the local beta9 gateway:

```bash
make test-go-integration
```

The integration target reads `~/.beta9/config.ini` by default and requires a
local gateway (`localhost`, `127.0.0.1`, or `0.0.0.0`, which the harness maps
to loopback). It will fail before
creating any sandbox if the resolved gateway is `gateway.beam.cloud` or staging.
Use `BEAM_TOKEN`, `BEAM_GATEWAY_HOST`, and `BEAM_GATEWAY_PORT` or the matching
`BETA9_*` variables to point at a specific local setup. For a local token that
is not the default context, run:

```bash
BEAM_TOKEN=... make test-go-integration
```

Run runtime-specific integration targets:

```bash
make test-go-integration-runc
make test-go-integration-gvisor
```

The runc target uses the scheduler default pool. The gVisor target defaults
`BEAM_TEST_POOL` to `gvisor`; set `BEAM_TEST_POOL=...` to override the pool name
used by sandbox creation.

Run the optional Docker sandbox smoke on the gVisor pool:

```bash
make test-go-integration-docker
```

Run Python tests:

```bash
cd python && poetry run pytest
```

Build the Python CLI wheel:

```bash
cd python && poetry build -f wheel
```

Publish the Python package to PyPI:

```bash
POETRY_PYPI_TOKEN_PYPI=... make publish-python
```

## Go SDK

The Go module is `github.com/beam-cloud/beam-client/go`.

Install:

```bash
go get github.com/beam-cloud/beam-client/go@latest
```

Pin a release:

```bash
go get github.com/beam-cloud/beam-client/go@v0.1.0
```

Import:

```go
import beam "github.com/beam-cloud/beam-client/go"
```

### Configuration

For production, set `BEAM_TOKEN` and call `beam.NewClient(ctx)`. The SDK
defaults to Beam's production gateway at `gateway.beam.cloud:443`.

```bash
export BEAM_TOKEN=...
```

`beam.NewClient(ctx)` resolves configuration in this order:

1. Explicit options such as `beam.WithToken` and `beam.WithGateway`.
2. `BEAM_TOKEN`, `BEAM_GATEWAY_HOST`, `BEAM_GATEWAY_PORT`.
3. `BETA9_TOKEN`, `BETA9_GATEWAY_HOST`, `BETA9_GATEWAY_PORT`.
4. `~/.beam/config.ini` or `~/.beta9/config.ini`.
5. `gateway.beam.cloud:443`.

For development against a local beta9 gateway, override the gateway:

```bash
export BEAM_TOKEN=...
export BEAM_GATEWAY_HOST=127.0.0.1
export BEAM_GATEWAY_PORT=1993
```

### Sandboxes

Set `SandboxConfig.Name` to the app name that groups related sandboxes. Each
created sandbox still has a generated container ID, available from
`sandbox.SandboxID()`.

```go
ctx := context.Background()
client, err := beam.NewClient(ctx)
if err != nil {
    return err
}
defer client.Close()

sandbox, err := client.CreateSandbox(ctx, beam.SandboxConfig{
    Name:  "example",
    Image: beam.NewImage(beam.WithPythonVersion("python3.11")),
})
if err != nil {
    return err
}
defer sandbox.Terminate(context.Background())

result, err := sandbox.RunCode(ctx, "print('hello from Beam')", beam.ExecOptions{})
if err != nil {
    return err
}
fmt.Print(result.Stdout)
```

### Processes And Logs

Use `Exec` for argv-safe command execution and `ExecShell` when you intentionally
want shell text sent as-is. Process stdout and stderr reads are consumptive
server deltas, so use `Process.Output` for a completed result or `Process.Stream`
for live logs.

```go
proc, err := sandbox.Exec(ctx, []string{"sh", "-lc", "echo out; echo err >&2"}, beam.ExecOptions{})
if err != nil {
    return err
}
exitCode, err := proc.Stream(ctx, func(entry beam.LogEntry) {
    fmt.Print(entry.Data)
})
```

### Files, Volumes, Docker, And Snapshots

Sandbox filesystem APIs are available through `sandbox.FS`. Beam volumes and
cloud buckets are configured with `beam.NewVolume` and `beam.NewCloudBucket`.

Docker-in-Docker requires both `Image.WithDocker()` and
`SandboxConfig.DockerEnabled`. Docker helpers default inner containers and
Compose services to host networking/PID mode so they work under both runc and
gVisor sandbox runtimes.

```go
sandbox, err := client.CreateSandbox(ctx, beam.SandboxConfig{
    Name:          "docker-example",
    Image:         beam.NewImage(beam.WithPythonVersion("python3.11")).WithDocker(),
    DockerEnabled: true,
})
if err != nil {
    return err
}
proc, err := sandbox.Docker.Run(ctx, "busybox:1.36", beam.DockerRunOptions{
    Remove:  true,
    Command: []string{"sh", "-c", "echo hello"},
})
```

Use `SnapshotMemory` to checkpoint a sandbox and
`CreateSandboxFromMemorySnapshot` to restore it:

```go
checkpointID, err := sandbox.SnapshotMemory(ctx)
restored, err := client.CreateSandboxFromMemorySnapshot(ctx, checkpointID)
```

Runnable sandbox examples live in `go/examples`:

```bash
cd go
export BEAM_TOKEN=...
go run ./examples/basic
go run ./examples/filesystem
go run ./examples/http
go run ./examples/snapshot
go run ./examples/docker
```

## Releases

Python CLI: create a GitHub release named `cli-X.Y.Z`. `release-cli.yml` builds
the wheel from `python/` and embeds it in the platform CLI binaries with PyApp.

Go SDK: tag the `go/` submodule as `go/vX.Y.Z`:

```bash
git tag go/v0.1.0
git push origin go/v0.1.0
```

Go users request the module version without the subdirectory prefix:

```bash
go get github.com/beam-cloud/beam-client/go@v0.1.0
```

`release-go.yml` checks the tag shape, runs Go tests, and verifies that a fresh
module can fetch and import `github.com/beam-cloud/beam-client/go` from GitHub.
The Go SDK publishes through the Git tag; it has no binary artifact.
