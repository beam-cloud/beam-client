import { randomUUID } from "crypto";
import { Image } from "./image";
import {
  Sandbox,
  SandboxInstance,
  SandboxProcess,
  SandboxProcessResponse,
} from "./sandbox";
import beamClient from "../../client";
import { formatEnv, parseCpu, parseMemory } from "../../util";
import type {
  VMConfig,
  VMConnectOptions,
  VMCreateOptions,
  VMExecOptions,
  VMInfo,
  VMListOptions,
  VMLogsOptions,
  VMMetrics,
  VMPromptOptions,
  VMPromptSession,
  VMStartOptions,
  VMUpdateOptions,
  VMWaitOptions,
} from "../../types/vm";
import {
  checkAbort,
  decodeVM,
  delay,
  idleSeconds,
  VMError,
  vmDecode,
  vmRequest,
} from "./vm-api";
import { VMArtifact, VMArtifacts } from "./vm-artifacts";
import { prepareVMImage } from "./vm-image";
import {
  VMFileSystem,
  VMProcess,
  VMProcessManager,
  VMDocker,
} from "./vm-runtime";
import { VMDesktop } from "./vm-desktop";
import { VMAccess } from "./vm-access";

/** A named, persistent CPU VM. Every factory returns this same manageable object. */
export class VM extends VMAccess {
  static readonly snapshots = new VMArtifacts("snapshot");
  static readonly templates = new VMArtifacts("template");
  readonly snapshots = new VMArtifacts("snapshot", this);
  readonly templates = new VMArtifacts("template", this);
  readonly fs = new VMFileSystem(this);
  readonly docker = new VMDocker(this);
  readonly process = new VMProcessManager(this);
  readonly desktop = new VMDesktop(this);
  readonly requestId: string;
  readonly config: VMConfig;
  private _info?: VMInfo;
  private preparedBody?: Record<string, unknown>;
  private preparation?: Promise<this>;
  private creation?: Promise<this>;
  private connected?: SandboxInstance;
  private connectedAt = 0;
  private serviceContainer?: string;
  private handles = new Map<string, VMProcess>();

