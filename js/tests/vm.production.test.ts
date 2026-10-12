import { randomUUID } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import type { VM as VMType, VMArtifact, VMProcess } from "../lib";

// BEAM_VM_PACKAGE selects the registry installation whose shipped artifact is tested.
const published = process.env.BEAM_VM_PACKAGE;
const run =
  process.env.BEAM_VM_PRODUCTION_E2E === "1" ? describe : describe.skip;
run("Published VM production feature coverage", () => {
  jest.setTimeout(900_000);
  const sdk = published ? require(published) : {};
  const { VM, Image, Volume, beamOpts } = sdk;
  const tag = randomUUID().slice(0, 8);
  let vm: VMType;
  let local: string;
  const children: VMType[] = [];
  const artifacts: VMArtifact[] = [];
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function eventually(check: () => Promise<void>, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    do {
      try {
        await check();
        return;
      } catch (error) {
        last = error;
      }
      await sleep(500);
    } while (Date.now() < deadline);
    throw last;
  }
  async function output(command: VMProcess, timeoutMs = 30_000) {
    const code = await command.wait({ timeoutMs });
    const stdout = await command.stdout.read();
    const stderr = await command.stderr.read();
    if (code !== 0) throw new Error(`Guest exit ${code}: ${stderr || stdout}`);
    return stdout;
  }
  function fixture(
    kind: "secret" | "disk" | "volume",
    action: "create" | "delete",
    name: string,
  ) {
    // Auxiliary resource fixtures use the Python SDK's management service.
    // Guest operations under test still use only the published JavaScript SDK.
    execFileSync(
      process.env.BEAM_VM_FIXTURE_PYTHON || "python3",
      [
        "-c",
        `import os
from beta9.channel import ServiceClient, rpc_timeout
from beta9.config import ConfigContext
from beta9.clients.secret import CreateSecretRequest, DeleteSecretRequest
from beta9.clients.disk import DeleteDiskRequest
from beta9.clients.volume import DeleteVolumeRequest
c=ConfigContext(token=os.environ['BEAM_TOKEN'],gateway_host='gateway.beam.cloud',gateway_port=443,api_url='https://app.beam.cloud')
s=ServiceClient(c)
kind,action,name=os.environ['BEAM_TEST_KIND'],os.environ['BEAM_TEST_ACTION'],os.environ['BEAM_TEST_NAME']
requests={('secret','create'):CreateSecretRequest,('secret','delete'):DeleteSecretRequest,('disk','delete'):DeleteDiskRequest,('volume','delete'):DeleteVolumeRequest}
request=requests[(kind,action)](name=name, **({'value':'non-sensitive-fixture'} if action=='create' else {}))
with rpc_timeout(30):
 result=getattr(getattr(s,kind),action+'_'+kind)(request)
 assert result.ok, result.err_msg
s.close()
`,
      ],
      {
        env: {
          ...process.env,
          BEAM_TEST_KIND: kind,
          BEAM_TEST_ACTION: action,
          BEAM_TEST_NAME: name,
        },
        timeout: 45_000,
      },
    );
  }

  beforeAll(async () => {
    if (!published || !process.env.BEAM_TOKEN)
      throw new Error("BEAM_VM_PACKAGE and BEAM_TOKEN are required");
    expect(require(`${published}/package.json`).version).toBe(
      process.env.BEAM_VM_EXPECT_VERSION || "1.1.3",
    );
    Object.assign(beamOpts, {
      token: process.env.BEAM_TOKEN,
      workspaceId: "",
      gatewayUrl: "https://app.beam.cloud",
      timeout: 60_000,
    });
    local = await mkdtemp(join(tmpdir(), "beam-vm-production-"));
    vm = new VM({
      name: `js-check-${tag}`,
      cpu: "1000m",
      memory: "2Gi",
      diskSize: "1Gi",
      image: Image.fromId(process.env.BEAM_VM_IMAGE_ID || "2c83656c4669b293"),
      desktop: true,
      dockerEnabled: true,
      protectedPorts: [7681, 8080],
      privatePorts: [8946],
      env: { VM_TEST_MAP_KEY: `literal 😀 ${tag}` },
      metadata: { production_test: tag },
      idleTimeout: 0,
      autoResume: true,
    });
    await vm.prepare();
    await vm.create({ wait: false });
    await vm.wait({ services: true });
    console.log("Published production fixture", vm.name);
  });
  beforeEach(async () => {
    console.log("Production feature:", expect.getState().currentTestName);
    if (vm?.id) await vm.start();
  });
  afterAll(async () => {
    const failures: string[] = [];
    for (const child of children)
      await child.remove().catch((error) => {
        if (error.status !== 404) failures.push(String(error.message));
      });
    for (const artifact of artifacts)
      await artifact.delete().catch((error) => {
        if (error.status !== 404) failures.push(String(error.message));
      });
    if (vm)
      await vm.remove().catch((error) => {
        if (error.status !== 404) failures.push(String(error.message));
      });
    // Include automatic stop snapshots from every fixture, including mount VMs.
    const sourceIds = new Set<string>();
    for (const source of [vm, ...children]) {
      try { sourceIds.add(source.id); } catch { /* Creation never returned an ID. */ }
    }
    for (const artifact of [
      ...(await VM.snapshots.list()),
      ...(await VM.templates.list()),
    ]) {
      if (sourceIds.has(artifact.vmId))
        await artifact.delete().catch((error) => {
          if (error.status !== 404) failures.push(String(error.message));
        });
    }
    if (local) await rm(local, { recursive: true, force: true });
    if (vm?.id) {
      expect(
        (await VM.list({ metadata: { production_test: tag } })).length,
      ).toBe(0);
      expect((await VM.snapshots.list({ vmId: vm.id })).length).toBe(0);
      expect((await VM.templates.list({ vmId: vm.id })).length).toBe(0);
    }
    expect(failures).toEqual([]);
  });

  test("prepare, idempotent create, factories, filters, configuration, metadata and both module formats", async () => {
    const id = vm.id;
    await vm.create();
    expect(vm.id).toBe(id);
    expect((await VM.get(vm.name)).id).toBe(id);
    expect((await VM.connect(id)).id).toBe(id);
    expect(
      (
        await VM.list({
          all: true,
          metadata: { production_test: tag },
          status: "running",
        })
      ).some((item: VMType) => item.id === id),
    ).toBe(true);
    expect(vm.spec.cpu).toBe(1);
    expect(vm.spec.memory).toBe(2048);
    expect(vm.metadata.production_test).toBe(tag);
    expect(await output(await vm.exec(["printenv", "VM_TEST_MAP_KEY"]))).toBe(
      `literal 😀 ${tag}\n`,
    );
    await vm.refresh();
    await vm.updateTtl(180);
    expect(vm.spec.idleTimeout).toBe(180);
    await vm.update({
      ttl: 0,
      metadata: { production_test: tag, literal_map_key: "kept" },
    });
    expect(vm.metadata.literal_map_key).toBe("kept");
    const esm = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {beamOpts,VM} from ${JSON.stringify(`${published}/dist/index.mjs`)}; beamOpts.token=process.env.BEAM_TOKEN; const vm=await VM.get(${JSON.stringify(id)}); const p=await vm.exec(['printf','esm-production-ok']); if(await p.wait()!==0)process.exit(1); console.log(await p.stdout.read()); await vm.close();`,
      ],
      { timeout: 60_000, encoding: "utf8" },
    );
    expect(esm).toContain("esm-production-ok");
    await expect(VM.get(`absent-${tag}`)).rejects.toMatchObject({
      status: 404,
    });
    const duplicate = new VM({ ...vm.config, requestId: randomUUID() });
    await expect(duplicate.create()).rejects.toMatchObject({ status: 409 });
  });

  test("all filesystem methods, byte fidelity, modes, upload/download and empty files", async () => {
    const dir = "/workspace/fs-check";
    await vm.fs.createDirectory(dir);
    await vm.fs.writeText(`${dir}/text.txt`, "hello 😀\n");
    await vm.fs.writeText(`${dir}/empty.txt`, "");
    expect(await vm.fs.readText(`${dir}/empty.txt`)).toBe("");
    await vm.fs.writeBytes(
      `${dir}/bytes.bin`,
      Buffer.from([0, 255, 1, 127]),
      0o600,
    );
    expect(await vm.fs.readBytes(`${dir}/bytes.bin`)).toEqual(
      Buffer.from([0, 255, 1, 127]),
    );
    expect(
      await output(await vm.exec(["stat", "-c", "%a", `${dir}/bytes.bin`])),
    ).toBe("600\n");
    const upload = join(local, "upload.bin"),
      download = join(local, "download.bin");
    await writeFile(upload, Buffer.from([7, 0, 255]));
    await vm.fs.uploadFile(upload, `${dir}/uploaded.bin`);
    await vm.fs.downloadFile(`${dir}/uploaded.bin`, download);
    expect(await readFile(download)).toEqual(Buffer.from([7, 0, 255]));
    expect((await vm.fs.statFile(`${dir}/text.txt`)).isDir).toBe(false);
    expect((await vm.fs.listFiles(dir)).map((item) => item.name)).toContain(
      "text.txt",
    );
    await vm.fs.replaceInFiles(dir, "hello", "goodbye");
    expect(await vm.fs.readText(`${dir}/text.txt`)).toBe("goodbye 😀\n");
    expect((await vm.fs.findInFiles(dir, "goodbye")).length).toBeGreaterThan(0);
    await vm.fs.deleteFile(`${dir}/empty.txt`);
    await vm.fs.remove(`${dir}/bytes.bin`);
    await vm.fs.deleteDirectory(dir);
    expect(
      (await vm.fs.listFiles("/workspace")).some(
        (item) => item.name === "fs-check",
      ),
    ).toBe(false);
  });

  test("process manager, literal stdin, shell/env/cwd, runCode, timeout, abort, reattachment and PID logs", async () => {
    expect(
      await output(
        await vm.process.exec(["cat"], { stdin: Buffer.from("bytes 😀\n") }),
      ),
    ).toBe("bytes 😀\n");
    expect(
      await output(
        await vm.process.execShell('printf \'%s:%s\' "$VM_EXEC" "$PWD"', {
          cwd: "/tmp",
          env: { VM_EXEC: "literal" },
        }),
      ),
    ).toBe("literal:/tmp");
    const code = await vm.runCode("print('python-ok')");
    expect("exitCode" in code && code.exitCode).toBe(0);
    expect("stdout" in code && code.stdout).toBe("python-ok\n");
    expect(
      await output((await vm.runCode("print('async-ok')", false)) as VMProcess),
    ).toBe("async-ok\n");
    const job = await vm.exec(["sleep", "300"]);
    try {
      await expect(job.wait({ timeoutMs: 250 })).rejects.toThrow(/timeout/i);
      expect((await job.status())[0]).toBe(-1);
      const controller = new AbortController();
      const waiting = job.wait({ signal: controller.signal });
      setTimeout(() => controller.abort(new Error("test-abort")), 250);
      await expect(waiting).rejects.toThrow(/test-abort|cancel|abort/i);
      expect((await job.status())[0]).toBe(-1);
      expect(
        (await vm.process.list()).some((item) => item.pid === job.pid),
      ).toBe(true);
      expect(vm.localProcesses().some((item) => item.pid === job.pid)).toBe(
        true,
      );
      expect(
        (await vm.process.get(job.pid, { containerId: job.containerId })).pid,
      ).toBe(job.pid);
      await (await vm.process.getProcess(job.pid)).kill();
    } finally {
      await job.kill().catch(() => {});
    }
    const logged = await vm.exec([
      "sh",
      "-c",
      "echo pid-log; sleep 0.2; echo error-log >&2",
    ]);
    const logs = await vm.logs({ pid: logged.pid });
    expect(await logs.read()).toMatch(/pid-log|error-log/);
    await logged.wait();
    const failed = await vm.exec([
      "sh",
      "-c",
      "echo deliberate-failure >&2; exit 42",
    ]);
    expect(await failed.wait()).toBe(42);
    expect(await failed.stderr.read()).toContain("deliberate-failure");
  });

  test("protected HTTP, browser cookies, token rotation, URL helpers and network restrictions", async () => {
    await vm.fs.writeText("/workspace/http-check.txt", tag);
    const server = await vm.exec([
      "python3",
      "-u",
      "-m",
      "http.server",
      "8945",
      "--bind",
      "0.0.0.0",
      "--directory",
      "/workspace",
    ]);
    try {
      const url = await vm.expose(8945, { protected: true });
      expect((await fetch(url)).status).toBe(403);
      expect((await vm.listUrls())[8945]).toBe(url);
      expect(vm.terminalUrl).toMatch(/^https:/);
      expect(vm.desktop.url).toBe(vm.desktopUrl);
      const token = await vm.getAccessToken();
      const page = new URL("http-check.txt", url);
      await eventually(async () =>
        expect(
          await (
            await fetch(page, { headers: { "X-Beam-VM-Token": token } })
          ).text(),
        ).toBe(tag),
      );
      const entry = await vm.accessUrl(8945, { ttl: 60 });
      const exchange = await fetch(entry, { redirect: "manual" });
      expect([302, 303, 307]).toContain(exchange.status);
      const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
      expect(cookie).toBeTruthy();
      expect(
        await (await fetch(page, { headers: { Cookie: cookie! } })).text(),
      ).toBe(tag);
      await vm.rotateAccessToken();
      expect((await fetch(page, { headers: { Cookie: cookie! } })).status).toBe(
        403,
      );
      expect(
        (await fetch(page, { headers: { "X-Beam-VM-Token": token } })).status,
      ).toBe(403);
      const outbound = () =>
        vm.exec([
          "python3",
          "-c",
          "import socket; socket.create_connection(('1.1.1.1',443),timeout=3).close()",
        ]);
      await output(await outbound());
      await vm.updateNetworkPermissions(true);
      expect(vm.spec.blockNetwork).toBe(true);
      expect(await (await outbound()).wait({ timeoutMs: 10_000 })).not.toBe(0);
      await vm.updateNetworkPermissions(false, ["10.0.0.0/8"]);
      expect(vm.spec.allowList).toEqual(["10.0.0.0/8"]);
      expect(await (await outbound()).wait({ timeoutMs: 10_000 })).not.toBe(0);
    } finally {
      await vm.updateNetworkPermissions(false, []);
      await vm.unexpose(8945);
      await server.kill();
    }
  });

  test("private byte streams reconnect without duplicate output; forwarding abort and local close", async () => {
    await vm.fs.writeText(
      "/workspace/echo.py",
      "import socket,threading\ns=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('0.0.0.0',8946));s.listen()\ndef echo(c):\n while True:\n  d=c.recv(65536)\n  if not d:break\n  c.sendall(d)\n c.close()\nwhile True:\n c,_=s.accept();threading.Thread(target=echo,args=(c,),daemon=True).start()\n",
    );
    const server = await vm.exec(["python3", "-u", "/workspace/echo.py"]);
    let tunnel: any;
    try {
      await vm.bind(8946);
      tunnel = await vm.tunnel(8946);
      const data: Buffer[] = [];
      tunnel.on("data", (chunk: Buffer) => data.push(chunk));
      tunnel.on("error", () => {});
      const first = Buffer.from(`first 😀 ${tag}`),
        second = Buffer.alloc(8192, 123);
      await new Promise<void>((resolve, reject) =>
        tunnel.write(first, (error: Error) =>
          error ? reject(error) : resolve(),
        ),
      );
      await eventually(async () => expect(Buffer.concat(data)).toEqual(first));
      // Simulate a real transport loss while retaining the guest TCP session.
      tunnel.socket.terminate();
      await new Promise<void>((resolve, reject) =>
        tunnel.write(second, (error: Error) =>
          error ? reject(error) : resolve(),
        ),
      );
      await eventually(async () =>
        expect(Buffer.concat(data)).toEqual(Buffer.concat([first, second])),
      );
      tunnel.close();
      const controller = new AbortController();
      const forward = await vm.portForward(8946, { signal: controller.signal });
      expect(forward.host).toBe("127.0.0.1");
      controller.abort();
      await forward.close();
      await vm.close();
      expect((await VM.get(vm.id)).info.desiredState).toBe("running");
    } finally {
      tunnel?.close();
      await server.kill();
    }
  });

  test("SSH commands, recursive SCP, custom identity reattachment and rsync watch", async () => {
    expect(await vm.ssh(["sh", "-c", "test -d /workspace"])).toBe(0);
    const tree = join(local, "sync");
    await (await import("fs/promises")).mkdir(tree);
    await writeFile(join(tree, "watched.txt"), "before");
    await vm.scp(tree, "vm:/workspace/scp-tree", { recursive: true });
    expect(await vm.fs.readText("/workspace/scp-tree/watched.txt")).toBe(
      "before",
    );
    await vm.fs.createDirectory("/workspace/watched");
    const watcher = await vm.sync(tree, {
      remotePath: "/workspace/watched",
      watch: true,
      exclude: ["ignored.txt"],
    });
    try {
      await writeFile(join(tree, "watched.txt"), "after");
      await eventually(async () =>
        expect(await vm.fs.readText("/workspace/watched/watched.txt")).toBe(
          "after",
        ),
      );
    } finally {
      await watcher.close();
      await watcher.done;
    }
    const attached = await VM.get(vm.id, {
      sshKeyPath: join((await import("os")).homedir(), ".beam/ssh/vm_ed25519"),
    });
    expect(await attached.ssh(["true"])).toBe(0);
    await attached.close();
  });

  test("Docker build/run and both Compose entry points execute real containers", async () => {
    await vm.docker.ensureReady();
    await output(await vm.docker.version());
    expect(
      await output(await vm.docker.run("hello-world", ["--rm"]), 180_000),
    ).toContain("Hello from Docker!");
    await vm.fs.createDirectory("/workspace/docker-check");
    await vm.fs.writeText(
      "/workspace/docker-check/Dockerfile",
      `FROM hello-world\nLABEL beam.production-test=${tag}\n`,
    );
    const image = `beam-check-${tag}`;
    await output(
      await vm.docker.exec(["build", "-t", image, "/workspace/docker-check"]),
      180_000,
    );
    await vm.fs.writeText(
      "/workspace/docker-check/compose.yml",
      `services:\n  probe:\n    image: ${image}\n    network_mode: host\n    pid: host\n`,
    );
    expect(
      await output(
        await vm.docker.compose([
          "-f",
          "/workspace/docker-check/compose.yml",
          "run",
          "--rm",
          "probe",
        ]),
        180_000,
      ),
    ).toContain("Hello from Docker!");
    expect(
      await output(
        await vm.docker.composeStandalone([
          "-f",
          "/workspace/docker-check/compose.yml",
          "config",
          "--services",
        ]),
      ),
    ).toBe("probe\n");
  });

  test("desktop launch, clipboard UTF-8, mouse drag, local PNG and valid MP4", async () => {
    const terminal = await vm.desktop.launch(["xterm", "-title", "beam-test"]);
    try {
      const text = "literal 😀 quotes '$()\nsecond line";
      await vm.desktop.write(text);
      expect(
        await output(
          await vm.exec(["xclip", "-selection", "clipboard", "-out"]),
        ),
      ).toBe(text);
      await vm.desktop.drag({ x: 30, y: 30 }, { x: 100, y: 100 });
      const imagePath = join(local, "desktop.png");
      const image = await vm.desktop.screenshot(imagePath);
      expect(await readFile(imagePath)).toEqual(image);
      const recording = await vm.desktop.record(
        "/workspace/extended-recording.mp4",
        { fps: 5 },
      );
      await sleep(1500);
      await vm.desktop.stopRecording(recording);
      const video = JSON.parse(
        await output(
          await vm.exec([
            "ffprobe",
            "-v",
            "error",
            "-show_streams",
            "-of",
            "json",
            "/workspace/extended-recording.mp4",
          ]),
        ),
      );
      expect(video.streams[0].codec_name).toBe("h264");
    } finally {
      await terminal.kill();
    }
  });

  test("installed Claude/Codex, foreground and background prompts and session/unit/follow logs", async () => {
    expect(await output(await vm.exec(["claude", "--version"]))).toMatch(
      /Claude Code/,
    );
    expect(await output(await vm.exec(["codex", "--version"]))).toMatch(
      /codex/,
    );
    const foreground = await vm.prompt("Reply with beam-production-check", {
      agent: "claude",
      env: { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" },
    });
    const code = await foreground.wait({ timeoutMs: 60_000 });
    const response =
      (await foreground.stdout.read()) + (await foreground.stderr.read());
    expect(code).not.toBe(0);
    expect(response).toMatch(/login|api.key|auth|credentials/i);
    const session = await vm.prompt("Reply with beam-production-check", {
      agent: "claude",
      background: true,
      env: { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" },
    });
    await eventually(async () => {
      const logs = await vm.logs({ session: session.session });
      expect(await logs.read()).toMatch(/login|api.key|auth|credentials/i);
    });
    const unit = await vm.logs({ unit: session.unit, lines: 20 });
    expect(await unit.read()).toMatch(/claude|prompt|status|exit/i);
    const follow = await vm.logs({ session: session.session, follow: true });
    await follow.close();
    console.log(
      "Prompt transport verified; successful provider inference requires separate agent credentials.",
    );
  });

  test("workspace/scoped artifact CRUD, all fork paths, isolation and artifacts after source deletion", async () => {
    await vm.fs.writeText("/workspace/artifact-marker", tag);
    const snapshot = await vm.snapshot(`extra-snap-${tag}`);
    const template = await vm.createTemplate(
      `extra-tpl-${tag}`,
      "Production coverage",
    );
    const global = await VM.snapshots.create({
      vm: vm.name,
      name: `global-snap-${tag}`,
    });
    artifacts.push(snapshot, template, global);
    expect((await VM.templates.get(template.name)).info.description).toBe(
      "Production coverage",
    );
    expect(
      (await vm.templates.list()).some((item) => item.id === template.id),
    ).toBe(true);
    expect((await vm.snapshots.get(snapshot.name)).id).toBe(snapshot.id);
    const child = await VM.snapshots.fork(
      snapshot.name,
      {
        name: `js-extra-${tag}`,
        ssh: false,
        desktop: false,
        dockerEnabled: false,
        memory: 512,
        ports: [],
        protectedPorts: [],
      },
      { wait: false },
    );
    children.push(child);
    await child.wait();
    expect(await child.fs.readText("/workspace/artifact-marker")).toBe(tag);
    await expect(child.snapshots.get(snapshot.id)).rejects.toMatchObject({
      status: 404,
    });
    await child.fs.writeText("/workspace/artifact-marker", "child");
    expect(await vm.fs.readText("/workspace/artifact-marker")).toBe(tag);
    const retained = await child.snapshot(`retained-${tag}`);
    artifacts.push(retained);
    await child.delete();
    expect((await VM.snapshots.get(retained.id)).id).toBe(retained.id);
    const current = await vm.fork(`js-copy-${tag}`);
    children.push(current);
    expect(await current.fs.readText("/workspace/artifact-marker")).toBe(tag);
    await current.remove();
    await vm.snapshots.remove(global.name);
    await snapshot.remove();
    await VM.templates.remove(template.name);
    await VM.snapshots.delete(retained.id);
  });

  test("automatic resume, cold boot, read-only lookup and stale runtime safety", async () => {
    await vm.update({ idleTimeout: 0, autoResume: true });
    const stale = await vm.exec(["sleep", "300"]);
    const oldRuntime = stale.containerId;
    await vm.pause();
    expect((await VM.get(vm.id)).status).toBe("paused");
    expect(await output(await vm.exec(["printf", "auto-resumed"]))).toBe(
      "auto-resumed",
    );
    await expect(stale.status()).rejects.toThrow(/previous VM runtime/);
    const restored = await vm.getProcess(stale.pid);
    expect((await restored.status())[0]).toBe(-1);
    await restored.kill();
    const beforeCold = await vm.exec(["sleep", "300"]);
    await vm.pause();
    await vm.start({ cold: true });
    await expect(beforeCold.status()).rejects.toThrow(
      /previous|changed|runtime|stopped/i,
    );
    await expect(
      vm.getProcess(stale.pid, { containerId: oldRuntime }),
    ).rejects.toThrow(/previous VM runtime/);
    await vm.update({ autoResume: false });
    await vm.stop({ noSnapshot: true });
    expect((await VM.get(vm.id)).status).toBe("stopped");
    await expect(vm.exec(["true"])).rejects.toThrow(/start|auto|stopped/i);
    await VM.connect(vm.id);
    expect(await vm.fs.readText("/workspace/artifact-marker")).toBe(tag);
    await vm.update({ autoResume: true });
  });

  test("idle stop/pause, touch and renewed/released activity leases", async () => {
    await vm.update({ idleTimeout: 3, idleAction: "pause", autoResume: true });
    await vm.touch();
    await vm.keepAlive(async () => {
      await sleep(8000);
      expect((await VM.get(vm.id)).info.desiredState).toBe("running");
    });
    await eventually(
      async () => expect((await VM.get(vm.id)).status).toBe("paused"),
      90_000,
    );
    expect(await output(await vm.exec(["printf", "wake-after-idle"]))).toBe(
      "wake-after-idle",
    );
    await vm.update({ idleTimeout: 3, idleAction: "stop" });
    await eventually(
      async () => expect((await VM.get(vm.id)).status).toBe("stopped"),
      90_000,
    );
    await vm.start();
    await vm.update({ idleTimeout: 0 });
  });

  test("published guest image payload, Dockerfile build context, env/secrets and persistent disk/volume mounts", async () => {
    const secret = `JS_PRODUCTION_${tag.toUpperCase()}`;
    const disk = `js-disk-${tag}`,
      volumeName = `js-vol-${tag}`;
    let mounted: VMType | undefined;
    let volumeCreated = false;
    await vm.stop({ noSnapshot: true });
    fixture("secret", "create", secret);
    try {
      const context =
        process.env.BEAM_VM_BUILD_CONTEXT || join(local, "image-context");
      await (await import("fs/promises")).mkdir(context, { recursive: true });
      try {
        await readFile(join(context, "marker.txt"));
      } catch {
        await writeFile(join(context, "marker.txt"), "published-image-build");
      }
      try {
        await readFile(join(context, "Dockerfile"));
      } catch {
        await writeFile(
          join(context, "Dockerfile"),
          "FROM ubuntu:22.04\nCOPY marker.txt /image-marker.txt\n",
        );
      }
      const source = await Image.fromDockerfile(
        join(context, "Dockerfile"),
        context,
      );
      const prepared = await VM.prepareImage(source);
      const built = await prepared.build();
      expect(built.success).toBe(true);
      expect(built.imageId).toBeTruthy();
      const volume = new Volume(volumeName, "/shared-test");
      expect(await volume.getOrCreate()).toBe(true);
      volumeCreated = true;
      mounted = new VM({
        name: `js-mount-${tag}`,
        image: Image.fromId(built.imageId),
        cpu: 1,
        memory: 512,
        diskSize: "1Gi",
        ssh: false,
        env: { FROM_CONFIG: "runtime-env" },
        secrets: [secret, "ANTHROPIC_API_KEY"],
        disks: [{ name: disk, size: "1Gi", mountPath: "/disk-test" }],
        volumes: [volume],
        idleTimeout: 0,
        metadata: { production_test: tag },
      });
      children.push(mounted);
      await mounted.create();
      expect(await mounted.fs.readText("/image-marker.txt")).toBe(
        "published-image-build",
      );
      expect(
        await output(await mounted.exec(["printenv", "FROM_CONFIG"])),
      ).toBe("runtime-env\n");
      expect(await output(await mounted.exec(["printenv", secret]))).toBe(
        "non-sensitive-fixture\n",
      );
      await mounted.fs.writeText("/disk-test/persisted", "disk-data");
      await mounted.fs.writeText("/shared-test/persisted", "volume-data");
      await mounted.stop();
      await mounted.start({ services: true });
      expect(await mounted.fs.readText("/disk-test/persisted")).toBe(
        "disk-data",
      );
      expect(await mounted.fs.readText("/shared-test/persisted")).toBe(
        "volume-data",
      );
      expect(
        await output(
          await mounted.exec([
            "systemctl",
            "is-active",
            "beam-terminal.service",
          ]),
        ),
      ).toBe("active\n");
      expect(
        await output(
          await mounted.prompt(
            "Reply with exactly beam-real-claude and nothing else.",
            { agent: "claude" },
          ),
          120_000,
        ),
      ).toContain("beam-real-claude");
      console.log(
        "Custom image, mounts, secrets and real Claude response verified.",
      );
    } finally {
      if (mounted) await mounted.remove();
      fixture("secret", "delete", secret);
      if (mounted) fixture("disk", "delete", disk);
      if (volumeCreated) {
        fixture("volume", "delete", volumeName);
      }
    }
  });

  test("successful Codex background inference and completed service logs", async () => {
    await vm.stop({ noSnapshot: true });
    const secret = process.env.BEAM_VM_CODEX_SECRET || "OPENAI_API_KEY";
    const codexVM: VMType = new VM({
      name: `js-codex-${tag}`,
      image: Image.fromId(process.env.BEAM_VM_IMAGE_ID || "2c83656c4669b293"),
      cpu: 1,
      memory: 512,
      diskSize: "1Gi",
      ssh: false,
      desktop: false,
      dockerEnabled: false,
      secrets: [secret],
      protectedPorts: [7681],
      idleTimeout: 0,
      metadata: { production_test: tag },
    });
    children.push(codexVM);
    try {
      await codexVM.create();
      await output(await codexVM.exec(["git", "init", "/workspace"]));
      await output(
        await codexVM.exec([
          "sh",
          "-c",
          'printenv -- "$1" | codex login --with-api-key',
          "beam-auth",
          secret,
        ]),
      );
      const codex = await codexVM.prompt(
        "Reply with exactly beam-real-codex and nothing else.",
        { agent: "codex", background: true },
      );
      await eventually(async () => {
        const logs = await codexVM.logs({ session: codex.session });
        // The CLI echoes the user prompt too; require its assistant response.
        expect(await logs.read()).toMatch(/\ncodex\nbeam-real-codex/);
      }, 120_000);
      await eventually(async () => {
        const logs = await codexVM.logs({ unit: codex.unit, lines: 100 });
        const text = await logs.read();
        expect(text).toMatch(/Deactivated successfully/);
        expect(text).not.toMatch(/status=[1-9][0-9]*\/FAILURE/);
      });
    } finally {
      await codexVM.remove();
    }
  });
});
