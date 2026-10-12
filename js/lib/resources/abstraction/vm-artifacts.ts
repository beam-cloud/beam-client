import type {
  VMArtifactCreateOptions,
  VMArtifactInfo,
  VMArtifactListOptions,
  VMConfig,
  VMCreateOptions,
} from "../../types/vm";
import { VM } from "./vm";
import { decodeArtifact, VMError, vmRequest } from "./vm-api";

/** An immutable disk snapshot or private template, independent of the source VM's lifetime. */
export class VMArtifact {
  constructor(public readonly info: VMArtifactInfo) {}
  get id(): string {
    return this.info.id;
  }
  get name(): string {
    return this.info.name;
  }
  get vmId(): string {
    return this.info.vmId;
  }
  get kind(): "snapshot" | "template" {
    return this.info.kind;
  }
  /** Create an independent VM with its own root and identity; RAM is not copied. */
  async fork(
    config: VMConfig | string = {},
    opts: VMCreateOptions = {},
  ): Promise<VM> {
    const options = typeof config === "string" ? { name: config } : config;
    if (options.template || options.snapshot || options.image)
      throw new VMError(
        "An artifact fork inherits its image and root; omit image, template and snapshot",
      );
    return VM.create({ ...options, [this.kind]: this.id }, opts);
  }
  async delete(): Promise<void> {
    await vmRequest(
      "DELETE",
      `/artifacts/${this.kind}/${encodeURIComponent(this.id)}`,
    );
  }
  async remove(): Promise<void> {
    return this.delete();
  }
}

/** Use VM.snapshots / VM.templates workspace-wide, or vm.snapshots / vm.templates for one machine. */
export class VMArtifacts {
  constructor(
    public readonly kind: "snapshot" | "template",
    private vm?: VM,
  ) {}
  async create(
    options: VMArtifactCreateOptions | string = {},
  ): Promise<VMArtifact> {
    const opts = typeof options === "string" ? { name: options } : options;
    const source = this.vm || (opts.vm ? await VM.get(opts.vm) : undefined);
    if (!source)
      throw new VMError(`Provide vm when creating a workspace ${this.kind}`);
    const raw = await source.action(this.kind, {
      name: opts.name || (this.kind === "template" ? source.name : ""),
      description: opts.description || "",
    });
    return new VMArtifact(decodeArtifact(raw));
  }
  async list(options: VMArtifactListOptions = {}): Promise<VMArtifact[]> {
    const raw = await vmRequest<any[] | null>("GET", `/artifacts/${this.kind}`);
    const vmId = options.vmId || this.vm?.id;
    return (raw || [])
      .map((item) => new VMArtifact(decodeArtifact(item)))
      .filter((item) => !vmId || item.vmId === vmId);
  }
  async get(nameOrId: string): Promise<VMArtifact> {
    const artifact = (await this.list()).find(
      (item) => item.id === nameOrId || item.name === nameOrId,
    );
    if (!artifact) throw new VMError(`${this.kind} ${nameOrId} not found`, 404);
    return artifact;
  }
  async delete(nameOrId: string): Promise<void> {
    // Resolve in the scoped collection so a VM manager cannot remove another VM's artifact.
    await (await this.get(nameOrId)).delete();
  }
  async remove(nameOrId: string): Promise<void> {
    return this.delete(nameOrId);
  }
  async fork(
    nameOrId: string,
    config: VMConfig | string = {},
    opts: VMCreateOptions = {},
  ): Promise<VM> {
    return (await this.get(nameOrId)).fork(config, opts);
  }
}
