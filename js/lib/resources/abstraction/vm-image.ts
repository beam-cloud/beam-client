import { Image } from "./image";
import { VMError } from "./vm-api";
import { VM_IMAGE_ASSETS } from "./vm-image-assets";

// Keep the stock guest pinned to the Python SDK default.
export const DEFAULT_VM_BASE_IMAGE =
  "ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55";

/** Append the same systemd/SSH/terminal/desktop contract used by the Python SDK. */
export async function prepareVMImage(
  image: Image,
  desktop = false,
): Promise<Image> {
  if (image.config.gpu) throw new VMError("VM images are CPU-only");
  // A content-addressed prebuilt image must already contain the VM services.
  if (image.config.imageId) return image;
  const prepared = new Image({
    ...image.config,
    commands: [...image.config.commands],
    buildSteps: [...(image.config.buildSteps || [])],
    ignorePython: true,
  });
  (prepared.config.buildSteps ||= []).push({
    type: "shell",
    command: `mkdir -p /tmp/beam-vm-assets && printf '%s' '${VM_IMAGE_ASSETS}' | base64 -d | tar -xz -C /tmp/beam-vm-assets && bash /tmp/beam-vm-assets/install ${desktop ? "true" : "false"}`,
  });
  return prepared;
}
