# Persistent virtual machines

`VM` creates and manages persistent CPU Linux machines with a durable root,
systemd, optional Docker and SSH, a browser terminal, and an optional desktop.
Every factory returns the same `VM` class.

Install the SDK and configure a server-side Beam token:

```bash
npm install @beamcloud/beam-js@1.1.3
export BEAM_TOKEN=YOUR_BEAM_TOKEN
```

Save the following example as `vm.mjs` and run it with `node vm.mjs`. The
JavaScript examples also work in TypeScript; the package includes declarations.

```ts
import { beamOpts, VM } from "@beamcloud/beam-js";

beamOpts.token = process.env.BEAM_TOKEN || "";
beamOpts.workspaceId = process.env.BEAM_WORKSPACE_ID || "";

const vm = await VM.create({
  name: "agent-workspace", // optional; otherwise generated
  cpu: 1, // cores, or "1000m"
  memory: "2Gi", // MiB or a quantity
  desktop: true,
  protectedPorts: [7681],
  idleTimeout: 300, // idle seconds; 0 keeps running
  idleAction: "pause", // "stop" or "pause"
  autoResume: true,
});

const command = await vm.exec(["node", "--version"]);
await command.wait({ timeoutMs: 30_000 });
console.log(await command.stdout.read());

await vm.fs.writeText("/workspace/hello.txt", "hello");
const png = await vm.desktop.screenshot("./desktop.png");
await vm.pause();
await vm.close(); // close local tunnels/watchers
```

The example leaves the VM paused. Save `vm.id` and use `VM.connect(id)` for the
next session; `vm.remove()` deletes it. For a plain JavaScript workflow that
also checkpoints, forks, reconnects and cleans up, see
[the runnable agent workspace example](../examples/vm-agent-workspace.mjs).

`new VM(config).create()` is equivalent. The default image is Ubuntu 22.04,
with 4 CPU cores, 8192 MiB of RAM and a 50 GiB writable root. VMs are CPU-only;
GPU and unknown configuration fields are rejected. If `workspaceId` is omitted,
the SDK resolves the token's current workspace. Set it explicitly when selecting
a workspace. Authentication and gateway settings use the existing `beamOpts`.

## Find, connect and manage lifecycle

```ts
const existing = await VM.get("agent-workspace"); // read-only: does not start it
const ready = await VM.connect(existing.id); // starts/resumes and waits
const fleet = await VM.list({
  metadata: { user_id: "123" },
  status: "running",
});

await ready.refresh();
console.log(ready.id, ready.name, ready.status, ready.spec, ready.metadata);
console.log(ready.info); // full typed management response
await ready.wait({ services: true }); // also wait for SSH/UI ports
await ready.update({ idleTimeout: 60, idleAction: "pause", autoResume: true });
await ready.update({ metadata: {} }); // replaces the whole map
await ready.stop(); // keep root; cold boot next time
await ready.start();
await ready.pause(); // keep RAM and running processes
await ready.resume();
await ready.start({ cold: true }); // explicitly discard saved RAM
await ready.remove(); // delete VM and its managed root
```

`create`, `start`, `resume`, `connect` and `fork` wait for exec readiness by
default. Pass `{ wait: false }` to return after submission, then call `wait()`.
Startup/wait deadlines use `timeoutMs`; `signal` accepts an `AbortSignal`.
Management results are cached on the object; call `refresh()` to read current
state. `get()` and `list()` do not wake sleeping VMs. Guest operations wake them
only when `autoResume` is enabled.

For an agent returning to a known workspace, call `VM.connect(nameOrId)`.
`VM.create({ name })` creates a new VM and reports a conflict if the name is
already in use. Use an application-owned `requestId` when retrying the same
creation, rather than generating another request after a timeout.

