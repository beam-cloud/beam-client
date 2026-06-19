# Sandbox Naming

The sandbox SDK uses two names:

- `App` groups sandboxes under an app namespace.
- `Name` exists for older sandbox code. If `App` is empty, the SDK sends `Name`
  as the app namespace.

`Name` does not label a running sandbox. `SandboxID` returns the generated
container ID.

## Backend Contract

The backend stores app and stub grouping. It does not store a sandbox display
name.

- `GetOrCreateStubRequest.name` is the sandbox stub name.
- `GetOrCreateStubRequest.app_name` is the app namespace.
- If `app_name` is empty, the backend falls back to `app_name = name`.
- `CreatePodRequest` accepts `stub_id`, `image_id`, and `checkpoint_id`.
- `ContainerState` does not persist a sandbox display name.

## SDK Usage

Prefer `App` for new sandbox code:

```go
sandbox, err := client.CreateSandbox(ctx, beam.SandboxConfig{
    App:   "debug-tools",
    Image: beam.NewImage(),
})
```

Existing code remains valid:

```go
sandbox, err := client.CreateSandbox(ctx, beam.SandboxConfig{
    Name:  "debug-tools",
    Image: beam.NewImage(),
})
```

That compatibility form still groups sandboxes under the `debug-tools` app
namespace.

## SDK Policy

- Keep `Name` as a compatibility alias for `App`.
- Do not change `Name` to mean sandbox display name.
- Add `SandboxName` only after the backend persists and returns that field.

After backend support, use:

```go
sandbox, err := client.CreateSandbox(ctx, beam.SandboxConfig{
    App:         "debug-tools",
    SandboxName: "debug-run-001",
    Image:       beam.NewImage(),
})
```

## Backend Work

Add:

- `sandbox_name` or `display_name` on `CreatePodRequest`.
- `DisplayName` on `ContainerRequest`.
- `DisplayName` on `ContainerState` and container API responses.
- Redis persistence for the display name.
- Container list/status/event/log metadata where the display name is useful.
