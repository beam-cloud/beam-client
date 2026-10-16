import { Image } from "../lib/resources/abstraction/image";
import { DEFAULT_VM_BASE_IMAGE, prepareVMImage } from "../lib/resources/abstraction/vm-image";
import { gunzipSync } from "zlib";

test("VM images append deterministic Python-compatible services without modifying the input Image", async () => {
  const image = new Image({
    baseImage: "ubuntu:22.04",
    buildSteps: [{ type: "shell", command: "echo custom" }],
  });
  const a = await prepareVMImage(image, true),
    b = await prepareVMImage(image, true);
  expect(a.config.buildSteps).toEqual(b.config.buildSteps);
  expect(image.config.buildSteps).toHaveLength(1);
  const step = a.config.buildSteps[1].command;
  expect(step).toContain("install true");
  const payload = step.match(/printf '%s' '([^']+)'/)![1];
  const archive = gunzipSync(Buffer.from(payload, "base64")).toString();
  for (const name of [
    "boot",
    "install",
    "desktop.html",
    "beam-terminal.service",
    "beam-desktop.service",
    "xstartup",
    "browser-trust",
  ])
    expect(archive).toContain(name);
});

test("prebuilt image IDs are used as-is and GPU builds are rejected", async () => {
  const image = Image.fromId("prepared-id");
  expect(await prepareVMImage(image, true)).toBe(image);
  const gpu = new Image({ gpu: "A10G" });
  await expect(prepareVMImage(gpu)).rejects.toThrow("CPU-only");
});


test("stock image uses pinned Ubuntu 24.04 and desktop supports Noble and Jammy", async () => {
  expect(DEFAULT_VM_BASE_IMAGE).toMatch(/^ubuntu:24\.04@sha256:[a-f0-9]{64}$/);
  const prepared = await prepareVMImage(Image.fromRegistry(DEFAULT_VM_BASE_IMAGE), true);
  expect(prepared.config.baseImage).toBe(DEFAULT_VM_BASE_IMAGE);
  const step = prepared.config.buildSteps[0].command;
  const payload = step.match(/printf '%s' '([^']+)'/)![1];
  const archive = gunzipSync(Buffer.from(payload, "base64")).toString();
  expect(archive).toContain("ubuntu:jammy|ubuntu:noble");
  expect(archive).toContain("libnss3-tools");
  expect(archive).toContain("/etc/ca-certificates/update.d/beam-browser");
  expect(archive).toContain("kasmvncserver_${VERSION_CODENAME}");
});