  constructor(config: VMConfig | string = {}) {
    super();
    this.config = typeof config === "string" ? { name: config } : { ...config };
    const fields = new Set([
      "name",
      "image",
      "cpu",
      "memory",
      "diskSize",
      "desktop",
      "dockerEnabled",
      "env",
      "secrets",
      "ports",
      "privatePorts",
      "protectedPorts",
      "ssh",
      "sshPublicKey",
      "sshKeyPath",
      "idleTimeout",
      "ttl",
      "idleAction",
      "autoResume",
      "pool",
      "template",
      "snapshot",
      "metadata",
      "blockNetwork",
      "allowList",
      "disks",
      "volumes",
      "requestId",
    ]);
    for (const key of Object.keys(this.config))
      if (!fields.has(key))
        throw new VMError(
          `Unknown VM option ${key}; persistent VMs are CPU-only`,
        );
    if (this.config.template && this.config.snapshot)
      throw new VMError("Choose a template or snapshot");
    if ((this.config.template || this.config.snapshot) && this.config.image)
      throw new VMError(
        "A template or snapshot supplies its image; omit image",
      );
    if (this.config.name && !/^[a-z][a-z0-9-]{0,23}$/.test(this.config.name))
      throw new VMError(
        "VM names must start with a lowercase letter and contain at most 24 lowercase letters, digits or dashes",
      );
    if (this.config.blockNetwork && this.config.allowList?.length)
      throw new VMError("blockNetwork and allowList cannot both be set");
    idleSeconds(this.config);
    this.requestId = this.config.requestId || randomUUID();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        this.requestId,
      )
    )
      throw new VMError("requestId must be a UUID");
  }

  static async create(
    config: VMConfig = {},
    opts: VMCreateOptions = {},
  ): Promise<VM> {
    return new VM(config).create(opts);
  }
  /** Read an existing VM by name or ID without starting compute. */
  static async get(
    nameOrId: string,
    opts: { sshKeyPath?: string } = {},
  ): Promise<VM> {
    return new VM(opts).setInfo(
      await vmRequest("GET", `/${encodeURIComponent(nameOrId)}`),
    );
  }
  /** Resolve and start/resume a VM, waiting for exec readiness by default. */
  static async connect(
    nameOrId: string,
    opts: VMConnectOptions = {},
  ): Promise<VM> {
    const vm = await VM.get(nameOrId, { sshKeyPath: opts.sshKeyPath });
    if (vm.status !== "running" || opts.cold) return vm.start(opts);
    return opts.wait === false ? vm : vm.wait(opts);
  }
  static async list(opts: VMListOptions = {}): Promise<VM[]> {
    const raw = await vmRequest<any[]>("GET", "", undefined, {
      params: {
        all: opts.all ? "true" : "false",
        status: opts.status,
        metadata:
          opts.metadata === undefined
            ? undefined
            : JSON.stringify(opts.metadata),
      },
    });
    return raw.map((info) => new VM().setInfo(info));
  }
  /** Prepare an Image for standalone image builds, without launching a VM. */
  static async prepareImage(
    image: Image,
    opts: { desktop?: boolean } = {},
  ): Promise<Image> {
    return prepareVMImage(image, opts.desktop);
  }

  get info(): VMInfo {
    if (!this._info) throw new VMError("Create or resolve the VM first");
    return this._info;
  }
  get id(): string {
    return this.info.id;
  }
  get name(): string {
    return this._info?.name || this.config.name || "";
  }
  get status(): VMInfo["status"] {
    return this.info.status;
  }
  get spec(): VMInfo["spec"] {
    return this.info.spec;
  }
  get metadata(): Record<string, string> {
    return this.info.metadata || {};
  }
  get containerId(): string | undefined {
    return this.info.containerId;
  }
  get terminalUrl(): string | undefined {
    return this.info.terminalUrl;
  }
  get desktopUrl(): string | undefined {
    return this.info.desktopUrl;
  }
  get urls(): Record<number, string> {
    return this.info.urls;
  }

  private path(): string {
    const key = this._info?.id || this.config.name;
    if (!key) throw new VMError("Create or resolve the VM first");
    return `/${encodeURIComponent(key)}`;
  }
  private setInfo(raw: any): this {
    const info = decodeVM(raw);
    if (info.containerId !== this._info?.containerId) {
      this.connected = undefined;
      this.serviceContainer = undefined;
      this.handles.clear();
    }
    this._info = info;
    this.connectedAt = Date.now();
    if (info.execReady && info.containerId && info.stubId)
      this.connected = this.makeSandbox(info.containerId, info.stubId);
    return this;
  }
  private makeSandbox(containerId: string, stubId: string): SandboxInstance {
    return new SandboxInstance(
      { containerId, stubId, url: "", ok: true },
      new Sandbox({ name: this.name }),
    );
  }
  /** @internal Shared management transport for the scoped helpers. */
  async action(
    action: string,
    body: Record<string, unknown> = {},
    opts: Record<string, any> = {},
  ): Promise<any> {
    return vmRequest("POST", `${this.path()}/${action}`, body, opts);
  }

  /** Build/resolve the image, mounts and SSH key, and freeze an idempotent launch request. */
  async prepare(): Promise<this> {
    if (this.preparedBody) return this;
    if (this.preparation) return this.preparation;
    this.preparation = this.prepareOnce();
    try {
      return await this.preparation;
    } finally {
      this.preparation = undefined;
    }
  }
  private async prepareOnce(): Promise<this> {
    // Detect an older gateway before performing an image build.
    try {
      await vmRequest("GET");
    } catch (error) {
      if (error instanceof VMError && error.status === 404)
        throw new VMError(
          "Persistent VMs are unavailable at this gateway; select a gateway with VM support",
          404,
          error,
        );
      throw error;
    }
    const c = this.config;
    const spec: Record<string, unknown> = {};
    const mappings: [keyof VMConfig, string][] = [
      ["diskSize", "disk_size"],
      ["desktop", "desktop"],
      ["dockerEnabled", "docker_enabled"],
      ["ports", "ports"],
      ["privatePorts", "private_ports"],
      ["protectedPorts", "protected_ports"],
      ["ssh", "ssh"],
      ["idleAction", "idle_action"],
      ["autoResume", "auto_resume"],
      ["pool", "pool"],
      ["blockNetwork", "block_network"],
      ["allowList", "allow_list"],
    ];
    for (const [key, name] of mappings)
      if (c[key] !== undefined) spec[name] = c[key];
    if (c.cpu !== undefined) spec.cpu = parseCpu(c.cpu);
    if (c.memory !== undefined) {
      const memory = parseMemory(c.memory);
      if (!Number.isInteger(memory) || memory < 256)
        throw new VMError("VM memory must be at least 256 MiB");
      spec.memory = memory;
    }
    const idle = idleSeconds(c);
    if (idle !== undefined) spec.idle_timeout = idle;
    if (c.env !== undefined) spec.env = formatEnv(c.env);
    if (c.secrets !== undefined)
      spec.secrets = c.secrets.map((secret) =>
        typeof secret === "string" ? secret : secret.name,
      );
    if (
      (c.template || c.snapshot) &&
      (c.ssh === false || c.desktop === false || c.ports !== undefined)
    ) {
      const seed = await (c.template ? VM.templates : VM.snapshots).get(
        c.template || c.snapshot!,
      );
      // Seed specs include system ports. Removing a service must remove its inherited port too.
      const ports =
        c.ports ||
        (seed.info.spec.ports || []).filter(
          (port) =>
            !(port === 2222 && c.ssh === false) &&
            !(port === 8080 && c.desktop === false && seed.info.spec.desktop),
        );
      spec.ports = ports;
      if (c.protectedPorts === undefined)
        spec.protected_ports = (seed.info.spec.protectedPorts || []).filter(
          (port) => ports.includes(port),
        );
    }
    if (c.disks !== undefined)
      spec.disks = c.disks.map((disk) => ({
        name: disk.name,
        size: disk.size,
        mount_path: disk.mountPath,
        filesystem: disk.filesystem || "ext4",
        driver: disk.driver || "qcow",
        read_only: disk.readOnly || false,
      }));
    if (c.volumes !== undefined) {
      const volumes = [];
      for (const volume of c.volumes) {
        if (!(await volume.getOrCreate()))
          throw new VMError(`Unable to prepare volume ${volume.name}`);
        const exported = volume.export();
        volumes.push({
          id: exported.id,
          mount_path: exported.mountPath,
          ...(exported.config
            ? {
                config: Object.fromEntries(
                  Object.entries(exported.config).map(([k, v]) => [
                    k.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
                    v,
                  ]),
                ),
              }
            : {}),
        });
      }
      spec.volumes = volumes;
    }
    if (c.ssh !== false)
      spec.ssh_public_key = c.sshPublicKey || (await this.publicKey());
    if (!c.template && !c.snapshot) {
      spec.ssh = c.ssh ?? true;
      const image = await prepareVMImage(
        c.image || Image.fromRegistry("ubuntu:22.04"),
        c.desktop,
      );
      const result = await image.build();
      if (!result.success || !result.imageId)
        throw new VMError("VM image build failed");
      spec.image_id = result.imageId;
    }
    this.preparedBody = JSON.parse(
      JSON.stringify({
        name: c.name || "",
        spec,
        template: c.template || "",
        request_id: this.requestId,
        ...(c.snapshot ? { snapshot: c.snapshot } : {}),
        ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
      }),
    );
    return this;
  }
  /** Create and wait for exec readiness. wait:false returns after launch submission. */
  async create(opts: VMCreateOptions = {}): Promise<this> {
    if (this._info && !this.preparedBody)
      throw new VMError("This VM already exists; use start() or resume()");
    if (this.creation) return this.creation;
    this.creation = (async () => {
      checkAbort(opts.signal);
      await this.prepare();
      this.setInfo(
        await vmRequest("POST", "", this.preparedBody, {
          params: opts.wait === false ? {} : { wait: "exec" },
          timeout: opts.timeoutMs ?? 180_000,
          signal: opts.signal,
        }),
      );
      return opts.wait === false ? this : this.wait(opts);
    })();
    try {
      return await this.creation;
    } finally {
      this.creation = undefined;
    }
  }
  async refresh(
    opts: Pick<VMWaitOptions, "timeoutMs" | "signal"> = {},
  ): Promise<this> {
    return this.setInfo(
      await vmRequest("GET", this.path(), undefined, {
        timeout: opts.timeoutMs,
        signal: opts.signal,
      }),
    );
  }
  async start(opts: VMStartOptions = {}): Promise<this> {
    this.setInfo(
      await this.action("start", opts.cold ? { cold: true } : {}, {
        params: opts.wait === false ? {} : { wait: "exec" },
        timeout: opts.timeoutMs ?? 180_000,
        signal: opts.signal,
      }),
    );
    return opts.wait === false ? this : this.wait(opts);
  }
  async resume(opts: VMStartOptions = {}): Promise<this> {
    return this.start(opts);
  }
  async pause(): Promise<this> {
    return this.setInfo(await this.action("pause"));
  }
  /** Stop from disk. noSnapshot skips creating the visible stop snapshot; the durable root remains. */
  async stop(opts: { noSnapshot?: boolean } = {}): Promise<this> {
    return this.setInfo(
      await this.action("stop", { no_snapshot: opts.noSnapshot ?? false }),
    );
  }
  async remove(): Promise<void> {
    await vmRequest("DELETE", this.path());
    this.connected = undefined;
    if (this._info)
      this._info = {
        ...this._info,
        desiredState: "deleted",
        status: "deleted",
        containerId: undefined,
      };
    await this.close();
  }
  async delete(): Promise<void> {
    return this.remove();
  }
  async update(opts: VMUpdateOptions): Promise<this> {
    const body: Record<string, unknown> = {};
    const idle = idleSeconds(opts);
    if (idle !== undefined) body.idle_timeout = idle;
    for (const [key, value] of Object.entries(opts)) {
      if (value !== undefined && key !== "idleTimeout" && key !== "ttl")
        body[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)] =
          value;
    }
    return this.setInfo(await vmRequest("PATCH", this.path(), body));
  }
  async updateTtl(ttl: number): Promise<this> {
    return this.update({ idleTimeout: ttl });
  }
  async updateNetworkPermissions(
    blockNetwork = false,
    allowList: string[] = [],
  ): Promise<this> {
    return this.update({ blockNetwork, allowList });
  }

  async wait(opts: VMWaitOptions = {}): Promise<this> {
    const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      checkAbort(opts.signal);
      if (!this._info)
        await this.refresh({
          timeoutMs: Math.max(1, deadline - Date.now()),
          signal: opts.signal,
        });
      if (this.status === "error")
        throw new VMError(this.info.error || "VM failed to start");
      if (["deleted", "deleting", "stopped", "paused"].includes(this.status))
        throw new VMError(`VM is ${this.status}; call start() before wait()`);
      if (this.status === "starting" || this.status === "running") {
        try {
          const sandbox = await this.runtime(
            false,
            true,
            Math.max(1, deadline - Date.now()),
            opts.signal,
          );
          this.info.status = "running";
          if (
            !opts.services ||
            this.serviceContainer === sandbox.containerId ||
            (await this.servicesReady(sandbox, deadline))
          ) {
            if (opts.services) this.serviceContainer = sandbox.containerId;
            return this;
          }
        } catch (error) {
          if (
            !(
              error instanceof VMError &&
              (error.status === 503 || error.status === 502)
            ) &&
            !String(error).match(
              /not ready|connection refused|failed to connect|timeout/i,
            )
          )
            throw error;
        }
      }
      await delay(
        Math.min(100, Math.max(0, deadline - Date.now())),
        opts.signal,
      );
      await this.refresh({
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal: opts.signal,
      });
    }
    throw new VMError(
      "VM did not become ready before timeout; inspect info and logs",
    );
  }
  private async servicesReady(
    sandbox: SandboxInstance,
    deadline: number,
  ): Promise<boolean> {
    const checks: [string, number][] = [["beam-terminal.service", 7681]];
    if (this.info.spec.ssh) checks.push(["ssh.service", 2222]);
    if (this.info.spec.desktop) checks.push(["beam-desktop.service", 8080]);
    const code = `import socket,subprocess\nservices=${JSON.stringify(checks)}\nfor unit,port in services:\n subprocess.run(['systemctl','is-active','--quiet',unit],check=True)\n socket.create_connection(('127.0.0.1',port),1).close()`;
    const process = this.track(
      await sandbox.exec(["python3", "-c", code], { cwd: "/", wait: true }),
    );
    return (
      (await process.wait({
        timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now())),
      })) === 0
    );
  }

  /** @internal Resolve fresh runtime identity before each new guest operation. */
  async runtime(
    refresh = true,
    allowStarting = false,
    timeoutMs = 180_000,
    signal?: AbortSignal,
  ): Promise<SandboxInstance> {
    if (
      !this._info ||
      (refresh && (!this.connected || Date.now() - this.connectedAt >= 1000))
    )
      await this.refresh({ timeoutMs, signal });
    if (
      !["starting", "running"].includes(this.status) &&
      this.info.spec.autoResume
    ) {
      this.setInfo(
        await this.action(
          "wake",
          {},
          { params: { wait: "exec" }, timeout: timeoutMs, signal },
        ),
      );
      await this.wait({ timeoutMs, signal });
    }
    // A management update can report stored "starting" before reconciliation
    // catches up with process-manager readiness. Resolve that readiness here.
    if (this.status === "starting" && !allowStarting) {
      await this.wait({ timeoutMs, signal });
    }
    const container = this.containerId;
    if (
      !container ||
      !(
        this.status === "running" ||
        (allowStarting && this.status === "starting")
      )
    )
      throw new VMError(
        `VM is ${this.status}; call start() or enable autoResume`,
      );
    if (!this.connected) {
      const response = await beamClient.request({
        method: "POST",
        url: `/api/v1/gateway/pods/${encodeURIComponent(container)}/connect`,
        data: {},
        timeout: timeoutMs,
        signal,
      });
      if (!response.data.ok)
        throw new VMError(
          response.data.errorMsg || "VM process manager is not ready",
          503,
        );
      this.connected = this.makeSandbox(
        container,
        response.data.stubId || this.info.stubId || "",
      );
      this.connectedAt = Date.now();
    }
    if (this.info.spec.idleTimeout) await this.touch();
    return this.connected;
  }
  /** @internal Reject PID reuse after a reboot, without automatically waking a VM. */
  async assertRuntime(
    containerId: string,
    opts: Pick<VMWaitOptions, "timeoutMs" | "signal"> = {},
  ): Promise<void> {
    if (Date.now() - this.connectedAt >= 1000) await this.refresh(opts);
    if (
      this.containerId !== containerId ||
      !["running", "starting"].includes(this.status)
    )
      throw new VMError(
        "This process belongs to a previous VM runtime; reconnect or launch it again",
      );
  }
  private track(process: SandboxProcess): VMProcess {
    const key = `${process.sandbox_instance.containerId}:${process.pid}`;
    let handle = this.handles.get(key);
    if (!handle) {
      handle = new VMProcess(this, process);
      this.handles.set(key, handle);
    }
    return handle;
  }
  async exec(
    command: string | string[],
    opts: VMExecOptions = {},
  ): Promise<VMProcess> {
    if (
      (typeof command !== "string" && !command.length) ||
      (typeof command === "string" && !command.trim())
    )
      throw new VMError("A command is required");
    const sandbox = await this.runtime();
    const options = { cwd: "/workspace", ...opts };
    if (opts.stdin === undefined)
      return this.track(await sandbox.exec(command, options));
    const directory = `/tmp/.beam-stdin-${randomUUID()}`;
    try {
      const mkdir = this.track(
        await sandbox.exec(["mkdir", "-m", "700", "--", directory], {
          cwd: "/tmp",
          wait: true,
        }),
      );
      if ((await mkdir.wait({ timeoutMs: 30_000 })) !== 0)
        throw new VMError(await mkdir.stderr.read());
      await sandbox.fs.writeBytes(
        `${directory}/input`,
        typeof opts.stdin === "string"
          ? Buffer.from(opts.stdin)
          : Buffer.from(opts.stdin),
        0o644,
      );
      const argv =
        typeof command === "string" ? ["sh", "-lc", command] : command;
      return this.track(
        await sandbox.exec(
          [
            "sh",
            "-c",
            'exec 3< "$1/input"; rm -- "$1/input"; rmdir -- "$1"; shift; exec "$@" <&3',
            "beam-stdin",
            directory,
            ...argv,
          ],
          options,
        ),
      );
    } catch (error) {
      await sandbox.fs.deleteDirectory(directory).catch(() => {});
      throw error;
    }
  }
  async execShell(
    command: string,
    opts: VMExecOptions = {},
  ): Promise<VMProcess> {
    return this.exec(["sh", "-lc", command], opts);
  }
  async runCode(
    code: string,
    blocking = true,
    cwd = "/workspace",
    env?: Record<string, string>,
  ): Promise<SandboxProcessResponse | VMProcess> {
    const process = await this.exec(["python3", "-c", code], {
      cwd,
      env,
      wait: blocking,
    });
    if (!blocking) return process;
    const exitCode = await process.wait();
    const [stdout, stderr] = await Promise.all([
      process.stdout.read(),
      process.stderr.read(),
    ]);
    return {
      pid: process.pid,
      exitCode,
      stdout,
      stderr,
      result: stdout + stderr,
    };
  }
  async listProcesses(): Promise<VMProcess[]> {
    return (await (await this.runtime()).listProcesses()).map((process) =>
      this.track(process),
    );
  }
  localProcesses(): VMProcess[] {
    return [...this.handles.values()];
  }
  /** Reattach to a PID; containerId guards against PID reuse if saved across restarts. */
  async getProcess(
    pid: number,
    opts: { containerId?: string } = {},
  ): Promise<VMProcess> {
    const sandbox = await this.runtime();
    if (!Number.isInteger(pid) || pid < 1)
      throw new VMError("pid must be a positive integer");
    if (opts.containerId && opts.containerId !== sandbox.containerId)
      throw new VMError("This process belongs to a previous VM runtime");
    return this.track(new SandboxProcess(sandbox, pid));
  }

  async touch(): Promise<void> {
    await this.action("touch");
  }
  /** @internal Lease renewal is serialized and released even when a callback fails. */
  async acquireLease(): Promise<() => Promise<void>> {
    const lease = randomUUID();
    const params = { lease, release: "0" };
    await this.action("touch", {}, { params, timeout: 3000 });
    const interval = Math.max(
      250,
      Math.min(15_000, ((this.info.spec.idleTimeout || 45) * 1000) / 3),
    );
    let done = false;
    let failure: unknown;
    let recoverySince = 0;
    const controller = new AbortController();
    const heartbeat = (async () => {
      while (!done) {
        try {
          await delay(interval, controller.signal);
        } catch {
          return;
        }
        if (done) return;
        try {
          await this.action("touch", {}, { params, timeout: 3000 });
          recoverySince = 0;
        } catch (error) {
          const transient =
            error instanceof VMError &&
            (!error.status || error.status >= 500 || error.status === 429);
          recoverySince ||= Date.now();
          if (!transient || Date.now() - recoverySince >= 120_000) {
            failure = error;
            return;
          }
        }
      }
    })();
    return async () => {
      done = true;
      controller.abort();
      await heartbeat;
      await this.action(
        "touch",
        {},
        { params: { lease, release: "1" }, timeout: 3000 },
      ).catch((error) => {
        failure ||= error;
      });
      if (failure)
        throw new VMError("VM activity lease failed", undefined, failure);
    };
  }
  async keepAlive<T>(callback: (vm: this) => Promise<T>): Promise<T> {
    await this.runtime();
    const release = await this.acquireLease();
    let failed = false;
    try {
      return await callback(this);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (failed) await release().catch(() => {});
      else await release();
    }
  }

  async snapshot(name?: string): Promise<VMArtifact> {
    return this.snapshots.create({ name });
  }
  async createTemplate(
    name?: string,
    description?: string,
  ): Promise<VMArtifact> {
    return this.templates.create({ name, description });
  }
  async fork(name?: string, opts: VMCreateOptions = {}): Promise<VM> {
    const child = new VM({
      sshKeyPath: this.config.sshKeyPath,
      sshPublicKey: this.config.sshPublicKey,
    }).setInfo(
      await this.action("fork", {
        name: name || "",
        ssh_public_key: this.config.sshPublicKey || (await this.publicKey()),
      }),
    );
    return opts.wait === false ? child : child.wait(opts);
  }
  async exposePort(
    port: number,
    opts: { protected?: boolean } = {},
  ): Promise<string> {
    this.setInfo(
      await this.action("expose", {
        port,
        ...(opts.protected === undefined ? {} : { protected: opts.protected }),
      }),
    );
    return this.info.urls[port];
  }
  async expose(
    port: number,
    opts: { protected?: boolean } = {},
  ): Promise<string> {
    return this.exposePort(port, opts);
  }
  async unexposePort(port: number): Promise<void> {
    this.setInfo(await this.action("unexpose", { port }));
  }
  async unexpose(port: number): Promise<void> {
    return this.unexposePort(port);
  }
  async bind(port: number): Promise<void> {
    this.setInfo(await this.action("bind", { port }));
  }
  async getUrl(port: number): Promise<string> {
    await this.refresh();
    const url = this.info.urls[port];
    if (!url)
      throw new VMError(
        `Port ${port} is not published; call exposePort() first`,
      );
    return url;
  }
  async listUrls(): Promise<Record<number, string>> {
    await this.refresh();
    return this.info.urls;
  }
  async getAccessToken(): Promise<string> {
    return (await this.action("access-token")).token;
  }
  async rotateAccessToken(): Promise<string> {
    return (await this.action("rotate-access-token")).token;
  }
  async accessUrl(port: number, opts: { ttl?: number } = {}): Promise<string> {
    return (await this.action("access-session", { port, ttl: opts.ttl ?? 600 }))
      .url;
  }

  async metrics(): Promise<VMMetrics> {
    const code = `import json,os,time\ndef cpu():\n v=list(map(int,open('/proc/stat').readline().split()[1:9]));return sum(v),v[3]+v[4]\nb=cpu();time.sleep(1);a=cpu();total=a[0]-b[0];idle=a[1]-b[1]\nm={k:int(v.strip().split()[0])*1024 for k,v in (line.split(':',1) for line in open('/proc/meminfo'))}\nd=os.statvfs('/')\nprint(json.dumps(dict(timestamp=time.time(),cpu_count=os.cpu_count(),cpu_used_percent=100*(total-idle)/total if total else 0,memory_total_bytes=m['MemTotal'],memory_used_bytes=m['MemTotal']-m['MemAvailable'],disk_total_bytes=d.f_blocks*d.f_frsize,disk_used_bytes=(d.f_blocks-d.f_bfree)*d.f_frsize)))`;
    const process = await this.exec(["python3", "-c", code], { cwd: "/" });
    if ((await process.wait({ timeoutMs: 10_000 })) !== 0)
      throw new VMError(
        (await process.stderr.read()) || "Unable to sample VM metrics",
      );
    return vmDecode(JSON.parse(await process.stdout.read()));
  }
  async prompt(
    prompt: string,
    opts?: VMPromptOptions & { background?: false },
  ): Promise<VMProcess>;
  async prompt(
    prompt: string,
    opts: VMPromptOptions & { background: true },
  ): Promise<VMPromptSession>;
  async prompt(
    prompt: string,
    opts: VMPromptOptions,
  ): Promise<VMProcess | VMPromptSession>;
  async prompt(
    prompt: string,
    opts: VMPromptOptions = {},
  ): Promise<VMProcess | VMPromptSession> {
    const session = `prompt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const agent = opts.agent || "claude";
    if (!["claude", "codex"].includes(agent))
      throw new VMError("agent must be claude or codex");
    const command =
      agent === "claude" ? ["claude", "-p", prompt] : ["codex", "exec", prompt];
    // Literal argv enters the shell through positional parameters, preserving arbitrary prompts.
    const shell =
      'mkdir -p /workspace/.beam-vm/logs; set -o pipefail; log="$1"; shift; "$@" 2>&1 | tee "$log"';
    const argv = [
      "bash",
      "-c",
      shell,
      "beam-prompt",
      `/workspace/.beam-vm/logs/${session}.log`,
      ...command,
    ];
    if (!opts.background)
      return this.exec(argv, { cwd: opts.cwd || "/workspace", env: opts.env });
    const process = await this.exec([
      "systemd-run",
      "--collect",
      `--unit=${session}`,
      `--working-directory=${opts.cwd || "/workspace"}`,
      ...Object.entries(opts.env || {}).map(
        ([key, value]) => `--setenv=${key}=${value}`,
      ),
      ...argv,
    ]);
    if ((await process.wait({ timeoutMs: 30_000 })) !== 0)
      throw new VMError(
        (await process.stderr.read()) || "Failed to launch prompt service",
      );
    return { session, unit: `${session}.service` };
  }
  /** Return a process's async log stream, including its wait/kill handle. */
  async logs(opts: VMLogsOptions = {}): Promise<VMProcess["logs"]> {
    if (
      [opts.pid, opts.unit, opts.session].filter((value) => value !== undefined)
        .length > 1
    )
      throw new VMError("Choose pid, unit or session for logs");
    if (opts.pid !== undefined) return (await this.getProcess(opts.pid)).logs;
    if (opts.session && !/^[a-zA-Z0-9_-]+$/.test(opts.session))
      throw new VMError("Invalid prompt session");
    const lines = opts.lines ?? 200;
    if (!Number.isInteger(lines) || lines < 0)
      throw new VMError("lines must be a nonnegative integer");
    const command = opts.session
      ? [
          "tail",
          "-n",
          String(lines),
          ...(opts.follow ? ["-f"] : []),
          `/workspace/.beam-vm/logs/${opts.session}.log`,
        ]
      : [
          "journalctl",
          "--no-pager",
          "-n",
          String(lines),
          ...(opts.follow ? ["-f"] : []),
          ...(opts.unit ? ["-u", opts.unit] : []),
        ];
    return (await this.exec(command)).logs;
  }
}
