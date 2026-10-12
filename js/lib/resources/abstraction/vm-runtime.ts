import type { VM } from "./vm";
import {
  SandboxFileSystem,
  SandboxProcess,
  SandboxProcessStream,
} from "./sandbox";
import type { VMExecOptions, VMProcessWaitOptions } from "../../types/vm";
import { checkAbort, delay, VMError } from "./vm-api";

/** A reattachable process bound to one boot's container ID, never to a reused PID. */
export class VMProcess extends SandboxProcess {
  private out?: SandboxProcessStream;
  private err?: SandboxProcessStream;
  private combined?: ReturnType<VMProcess["makeLogs"]>;
  constructor(
    public readonly vm: VM,
    private source: SandboxProcess,
  ) {
    super(source.sandbox_instance, source.pid);
    this.exitCode = source.exitCode;
    this.running = source.running;
    this.command = source.command;
    this.cwd = source.cwd;
    this.env = source.env;
  }
  get containerId(): string {
    return this.sandbox_instance.containerId;
  }
  async status(opts: VMProcessWaitOptions = {}): Promise<[number, string]> {
    if (this.exitCode >= 0) return [this.exitCode, "done"];
    await this.vm.assertRuntime(this.containerId, opts);
    const result = await this.source.status(opts);
    this.exitCode = result[0];
    this.source.exitCode = result[0];
    this.running = result[0] < 0;
    return result;
  }
  /** A wait timeout or abort ends the wait; call kill() explicitly to cancel execution. */
  async wait(opts: VMProcessWaitOptions | number = {}): Promise<number> {
    const options = typeof opts === "number" ? { timeoutMs: opts } : opts;
    checkAbort(options.signal);
    if (this.exitCode >= 0) return this.exitCode;
    return this.vm.keepAlive(async () => {
      const deadline =
        options.timeoutMs === undefined
          ? Infinity
          : Date.now() + options.timeoutMs;
      while (Date.now() < deadline) {
        checkAbort(options.signal);
        const code = (
          await this.status({
            signal: options.signal,
            timeoutMs: Number.isFinite(deadline)
              ? Math.max(1, deadline - Date.now())
              : undefined,
          })
        )[0];
        if (code >= 0) return code;
        await delay(
          Math.min(100, Math.max(0, deadline - Date.now())),
          options.signal,
        );
      }
      throw new VMError(`Process ${this.pid} did not exit before timeout`);
    });
  }
  async kill(): Promise<void> {
    await this.vm.assertRuntime(this.containerId);
    await this.source.kill();
  }
  private stream(which: "stdout" | "stderr"): SandboxProcessStream {
    const source = this.source[which];
    let output = "";
    return new SandboxProcessStream(this, async () => {
      if (this.exitCode < 0) await this.vm.assertRuntime(this.containerId);
      output += await source.read();
      return output;
    });
  }
  get stdout(): SandboxProcessStream {
    return (this.out ||= this.stream("stdout"));
  }
  get stderr(): SandboxProcessStream {
    return (this.err ||= this.stream("stderr"));
  }
  private makeLogs() {
    const stream = super.logs;
    const original = stream[Symbol.asyncIterator].bind(stream);
    const process = this;
    stream[Symbol.asyncIterator] = async function* () {
      const release =
        process.exitCode < 0 ? await process.vm.acquireLease() : async () => {};
      try {
        for await (const line of original()) yield line;
      } finally {
        await release();
      }
    };
    return Object.assign(stream, { process, close: () => process.kill() });
  }
  /** Cached async stream of stdout and stderr. close() kills a live log-follow process. */
  get logs() {
    return (this.combined ||= this.makeLogs());
  }
}

/** Python-style process namespace; direct vm.exec/listProcesses/getProcess are also available. */
export class VMProcessManager {
  constructor(private vm: VM) {}
  exec(command: string | string[], opts?: VMExecOptions): Promise<VMProcess> {
    return this.vm.exec(command, opts);
  }
  execShell(command: string, opts?: VMExecOptions): Promise<VMProcess> {
    return this.vm.execShell(command, opts);
  }
  list(): Promise<VMProcess[]> {
    return this.vm.listProcesses();
  }
  get(pid: number, opts?: { containerId?: string }): Promise<VMProcess> {
    return this.vm.getProcess(pid, opts);
  }
  getProcess(pid: number, opts?: { containerId?: string }): Promise<VMProcess> {
    return this.get(pid, opts);
  }
}

