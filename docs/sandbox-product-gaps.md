# Sandbox Product Gaps

This tracks sandbox gaps found while comparing Beam's Go SDK with Modal's Go
sandbox SDK and docs. The Beam Go SDK now covers the client-side wrappers that
map cleanly onto existing Beam RPCs. The items below need backend, gateway, or
worker work before the SDK can expose them cleanly.

## Naming And Discovery

- Add a real per-sandbox display name separate from the app/stub name.
- Support lookup by app plus sandbox display name.
- Support listing running sandboxes, with app and metadata filters.
- Add server-side sandbox tags or labels for filtering and lifecycle tooling.

## HTTP Access Control

- Add sandbox connect-token creation for HTTP and WebSocket access.
- Allow connect tokens to target a specific sandbox port.
- Support optional user metadata on connect tokens and forward verified metadata
  to the sandbox request headers.
- Keep `ExposePort` and `ListURLs` as the simpler public URL path, but document
  connect tokens as the authenticated user/session path once available.

## Process IO

- Add stdin support for sandbox processes.
- Add PTY support for interactive shells and terminal-style agent sessions.
- Add stdout/stderr behavior options such as pipe versus ignore.
- Keep the current log streaming helpers, but allow `io.Reader`/`io.Writer`
  style process handles for Go users that expect standard subprocess semantics.

## Snapshots And Mounts

- Add directory snapshots, not only full filesystem images and memory snapshots.
- Add mount/unmount of snapshot images or directory snapshots into an already
  running sandbox.
- Add retention/TTL controls for snapshot artifacts.
- Add deletion or lifecycle APIs for snapshot cleanup.

## Networking

- Support explicit tunnel modes beyond the current exposed HTTP URL shape:
  encrypted HTTP/TLS, raw TCP, and HTTP/2 where the backend supports them.
- Add custom-domain support for sandbox exposed routes.
- Add inbound CIDR allow lists for exposed sandbox services.
- Add outbound domain allow lists, not only CIDR allow lists.

## Lifecycle Configuration

- Add startup command support for sandboxes where the sandbox primary process is
  not just the process manager.
- Add idle timeout semantics distinct from keep-warm/TTL.
- Add readiness probes, such as TCP and exec probes, for services started by a
  sandbox startup command.

## Placement And Identity

- Add first-class region/cloud placement fields if the scheduler exposes them
  outside pool config.
- Add optional OIDC identity token injection for sandbox workloads.
- Add proxy/private-network configuration if backend support exists or is added.

## Current SDK Coverage

The Go SDK currently covers:

- Production-default client setup.
- Sandbox create, connect by container ID, terminate, status, poll, wait, TTL.
- Exec, shell exec, run code, process wait/kill/status/output/log streaming.
- Filesystem upload/download/read/write/stat/list/mkdir/remove/replace/find.
- Local file sync with `.beamignore`.
- Volumes and cloud bucket mounts.
- Secrets, env, CPU, memory, GPU, pool, network block/CIDR allow list.
- Exposed URLs via `ExposePort` and `ListURLs`.
- Memory snapshots and create image from filesystem.
- Docker-in-Docker and Docker Compose helpers.
