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

Docker-enabled Beam sandboxes can run Docker commands through `execShell`.

```typescript
const proc = await sb.execShell("docker run --rm alpine:3.20 echo hello");
await proc.wait();
console.log(await proc.stdout.read());
```

For Docker Compose, write or upload a compose file and run `docker compose`.

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
