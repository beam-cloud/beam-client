import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { beamOpts, VM } from "@beamcloud/beam-js";

// Run from a project with @beamcloud/beam-js installed: node vm-agent-workspace.mjs
if (!process.env.BEAM_TOKEN) throw new Error("Set BEAM_TOKEN before running");
beamOpts.token = process.env.BEAM_TOKEN;
const name = `js-agent-${randomUUID().slice(0, 8)}`;
let vm, branch, snapshot;
const connections = [];

async function timed(label, work) {
  const start = performance.now();
  const result = await work();
  console.log(`${label}: ${((performance.now() - start) / 1000).toFixed(2)}s`);
  return result;
}

try {
  vm = await timed("Create and wait for commands", () => VM.create({
    name,
    cpu: 1,
    memory: "2Gi",
    protectedPorts: [7681],
    idleTimeout: 300,
    idleAction: "pause",
    autoResume: true,
    metadata: { example: "vm-agent-workspace" },
  }));
  console.log("VM:", vm.id, "Terminal:", vm.terminalUrl);

  const command = await vm.exec(["node", "--version"]);
  assert.equal(await command.wait(), 0);
  console.log((await command.stdout.read()).trim());
  await vm.fs.writeText("/workspace/result.txt", "original workspace\n");

  snapshot = await timed("Snapshot root", () => vm.snapshots.create("checkpoint"));
  branch = await timed("Fork and wait for commands", () => snapshot.fork({ cpu: 1, memory: "512Mi" }));
  assert.equal(await branch.fs.readText("/workspace/result.txt"), "original workspace\n");
  await branch.fs.writeText("/workspace/result.txt", "isolated experiment\n");
  assert.equal(await vm.fs.readText("/workspace/result.txt"), "original workspace\n");

  await vm.pause();
  const sleeping = await VM.get(vm.id); // A lookup does not wake the VM.
  connections.push(sleeping);
  assert.equal(sleeping.status, "paused");
  const resumed = await timed("Reconnect and resume", () => VM.connect(vm.id));
  connections.push(resumed);
  assert.equal(await resumed.fs.readText("/workspace/result.txt"), "original workspace\n");

  await resumed.stop({ noSnapshot: true });
  await timed("Start from durable root", () => resumed.start());
  assert.equal(await resumed.fs.readText("/workspace/result.txt"), "original workspace\n");
  console.log("Passed: commands, files, independent fork, pause/reconnect, stop/start.");
} finally {
  // Recover a submitted VM even if creation timed out before returning a handle.
  if (!vm) vm = await VM.get(name).catch((error) => {
    if (error.status !== 404) throw error;
  });
  let cleanupFailed = false;
  for (const cleanup of [
    () => branch?.remove(),
    () => snapshot?.delete(),
    () => vm?.remove(),
    ...connections.map((connection) => () => connection.close()),
  ]) {
    try { await cleanup(); }
    catch (error) { cleanupFailed = true; console.error("Cleanup:", error.message); }
  }
  if (cleanupFailed) throw new Error("A test resource could not be cleaned up");
  console.log("Test resources removed.");
}
