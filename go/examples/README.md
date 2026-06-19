# Beam Go Sandbox Examples

Set `BEAM_TOKEN` and gateway configuration first. For a local beta9 gateway:

```bash
export BEAM_TOKEN=...
export BEAM_GATEWAY_HOST=127.0.0.1
export BEAM_GATEWAY_PORT=1993
```

Run any example with `go run`:

```bash
go run ./examples/basic
go run ./examples/filesystem
go run ./examples/http
go run ./examples/snapshot
go run ./examples/sync-local-dir
BEAM_DOCKER_POOL=gvisor go run ./examples/docker
```

`SandboxConfig.SyncLocalDir` is optional and defaults to false. Only the
`sync-local-dir` example opts into uploading a local directory to `/mnt/code`.

Notes:

- `basic` demonstrates `RunCode`, argv-safe `Exec`, and live process streaming.
- `filesystem` covers upload, stat, list, replace, find, and download.
- `http` starts a server, exposes a port, lists URLs, and sends the required
  bearer token for local protected routes.
- `snapshot` creates a memory snapshot and restores a new sandbox from it.
- `docker` requires an image built with `Image.WithDocker()` and a sandbox
  created with `DockerEnabled: true`; use `BEAM_DOCKER_POOL=gvisor` to force the
  gVisor pool locally.