/** The existing JS filesystem surface, resolved against the current VM boot on every operation. */
export class VMFileSystem {
  constructor(private vm: VM) {}
  private async call<K extends keyof SandboxFileSystem>(
    method: K,
    args: Parameters<SandboxFileSystem[K]>,
  ): Promise<Awaited<ReturnType<SandboxFileSystem[K]>>> {
    const fs = (await this.vm.runtime()).fs;
    return (
      fs[method] as (
        ...params: Parameters<SandboxFileSystem[K]>
      ) => ReturnType<SandboxFileSystem[K]>
    ).apply(fs, args) as Promise<Awaited<ReturnType<SandboxFileSystem[K]>>>;
  }
  uploadFile(...args: Parameters<SandboxFileSystem["uploadFile"]>) {
    return this.call("uploadFile", args);
  }
  upload(...args: Parameters<SandboxFileSystem["upload"]>) {
    return this.call("upload", args);
  }
  download(...args: Parameters<SandboxFileSystem["download"]>) {
    return this.call("download", args);
  }
  stat(...args: Parameters<SandboxFileSystem["stat"]>) {
    return this.call("stat", args);
  }
  list(...args: Parameters<SandboxFileSystem["list"]>) {
    return this.call("list", args);
  }
  mkdir(...args: Parameters<SandboxFileSystem["mkdir"]>) {
    return this.call("mkdir", args);
  }
  removeDir(...args: Parameters<SandboxFileSystem["removeDir"]>) {
    return this.call("removeDir", args);
  }
  removeFile(...args: Parameters<SandboxFileSystem["removeFile"]>) {
    return this.call("removeFile", args);
  }
  replace(...args: Parameters<SandboxFileSystem["replace"]>) {
    return this.call("replace", args);
  }
  find(...args: Parameters<SandboxFileSystem["find"]>) {
    return this.call("find", args);
  }
  downloadFile(...args: Parameters<SandboxFileSystem["downloadFile"]>) {
    return this.call("downloadFile", args);
  }
  writeBytes(...args: Parameters<SandboxFileSystem["writeBytes"]>) {
    return this.call("writeBytes", args);
  }
  writeText(...args: Parameters<SandboxFileSystem["writeText"]>) {
    return this.call("writeText", args);
  }
  readBytes(...args: Parameters<SandboxFileSystem["readBytes"]>) {
    return this.call("readBytes", args);
  }
  readText(...args: Parameters<SandboxFileSystem["readText"]>) {
    return this.call("readText", args);
  }
  statFile(...args: Parameters<SandboxFileSystem["statFile"]>) {
    return this.call("statFile", args);
  }
  listFiles(...args: Parameters<SandboxFileSystem["listFiles"]>) {
    return this.call("listFiles", args);
  }
  createDirectory(...args: Parameters<SandboxFileSystem["createDirectory"]>) {
    return this.call("createDirectory", args);
  }
  deleteDirectory(...args: Parameters<SandboxFileSystem["deleteDirectory"]>) {
    return this.call("deleteDirectory", args);
  }
  deleteFile(...args: Parameters<SandboxFileSystem["deleteFile"]>) {
    return this.call("deleteFile", args);
  }
  remove(...args: Parameters<SandboxFileSystem["remove"]>) {
    return this.call("remove", args);
  }
  replaceInFiles(...args: Parameters<SandboxFileSystem["replaceInFiles"]>) {
    return this.call("replaceInFiles", args);
  }
  findInFiles(...args: Parameters<SandboxFileSystem["findInFiles"]>) {
    return this.call("findInFiles", args);
  }
}

/** Docker commands use literal argv and keep the same run/compose helpers as Sandbox. */
export class VMDocker {
  private readyContainer?: string;
  constructor(private vm: VM) {}
  async ensureReady(timeoutMs = 60_000): Promise<void> {
    const sandbox = await this.vm.runtime();
    if (this.readyContainer === sandbox.containerId) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const process = await this.vm.exec(["docker", "info"], { wait: true });
      if (
        (await process.wait({
          timeoutMs: Math.max(1, deadline - Date.now()),
        })) === 0
      ) {
        this.readyContainer = sandbox.containerId;
        return;
      }
      await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
    throw new VMError("Docker daemon did not become ready before timeout");
  }
  async exec(args: string[], opts?: VMExecOptions): Promise<VMProcess> {
    await this.ensureReady();
    return this.vm.exec(["docker", ...args], opts);
  }
  run(
    image: string,
    args: string[] = [],
    opts?: VMExecOptions,
  ): Promise<VMProcess> {
    return this.exec(
      ["run", "--network", "host", "--pid", "host", ...args, image],
      opts,
    );
  }
  compose(args: string[], opts?: VMExecOptions): Promise<VMProcess> {
    return this.exec(["compose", ...args], opts);
  }
  async composeStandalone(
    args: string[],
    opts?: VMExecOptions,
  ): Promise<VMProcess> {
    await this.ensureReady();
    return this.vm.exec(["docker-compose", ...args], opts);
  }
  version(opts?: VMExecOptions): Promise<VMProcess> {
    return this.exec(["version"], opts);
  }
}
