import { randomUUID } from "crypto";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { request as httpRequest } from "http";
import type { VM as VMType, VMArtifact } from "../lib";

// Point this at a fresh npm installation to validate the shipped artifact.
const { beamOpts, Image, VM } = process.env.BEAM_VM_PACKAGE
  ? require(process.env.BEAM_VM_PACKAGE)
  : require("../lib");

const runE2E = process.env.BEAM_VM_E2E === "1" ? describe : describe.skip;
runE2E("Persistent VM live parity", () => {
  jest.setTimeout(900_000);
  beforeAll(() => {
    beamOpts.token = process.env.BEAM_TOKEN || "";
    beamOpts.workspaceId = process.env.BEAM_WORKSPACE_ID || "";
    beamOpts.gatewayUrl =
      process.env.BEAM_GATEWAY_URL || "https://app.beam.cloud";
    if (!beamOpts.token) throw new Error("BEAM_TOKEN is required");
  });
  test("exec, files, network, private TCP, SSH, sync, Docker, desktop, snapshots, templates and both sleep modes", async () => {
    const run = randomUUID().slice(0, 8);
    const config = {
      name: `js-vm-${run}`,
      cpu: 1,
      memory: "2Gi",
      diskSize: "1Gi",
      desktop: true,
      dockerEnabled: true,
      idleTimeout: 180,
      autoResume: true,
      metadata: { js_e2e: run },
      ...(process.env.BEAM_VM_IMAGE_ID
        ? { image: Image.fromId(process.env.BEAM_VM_IMAGE_ID) }
        : {}),
    };
    const vm = new VM(config);
    const children: VMType[] = [],
      artifacts: VMArtifact[] = [];
    const temporary = await mkdtemp(join(tmpdir(), "beam-js-vm-"));
    try {
      await vm.create({ services: true });
      console.log("VM live: created", vm.name);
      const process = await vm.exec(["cat"], {
        stdin: "literal 😀 $(no expansion)\n",
        wait: true,
      });
      expect(await process.wait()).toBe(0);
      expect(await process.stdout.read()).toBe("literal 😀 $(no expansion)\n");
      const streamed = await vm.exec([
        "sh",
        "-c",
        "printf 'one\\n'; sleep 0.2; printf 'two\\n' >&2",
      ]);
      const lines: string[] = [];
      for await (const line of streamed.logs) lines.push(line);
      expect(lines.join("")).toContain("two");
      await vm.fs.writeText("/workspace/persistent.txt", run);
      await vm.fs.writeText("/workspace/empty.txt", "");
      expect(await vm.fs.readText("/workspace/empty.txt")).toBe("");
      expect(
        (await VM.list({ metadata: { js_e2e: run } })).map(
          (item: VMType) => item.id,
        ),
      ).toContain(vm.id);
      const metrics = await vm.metrics();
      expect(metrics.cpuCount).toBe(1);
      expect(metrics.memoryTotalBytes).toBeGreaterThan(0);
      const server = await vm.exec([
        "python3",
        "-u",
        "-m",
        "http.server",
        "8765",
        "--bind",
        "0.0.0.0",
        "--directory",
        "/workspace",
      ]);
      const forward = await vm.portForward(8765);
      try {
        const content = await new Promise<string>((resolve, reject) => {
          const req = httpRequest(
            { host: forward.host, port: forward.port, path: "/persistent.txt" },
            (response) => {
              let data = "";
              response.on("data", (chunk) => {
                data += chunk.toString();
              });
              response.on("end", () => resolve(data));
            },
          );
          req.on("error", reject);
          req.end();
        });
        expect(content).toBe(run);
      } finally {
        await forward.close();
      }
      const url = await vm.exposePort(8765, { protected: true });
      expect((await fetch(url)).status).toBe(403);
      const token = await vm.getAccessToken();
      expect(
        await (
          await fetch(new URL("persistent.txt", url), {
            headers: { "X-Beam-VM-Token": token },
          })
        ).text(),
      ).toBe(run);
      expect(await vm.accessUrl(8765, { ttl: 60 })).toMatch(/^https:/);
      await vm.rotateAccessToken();
      expect(
        (await fetch(url, { headers: { "X-Beam-VM-Token": token } })).status,
      ).toBe(403);
      await vm.updateNetworkPermissions(false, []);
      expect(await vm.docker.version().then((process) => process.wait())).toBe(
        0,
      );
      await writeFile(join(temporary, "local.txt"), "local-sync");
      await vm.scp(join(temporary, "local.txt"), "vm:/workspace/copied.txt");
      await vm.scp("vm:/workspace/copied.txt", join(temporary, "download.txt"));
      expect(await readFile(join(temporary, "download.txt"), "utf8")).toBe(
        "local-sync",
      );
      await vm.sync(temporary);
      expect(await vm.fs.readText("/workspace/local.txt")).toBe("local-sync");
      expect((await vm.desktop.screenshot()).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      await vm.desktop.resize(800, 600);
      expect(await vm.desktop.screenSize()).toEqual({
        width: 800,
        height: 600,
      });
      await vm.desktop.moveMouse(10, 10);
      await vm.desktop.click({ x: 10, y: 10 });
      await vm.desktop.scroll();
      await vm.desktop.press("Escape");
      const recording = await vm.desktop.record("/workspace/recording.mp4", {
        fps: 5,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await vm.desktop.stopRecording(recording);
      expect(
        (await vm.fs.statFile("/workspace/recording.mp4")).size,
      ).toBeGreaterThan(0);
      console.log("VM live: runtime, networking, access and desktop verified");
      const snapshot = await vm.snapshots.create(`snap-${run}`);
      artifacts.push(snapshot);
      const template = await vm.templates.create({
        name: `tpl-${run}`,
        description: "JS parity",
      });
      artifacts.push(template);
      expect((await VM.snapshots.get(snapshot.id)).vmId).toBe(vm.id);
      expect((await vm.snapshots.list()).map((item) => item.id)).toContain(
        snapshot.id,
      );
      const child = await snapshot.fork({
        name: `js-fork-${run}`,
        ssh: false,
        desktop: false,
        dockerEnabled: false,
        memory: 512,
      });
      children.push(child);
      expect(await child.fs.readText("/workspace/persistent.txt")).toBe(run);
      await child.fs.writeText("/workspace/persistent.txt", "independent");
      expect(await vm.fs.readText("/workspace/persistent.txt")).toBe(run);
      await child.remove();
      children.splice(children.indexOf(child), 1);
      const templated = await template.fork({
        name: `js-tpl-${run}`,
        ssh: false,
        desktop: false,
        dockerEnabled: false,
        memory: 512,
      });
      children.push(templated);
      expect(await templated.fs.readText("/workspace/persistent.txt")).toBe(
        run,
      );
      await templated.remove();
      children.splice(children.indexOf(templated), 1);
      await server.kill();
      const sleeper = await vm.exec(["sleep", "600"]);
      await vm.pause();
      await vm.resume();
      expect((await (await vm.getProcess(sleeper.pid)).status())[0]).toBe(-1);
      await (await vm.getProcess(sleeper.pid)).kill();
      await vm.stop();
      await vm.start();
      expect(await vm.fs.readText("/workspace/persistent.txt")).toBe(run);
      expect(await vm.getUrl(8765)).toBe(url);
      await vm.unexposePort(8765);
      await vm.update({
        metadata: {},
        idleTimeout: 60,
        idleAction: "pause",
        autoResume: false,
      });
      expect(vm.info.metadata || {}).toEqual({});
      const logs = await vm.logs({ unit: "beam-terminal.service", lines: 5 });
      await logs.read();
      console.log("VM live: persistence, artifacts and sleep modes verified");
    } finally {
      for (const child of children) await child.remove();
      for (const artifact of artifacts) await artifact.delete();
      // stop() creates a visible snapshot that survives source deletion.
      const sourceIds = new Set<string>();
      for (const source of [vm, ...children]) {
        try { sourceIds.add(source.id); } catch { /* Creation never returned an ID. */ }
      }
      for (const artifact of [
        ...(await VM.snapshots.list()),
        ...(await VM.templates.list()),
      ]) {
        if (sourceIds.has(artifact.vmId)) await artifact.delete();
      }
      try {
        await vm.remove();
      } catch (error: any) {
        if (error.status !== 404) throw error;
      }
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