`idleTimeout` (also accepted as Python/CLI's `ttl`) measures idle seconds. It
stops or pauses the VM instead of deleting it. `stop({ noSnapshot: true })`
skips creating the visible stop snapshot while retaining the durable root.
`pause()` saves RAM plus the paired disk state. `close()` only releases local
connections and watchers; it does not stop, pause or delete the VM.

Creation uses a generated `requestId` UUID and freezes the prepared image,
keys and request on the object. Repeating `create()` on that object submits
the identical request. Supply your own UUID and identical configuration to
recover a creation across application restarts. `prepare()` resolves the
image, mounts and keys without starting compute. A readiness timeout does not
delete the resource; use its name or request ID to recover and inspect it.

## Snapshots, forks and templates

Snapshots and templates are immutable **disk** artifacts. They can outlive their
source VM. A named snapshot captures the root, not RAM or external shared
volumes. To preserve running processes, use `pause()`/`resume()`.

```ts
const snapshot = await vm.snapshots.create("before-edit");
console.log(snapshot.id, snapshot.name, snapshot.info);
const snapshots = await vm.snapshots.list(); // only this VM's snapshots
const all = await VM.snapshots.list(); // workspace, including old sources
const saved = await VM.snapshots.get("before-edit");

const branch = await saved.fork({ name: "experiment", cpu: 2 });
// Equivalently: VM.create({ name: "experiment", snapshot: saved.id })
const current = await vm.fork("current-root-copy");

const template = await vm.templates.create({
  name: "dev-base",
  description: "Tools installed",
});
const templates = await VM.templates.list();
const seed = await VM.templates.get("dev-base");
const next = await seed.fork({ name: "next-agent", desktop: false });
// Equivalently: VM.create({ name: "next-agent", template: seed.id })

await vm.snapshots.delete(snapshot.id);
await VM.templates.delete(template.id);
// Artifact handles also support snapshot.delete() / template.delete().
```

Workspace managers also support `create({ vm: nameOrId, name })` and
`fork(nameOrId, config, options)`. `vm.snapshot(name)` and
`vm.createTemplate(name, description)` are convenience methods. Scoped managers
only resolve artifacts belonging to that VM. Templates are private. The backend
restores a named snapshot into a new VM using `snapshot` or `fork`; it does not
provide an in-place rollback operation. Omitted creation settings inherit the
seed's settings; explicit `false`, `0` and empty arrays override them.

## Processes, stdin and logs

```ts
const controller = new AbortController();
const command = await vm.exec(["cat"], {
  stdin: "literal text 😀\n",
  cwd: "/workspace",
});
await command.wait({ timeoutMs: 10_000, signal: controller.signal });
console.log(await command.stdout.read(), await command.stderr.read());

const server = await vm.execShell("npm run dev", {
  env: { NODE_ENV: "development" },
});
for await (const line of server.logs) console.log(line);
const processes = await vm.listProcesses();
const reattached = await vm.getProcess(server.pid, {
  containerId: server.containerId,
});
await reattached.kill();

await vm.keepAlive(async () => {
  const job = await vm.exec(["./long-job"]);
  await job.wait();
});
```

Array arguments are passed literally. A string passed to `exec()` runs with
`sh -lc`; `execShell()` makes shell intent explicit. `stdin` accepts text or
bytes uploaded before execution, followed by EOF. Process handles expose
`pid`, `containerId`, `wait`, `status`, `kill`, cached `stdout`/`stderr` streams,
and async `logs`. Reads consume available output; iterate to wait for EOF.
Wait timeouts and aborts end the wait without killing the process.

Handles stay tied to their original boot. Old handles reject operations after
the VM restarts, protecting against PID reuse. Save `{ pid, containerId }` when
reattaching to managed processes. Following logs and waiting for a process hold
an activity lease for their duration. Detached work needs an application-owned
`keepAlive()` scope or idle stopping disabled. The Python-style
`vm.process.exec`, `.execShell`, `.list` and `.get` are also available.

`runCode(code, blocking = true, cwd?, env?)` follows Sandbox's Python execution
convenience method. `metrics()` returns guest CPU, RAM and root disk usage.

```ts
const journal = await vm.logs({ unit: "beam-terminal.service", lines: 200 });
console.log(await journal.read());
const live = await vm.logs({ session: "prompt-abc123", follow: true });
for await (const line of live) console.log(line);
await live.close(); // stop the log-follow process

const foreground = await vm.prompt("add tests", {
  agent: "codex",
  cwd: "/workspace",
});
const session = await vm.prompt("add tests", {
  agent: "claude",
  background: true,
});
```

`logs` accepts one of `pid`, `unit` or `session`. Agent prompts use the installed
Claude/Codex CLIs and durable session logs; configure the agent's credentials
through VM environment variables or workspace secrets. Background prompts run
as systemd units and return `{ session, unit }`.

For headless Codex, provide `CODEX_API_KEY`, or sign in the guest CLI using an
`OPENAI_API_KEY` secret before calling `prompt`:

```javascript
const login = await vm.execShell(
  "printenv OPENAI_API_KEY | codex login --with-api-key",
);
if ((await login.wait()) !== 0) throw new Error(await login.stderr.read());
```

Codex also requires its working directory to be a Git repository. Initialize an
empty workspace with `await (await vm.exec(["git", "init", "/workspace"])).wait()`.
See [Codex authentication](https://learn.chatgpt.com/docs/auth) and
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## Files, images, disks and Docker

The `vm.fs` surface matches Sandbox: `uploadFile`, `downloadFile`, `writeText`,
`writeBytes`, `readText`, `readBytes`, `statFile`, `listFiles`, `createDirectory`,
`deleteDirectory`, `deleteFile`, `remove`, `findInFiles` and `replaceInFiles`.
Each operation resolves the current boot automatically.

```ts
import { Image, Volume } from "@beamcloud/beam-js";

const image = await Image.fromDockerfile("./Dockerfile", ".");
const custom = await VM.create({
  image,
  env: { APP_MODE: "dev" },
  secrets: ["API_KEY"],
  volumes: [new Volume("shared", "/data")],
  disks: [{ name: "cache", size: "10Gi", mountPath: "/cache" }],
  dockerEnabled: true,
});
const prepared = await VM.prepareImage(image, { desktop: true });
const built = await prepared.build(); // standalone VM image build
if (!built.success || !built.imageId) throw new Error("VM image build failed");
const fromId = await VM.create({ image: Image.fromId(built.imageId) });

await custom.docker.version();
await custom.docker.run("hello-world", ["--rm"]);
await custom.docker.compose(["up", "-d"]);
await custom.docker.exec(["ps"]);
```

Registry images and Dockerfiles receive the same VM services as Python. They
require Debian/Ubuntu with apt; desktop images currently require Ubuntu 22.04.
Prebuilt IDs must already contain those services. `Image` supports build steps,
build secrets, registry credentials and Dockerfile contexts as usual. Additional
disks use ext4/qcow; workspace volumes persist independently of the VM. Source
snapshot/template creation inherits its image and root; omit `image` there.

## URLs, protected ports and private access

```ts
const url = await vm.exposePort(3000, { protected: true });
const stable = await vm.getUrl(3000);
const token = await vm.getAccessToken();
const response = await fetch(url, { headers: { "X-Beam-VM-Token": token } });
const browserEntry = await vm.accessUrl(3000, { ttl: 600 });
await vm.rotateAccessToken(); // revoke token and browser sessions
await vm.unexposePort(3000);
await vm.updateNetworkPermissions(false, ["10.0.0.0/8"]);

const forward = await vm.portForward(5432); // private localhost TCP port
console.log(forward.host, forward.port, forward.url);
await forward.close();
const stream = await vm.tunnel(5432); // Node Duplex; authenticated WebSocket
stream.write(Buffer.from("bytes"));
stream.close();

await vm.ssh(["uname", "-a"]); // omit command for an interactive shell
await vm.scp("./file.txt", "vm:/workspace/file.txt");
await vm.scp("vm:/workspace/file.txt", "./download.txt");
const watcher = await vm.sync("./project", { watch: true });
await watcher.close();
```

`ports`/`protectedPorts` publish stable URLs; `privatePorts` and `bind(port)`
allow authenticated TCP access without publishing. Terminal and desktop URLs
are available as `terminalUrl` and `desktopUrl`; `listUrls()` refreshes published
URLs. The browser access URL exchanges a short-lived credential for an HTTP-only
cookie. Network restrictions persist across stop/start.

Tunnels reconnect for up to two minutes and replay acknowledged requests without
duplicating bytes. Port forwarding binds loopback by default; set `localPort`
to choose a port. SSH/SCP require local OpenSSH; sync requires local rsync and
supports `remotePath`, `exclude`, `watch` and `signal`. Generated SSH keys use
the CLI's `~/.beam/ssh/vm_ed25519` identity; private keys stay local. Provide
`sshPublicKey`/`sshKeyPath` for your own key. `VM.get` and `VM.connect` accept
`{ sshKeyPath }` to use it when reattaching. Every local handle can be closed
explicitly or through `vm.close()`.

## Desktop controls

`vm.desktop` supports `screenshot(localPath?)`, `screenSize()`,
`resize(width, height)`, `moveMouse(x, y)`, `click({ x, y, button, count })`,
`scroll({ direction, amount })`, `press(...keys)`, `write(text)`,
`drag({ x, y }, { x, y })` and `launch(argv)`.

```ts
await vm.desktop.press("ctrl+l");
await vm.desktop.write("https://example.com\n");
await vm.desktop.press("Return");
const recording = await vm.desktop.record("/workspace/screen.mp4", { fps: 30 });
await vm.desktop.stopRecording(recording);
await vm.fs.downloadFile("/workspace/screen.mp4", "./screen.mp4");
```

Screenshots return PNG bytes. Text is pasted through the clipboard to preserve
literal UTF-8. Recordings use guest CPU encoding and are finalized with SIGINT.
Resolution supports 320–4096 by 200–2160, and recordings support 1–60 FPS.

## CLI/Python parity map

| CLI / Python capability                            | JavaScript                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| new, get, list, connect, prepare                   | VM.create, VM.get, VM.list, VM.connect, vm.prepare                             |
| image build                                        | VM.prepareImage plus Image.build                                               |
| update, network                                    | vm.update, vm.updateNetworkPermissions                                         |
| start/resume, pause, stop, rm                      | vm.start/resume, vm.pause, vm.stop, vm.remove                                  |
| exec, ps, kill, process reattachment, stdin        | vm.exec, vm.listProcesses, vm.getProcess, process.kill                         |
| files and code execution                           | vm.fs, vm.runCode                                                              |
| Docker                                             | vm.docker                                                                      |
| snapshot create/list/rm, fork from snapshot        | vm.snapshots and VM.snapshots; artifact.fork                                   |
| template create/list/show/rm, create from template | vm.templates and VM.templates; VM.create({ template })                         |
| fork current VM                                    | vm.fork                                                                        |
| ports/expose/unexpose, access tokens and sessions  | vm.listUrls/exposePort/unexposePort/getAccessToken/rotateAccessToken/accessUrl |
| terminal and desktop links                         | vm.terminalUrl, vm.desktopUrl                                                  |
| tunnel/port-forward, SSH/SCP                       | vm.tunnel/portForward, vm.ssh/scp                                              |
| sync/watch                                         | vm.sync                                                                        |
| prompt and unit/session/process logs               | vm.prompt, vm.logs                                                             |
| metrics, activity/keep_alive                       | vm.metrics, vm.touch, vm.keepAlive                                             |
| desktop screenshot/input/resize/launch/record      | vm.desktop                                                                     |

`VMError` retains management HTTP `status` and the underlying `cause`. Only
the backend's transient lifecycle-lock conflict is automatically retried;
other conflicts, such as a duplicate name, remain visible to the caller.
