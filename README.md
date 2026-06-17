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

## Go SDK

The Go module is `github.com/beam-cloud/beam-client/go`.

`SandboxConfig.SyncLocalDir` is optional and defaults to false. Set it to true
only when you want to upload `Workdir` into the sandbox code mount at
`/mnt/code`.

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
```

Runnable sandbox examples live in `go/examples`:

```bash
cd go
go run ./examples/basic
go run ./examples/filesystem
go run ./examples/http
go run ./examples/snapshot
go run ./examples/sync-local-dir
BEAM_DOCKER_POOL=gvisor go run ./examples/docker
```
