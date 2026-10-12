# Production VM validation

The release checks load the shipped SDK from a separate npm installation through
`BEAM_VM_PACKAGE`. They call the production gateway at `https://app.beam.cloud`.
The baseline parity suite and the extended feature suite run serially, creating
unique temporary VMs and cleaning up their VMs, named artifacts, secret fixture,
volume and disk registration.

## Run the released package

Install this repository's development dependencies and the Python Beam SDK
(used only to create and remove auxiliary resource fixtures). The extended suite
expects the workspace secrets `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for real
agent calls. The fixture signs in the guest Codex CLI using its injected key.
Keep `BEAM_TOKEN` in the environment.

`BEAM_VM_CODEX_SECRET` can name a different workspace secret for the Codex test.
An invalid provider credential fails that inference check; it does not prevent
the other VM capability checks from running.

```bash
npm install --prefix /tmp/beam-sdk-registry @beamcloud/beam-js@1.1.4 --ignore-scripts
export BEAM_VM_PACKAGE=/tmp/beam-sdk-registry/node_modules/@beamcloud/beam-js
export BEAM_VM_EXPECT_VERSION=1.1.4
# Select a Python executable with the current Beam SDK and grpc installed.
export BEAM_VM_FIXTURE_PYTHON=/absolute/path/to/python3
npm run test:e2e:vm:production
```

`BEAM_VM_IMAGE_ID` can select an existing prepared desktop VM image for the
runtime checks. Omitting it builds the default image in the baseline suite;
the extended suite's runtime fixture uses the production prepared image.
`BEAM_VM_BUILD_CONTEXT` optionally retains the tiny custom Dockerfile context
between runs, allowing the image cache to be checked too.

The main VM uses 1 CPU and 2 GiB RAM; artifact forks and the mount fixture use
small CPU instances. The suite also exercises the current-VM fork, which
inherits the source resources. Image preparation builds a real Ubuntu VM image;
Claude and Codex checks make real provider calls. Content-addressed images and
immutable backing snapshots follow the platform's normal retention policy.

## Coverage

| Capability               | Production assertions                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package                  | Registry version; CommonJS and ESM execute against the same VM                                                                                                                   |
| Configuration            | CPU/memory units, environment maps, metadata, request idempotency, prepare/create/get/connect/list and filters                                                                   |
| Lifecycle                | Stop/start filesystem persistence; pause/resume process survival; automatic wake; cold boot; stale runtime guards; lookup without wake                                           |
| Idle policy              | Actual automatic pause/stop; touch; renewed activity leases; release after completion                                                                                            |
| Artifacts                | Workspace/scoped snapshot and template create/list/get/delete/fork; current VM fork; independent roots; artifacts after source removal                                           |
| Processes                | Literal argv and text/byte stdin; shell, cwd and environment; sync/async Python; process lists and reattachment; cancellation/timeouts preserve the process; logs and exit codes |
| Files                    | All filesystem methods, upload/download, binary and Unicode fidelity, empty files, permissions, search and replacement                                                           |
| HTTP access              | Protected URLs, browser access cookie exchange, cookie/token revocation, URL helpers, expose/unexpose                                                                            |
| Egress                   | Runtime block/allow-list configuration and actual rejected outbound connections                                                                                                  |
| Private TCP              | Duplex byte fidelity; real WebSocket disconnect/reconnect without duplicated output; loopback forwarding and cancellation                                                        |
| SSH and sync             | SSH commands, recursive SCP, identity reattachment, rsync, changed files in watch mode and clean shutdown                                                                        |
| Docker                   | Real container run, Dockerfile build, Compose container run and standalone Compose entry point                                                                                   |
| Desktop                  | PNG bytes/local save, resolution, mouse/buttons/scroll/keys, literal clipboard UTF-8, drag, application launch and valid H.264 MP4                                               |
| Images and mounts        | Dockerfile context upload, packaged guest-service installation, standalone image build, secrets/environment, disk/volume persistence across restart                              |
| Agents and observability | Installed CLI versions, foreground/background prompts, authentication errors, successful Claude/Codex responses, session/unit/PID/follow logs, metrics                           |

The production run exposed an intentional sync-close race in 1.1.0: an active
rsync cancellation could reject `watcher.done` during `watcher.close()`. Version
1.1.1 treats intentional closure as completion and preserves unexpected transfer
failures as errors.

## Plain JavaScript consumer workflow

The package includes `examples/vm-agent-workspace.mjs`. From a project with the
released SDK installed, run it with `BEAM_TOKEN` in the environment:

```bash
node node_modules/@beamcloud/beam-js/examples/vm-agent-workspace.mjs
```

It uses the public package import and the default image, without internal image
IDs or a test framework. It checks execution, files, an independent snapshot
fork, lookup while paused, reconnect/resume and durable-root restart, then
removes its VMs and checkpoint. The first production run prepared and published
the default image; a second run verified the image cache.

On October 12, 2026, the two client-observed runs took 50.41 seconds and 1.38
seconds to create an exec-ready VM. Image build and publication accounted for
44.1 seconds of the first run. Snapshot forks took 1.40–1.46 seconds,
pause/reconnect 0.93–1.00 seconds, and durable-root starts 0.71–0.75 seconds.
These are individual end-to-end samples, including network requests, rather
than an infrastructure benchmark.

Version 1.1.3 ports the VM feature onto the current `beam-client/js` SDK.
The canonical dependencies, Docker installer, file synchronization and published
sandbox cache identity are preserved. Builds and releases originate from the
`js` directory of `beam-cloud/beam-client`.

Version 1.1.4 waits for the guest systemd control socket before launching a
background prompt, so it works immediately after exec-ready creation. Production
coverage includes a real background Claude reply using an injected workspace
secret, followed by session and systemd unit log retrieval.
