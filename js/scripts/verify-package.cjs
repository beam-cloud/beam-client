const assert = require("node:assert/strict");
const { gunzipSync } = require("node:zlib");

async function verify(sdk, format) {
  for (const key of [
    "VM",
    "VMError",
    "VMArtifact",
    "VMProcess",
    "Image",
    "Sandbox",
    "CloudBucket",
  ]) {
    assert.equal(typeof sdk[key], "function", `${format} export ${key}`);
  }
  // VM filesystem operations retain the canonical SDK's public aliases.
  for (const name of ["upload", "download", "stat", "list", "mkdir", "removeDir", "removeFile", "replace", "find"]) {
    assert.equal(typeof sdk.VMFileSystem.prototype[name], "function", `${format} VM filesystem alias ${name}`);
  }
  const prepared = await sdk.VM.prepareImage(
    sdk.Image.fromRegistry("ubuntu:22.04"),
    { desktop: true },
  );
  const command = prepared.config.buildSteps.at(-1).command;
  assert.ok(command.endsWith("install true"));
  const payload = command.match(/printf '%s' '([^']+)'/)[1];
  assert.ok(
    gunzipSync(Buffer.from(payload, "base64")).includes(
      Buffer.from("beam-terminal.service"),
    ),
  );
  console.log(`${format} exports and VM image assets verified`);
}
async function main() {
  await verify(require("../dist/index.js"), "CommonJS");
  await verify(await import("../dist/index.mjs"), "ESM");
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
