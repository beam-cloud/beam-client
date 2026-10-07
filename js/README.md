# Beam TypeScript/JavaScript SDK

The official TypeScript and JavaScript SDK for Beam.

## Install

```bash
npm install @beamcloud/beam-js
```

```bash
yarn add @beamcloud/beam-js
```

## Configure

Set your Beam token and workspace ID before making SDK calls.

```typescript
import { beamOpts } from "@beamcloud/beam-js";

beamOpts.token = process.env.BEAM_TOKEN!;
beamOpts.workspaceId = process.env.BEAM_WORKSPACE_ID!;
```

The SDK targets Beam Cloud by default.

## Sandbox Quickstart

Create a sandbox, run code, stream logs, and terminate it cleanly.

```typescript
import { beamOpts, Image, Sandbox } from "@beamcloud/beam-js";

beamOpts.token = process.env.BEAM_TOKEN!;
beamOpts.workspaceId = process.env.BEAM_WORKSPACE_ID!;

async function main() {
  const sandbox = new Sandbox({
    name: "examples",
    image: new Image({ pythonPackages: ["requests"] }),
    cpu: 1,
    memory: 1024,
    keepWarmSeconds: 300,
  });

  const sb = await sandbox.create();

  const result = await sb.runCode(`
import requests
print(requests.get("https://api.github.com").status_code)
`);
  console.log(result);

  const process = await sb.exec(["python3", "-c", "print('hello from Beam')"]);
  for await (const line of process.logs) {
    console.log(line.trimEnd());
  }

  await sb.terminate();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`name` is the Beam app name used to group sandboxes. Each running sandbox still gets its own generated sandbox ID.

## Expose a Port

```typescript
const server = await sb.execShell("python3 -m http.server 8888 --bind 0.0.0.0");
const url = await sb.exposePort(8888);
console.log(url);

await server.kill();
```

## Filesystem

```typescript
await sb.fs.writeText("/tmp/hello.txt", "hello");
console.log(await sb.fs.readText("/tmp/hello.txt"));

await sb.fs.mkdir("/tmp/data");
await sb.fs.uploadFile("./local.txt", "/tmp/data/local.txt");
console.log(await sb.fs.list("/tmp/data"));
await sb.fs.remove("/tmp/data/local.txt");
```

## Snapshots

```typescript
const checkpointId = await sb.snapshot();
await sb.terminate();

const restored = await Sandbox.createFromSnapshot(checkpointId);
console.log(restored.sandboxId);
```

## Docker

Install Docker in the image and enable the managed daemon explicitly:

```typescript
const sandbox = new Sandbox({
  name: "docker-actions",
  image: Image.fromRegistry("node:20-slim").withDocker(),
  dockerEnabled: true,
  cpu: 2,
  memory: "2Gi",
  keepWarmSeconds: 300,
});

const sb = await sandbox.create();
try {
  const ready = await sb.exec([
    "timeout", "60", "sh", "-c",
    "until docker info >/dev/null 2>&1; do sleep 1; done",
  ]);
  if (await ready.wait() !== 0) throw new Error("Docker daemon did not become ready");
  const proc = await sb.exec([
    "docker", "run", "--rm", "--network=host", "--pid=host",
    "alpine:3.20", "echo", "hello",
  ], { wait: true });
  if (await proc.wait() !== 0) throw new Error(await proc.stderr.read());
  console.log(await proc.stdout.read());
} finally {
  await sb.terminate();
}
```

`withDocker()` supports Ubuntu and Debian images and installs Docker Engine,
CLI, Buildx, `docker compose`, and the `docker-compose` alias. Other base images
must provide their own Docker installation. No host Docker socket is mounted.

Run Docker commands through `sb.exec` or `sb.execShell`; a separate Python-style
`sb.docker` wrapper is not required. The daemon starts asynchronously: wait for
`docker info` to succeed before issuing builds or running containers.

The managed daemon uses VFS storage and no default bridge under runc/gVisor.
Use `--network=host --pid=host` for inner containers; these share the sandbox's
namespaces, not the worker machine's. For Compose, configure each service with
`network_mode: host` and `pid: host`. Use `docker compose -f /path/compose.yaml up`
and `down` through `exec`; Compose files are not automatically rewritten.
Build with `docker build --network=host -t my-image /path/to/context`; otherwise
Dockerfile `RUN` instructions fail with `network bridge not found`, even when
the instruction does not access the network.

## Volumes and Cloud Buckets

```typescript
import { CloudBucket, Volume } from "@beamcloud/beam-js";

const volume = new Volume("cache", "/mnt/cache");
const bucket = new CloudBucket("my-bucket", "/mnt/bucket", {
  accessKey: "AWS_ACCESS_KEY_ID",
  secretKey: "AWS_SECRET_ACCESS_KEY",
  region: "us-east-1",
});

const sandbox = new Sandbox({
  name: "storage",
  volumes: [volume, bucket],
});
```

## Development

To point the SDK at a local gateway:

```typescript
beamOpts.gatewayUrl = "http://localhost:1993";
```

## Links

- [Beam docs](https://docs.beam.cloud)
- [npm package](https://www.npmjs.com/package/@beamcloud/beam-js)
- [GitHub](https://github.com/beam-cloud/beam-client/tree/master/js)
