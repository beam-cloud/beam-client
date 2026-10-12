import { beamOpts, VM } from "../lib";

beamOpts.token = process.env.BEAM_TOKEN!;
beamOpts.workspaceId = process.env.BEAM_WORKSPACE_ID || "";

async function main() {
  const vm = await VM.create({
    name: process.env.BEAM_VM_NAME,
    cpu: 2,
    memory: "4Gi",
    protectedPorts: [7681],
    idleTimeout: 300,
    autoResume: true,
    metadata: { example: "vm-basic" },
  });
  console.log(vm.id, vm.name, vm.terminalUrl);
  await vm.fs.writeText("/workspace/hello.txt", "hello from JavaScript\n");
  const command = await vm.exec(["cat", "/workspace/hello.txt"]);
  await command.wait();
  console.log(await command.stdout.read());

  const snapshot = await vm.snapshots.create();
  const branch = await snapshot.fork({ cpu: 1, memory: 512 });
  console.log("Snapshot:", snapshot.id, "Fork:", branch.name);
  await branch.remove();
  await vm.stop(); // Durable root and snapshot remain for a later session.
  await vm.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
