# Beam Go Sandbox Examples

Set `BEAM_TOKEN` and run a sandbox. The SDK uses Beam production by default.

```bash
export BEAM_TOKEN=...
```

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

result, err := sandbox.RunCode(ctx, `print("hello from Beam")`, beam.ExecOptions{})
if err != nil {
    return err
}
fmt.Print(result.Stdout)
```

Run the core examples with `go run`:

```bash
go run ./examples/basic
go run ./examples/filesystem
go run ./examples/http
go run ./examples/snapshot
go run ./examples/docker
go run ./examples/resources
```

Install the SDK from GitHub:

```bash
go get github.com/beam-cloud/beam-client/go@latest
```

The examples use `SandboxConfig.Name` as the app name that groups related
sandboxes.

Notes:

- `basic` demonstrates `RunCode`, argv-safe `Exec`, and live process streaming.
- `filesystem` covers text reads/writes, stat, list, replace, find, and download.
- `http` starts a server, exposes a port, lists URLs, and sends the required
  bearer token for local protected routes.
- `snapshot` creates a memory snapshot and restores a new sandbox from it.
- `docker` requires an image built with `Image.WithDocker()` and a sandbox
  created with `DockerEnabled: true`.
- `resources` shows GPU, secrets, volume, and cloud bucket configuration.

Additional development examples:

```bash
go run ./examples/sync-local-dir
```

Development note: to point examples at a local beta9 gateway, set
`BEAM_GATEWAY_HOST=127.0.0.1` and `BEAM_GATEWAY_PORT=1993`.
