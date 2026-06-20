import * as fs from "fs";
import { Pod, PodInstance } from "./pod";
import { CreateStubConfig } from "./stub";
import { EStubType } from "../../types/stub";
import type {
  PodSandboxSnapshotResponse,
  PodSandboxCreateImageFromFilesystemResponse,
  PodSandboxUpdateTtlResponse,
  PodSandboxExposePortResponse,
  PodSandboxUpdateNetworkPermissionsResponse,
  PodSandboxExecResponse,
  PodSandboxListProcessesResponse,
  PodSandboxListFilesResponse,
  PodSandboxCreateDirectoryResponse,
  PodSandboxListUrlsResponse,
  PodInstanceData,
  ExecOptions,
} from "../../types/pod";
import beamClient from "../..";

/** Error thrown when connecting to a sandbox fails. */
export class SandboxConnectionError extends Error {}
/** Error thrown for sandbox filesystem operations. */
export class SandboxFileSystemError extends Error {}
/** Error thrown for sandbox process operations. */
export class SandboxProcessError extends Error {}

function shellQuote(arg: string): string {
  if (arg === "") return "''";
  // Simple POSIX single-quote escaping
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * A sandboxed container for running code or arbitrary processes.
 * You can use this to create isolated environments where you can execute code,
 * manage files, and run processes.
 *
 * Constructor parameters:
 * - config (CreateStubConfig): Base stub configuration for the sandbox.
 * - syncLocalDir (boolean): Whether to sync the local working directory on creation.
 *   Default is false.
 *
 * Config fields (selected):
 * - name (string): The sandbox app name (required).
 * - cpu (number | string): The number of CPU cores allocated to the container. Default is 1.
 * - memory (number | string): The amount of memory allocated to the container. It should be specified in
 *   MiB, or as a string with units (e.g. "1Gi"). Default is 128 MiB.
 * - gpu (GpuType | string | Array<GpuType | string>): The GPU type(s) to use. Default is GpuType.NoGPU.
 * - gpuCount (number): The number of GPUs to allocate. Default is 0 (auto-promotes to 1 if gpu is set).
 * - image (Image): The container image used for the sandbox.
 * - keepWarmSeconds (number): The number of seconds to keep the sandbox around. Default is 60s. Use -1
 *   for sandboxes that never timeout.
 * - volumes (Volume[]): The volumes and/or cloud buckets to mount into the sandbox container.
 * - secrets (SecretVar[]): Secrets to pass to the sandbox, e.g. [{ name: "API_KEY" }].
 * - blockNetwork (boolean): Whether to block all outbound network access. Cannot be combined with
 *   `allowList`.
 * - allowList (string[]): CIDR ranges that are allowed for outbound network access. When specified,
 *   all other outbound traffic is blocked.
 * - authorized (boolean): Ignored for sandboxes (forced to false).
 */
export class Sandbox extends Pod {
  public syncLocalDir: boolean = false;

  constructor(config: CreateStubConfig, syncLocalDir: boolean = false) {
    super(config);
    this.syncLocalDir = syncLocalDir;
  }

  /**
   * Connect to an existing sandbox instance by ID.
   *
   * Parameters:
   * - id (string): The container ID of the existing sandbox instance.
   *
   * Returns: SandboxInstance - A connected sandbox instance.
   *
   * Throws: SandboxConnectionError if the connection fails.
   */
  public static async connect(id: string): Promise<SandboxInstance> {
    const resp = await beamClient.request({
      method: "POST",
      url: `api/v1/gateway/pods/${id}/connect`,
      data: {},
    });

    const data = resp.data as {
      ok: boolean;
      errorMsg?: string;
      stubId?: string;
    };
    if (!data.ok) {
      throw new SandboxConnectionError(
        data.errorMsg || "Failed to connect to sandbox",
      );
    }

    const sandbox = new Sandbox({ name: id });
    return new SandboxInstance(
      {
        containerId: id,
        url: "",
        ok: true,
        errorMsg: "",
        stubId: data.stubId || "",
      },
      sandbox,
    );
  }

  /**
   * Create a sandbox instance from a filesystem snapshot.
   *
   * Parameters:
   * - snapshotId (string): The ID of the snapshot to create the sandbox from.
   *
   * Returns: SandboxInstance - A new sandbox instance ready for use.
   *
   * Throws: SandboxConnectionError if the sandbox creation fails.
   */
  public static async createFromSnapshot(
    snapshotId: string,
  ): Promise<SandboxInstance> {
    // eslint-disable-next-line no-console
    console.log(`Creating sandbox from snapshot: ${snapshotId}`);

    const createResp = await beamClient.request({
      method: "POST",
      url: `api/v1/gateway/pods`,
      data: { checkpointId: snapshotId },
    });
    const body = createResp.data as {
      ok: boolean;
      containerId: string;
      errorMsg?: string;
      stubId?: string;
    };

    if (!body.ok) {
      throw new SandboxConnectionError(
        body.errorMsg || "Failed to create sandbox from snapshot",
      );
    }

    // eslint-disable-next-line no-console
    console.log(`Sandbox created successfully ===> ${body.containerId}`);

    // Connect to the sandbox to ensure it's ready
    const connectResp = await beamClient.request({
      method: "POST",
      url: `api/v1/gateway/pods/${body.containerId}/connect`,
      data: {},
    });
    const connectData = connectResp.data as {
      ok: boolean;
      errorMsg?: string;
    };
    if (!connectData.ok) {
      throw new SandboxConnectionError(
        connectData.errorMsg || "Failed to connect to sandbox",
      );
    }

    const sandbox = new Sandbox({ name: body.containerId });
    return new SandboxInstance(
      {
        stubId: body.stubId || "",
        containerId: body.containerId,
        url: "",
        ok: body.ok,
        errorMsg: body.errorMsg || "",
      },
      sandbox,
    );
  }

  /**
   * Create a new sandbox instance.
   *
   * This method creates a new containerized sandbox environment with the
   * specified configuration.
   *
   * Returns: SandboxInstance - A new sandbox instance ready for use.
   *
   * Throws: SandboxConnectionError if the sandbox creation fails.
   */
  public async create(entrypoint?: string[]): Promise<SandboxInstance> {
    this.stub.config.entrypoint = ["tail", "-f", "/dev/null"];
    if (entrypoint && entrypoint.length) {
      this.stub.config.entrypoint = entrypoint;
    }

    const ignorePatterns = this.syncLocalDir ? undefined : ["*"];

    const prepared = await this.stub.prepareRuntime(
      undefined,
      EStubType.Sandbox,
      true,
      ignorePatterns,
    );
    if (!prepared) {
      const detail = this.stub.lastError?.message ?? "unknown reason";
      throw new SandboxConnectionError(`Failed to prepare runtime: ${detail}`);
    }

    // eslint-disable-next-line no-console
    console.log("Creating sandbox");

    const createResp = await beamClient.request({
      method: "POST",
      url: `api/v1/gateway/pods`,
      data: { stubId: this.stub.stubId },
    });
    const body = createResp.data as {
      ok: boolean;
      containerId: string;
      errorMsg?: string;
    };

    if (!body.ok) {
      throw new SandboxConnectionError(
        body.errorMsg || "Failed to create sandbox",
      );
    }

    // eslint-disable-next-line no-console
    console.log(`Sandbox created successfully ===> ${body.containerId}`);

    // Connect to the sandbox to ensure it's ready
    const connectResp = await beamClient.request({
      method: "POST",
      url: `api/v1/gateway/pods/${body.containerId}/connect`,
      data: {},
    });
    const connectData = connectResp.data as {
      ok: boolean;
      errorMsg?: string;
    };
    if (!connectData.ok) {
      throw new SandboxConnectionError(
        connectData.errorMsg || "Failed to connect to sandbox",
      );
    }

    if ((this.stub.config.keepWarmSeconds as number) < 0) {
      // eslint-disable-next-line no-console
      console.log(
        "This sandbox has no timeout, it will run until it is shut down manually.",
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `This sandbox will timeout after ${this.stub.config.keepWarmSeconds} seconds.`,
      );
    }

    return new SandboxInstance(
      {
        stubId: this.stub.stubId!,
        containerId: body.containerId,
        ok: body.ok,
        errorMsg: body.errorMsg || "",
        url: "",
      },
      this,
    );
  }
}

/**
 * A sandbox instance that provides access to the sandbox internals.
 *
 * This class represents an active sandboxed container and provides methods for
 * process management, file system operations, preview URLs, and lifecycle
 * management.
 *
 * Attributes:
 * - containerId (string): The unique ID of the created sandbox container.
 * - stubId (string): The stub ID used for sandbox operations.
 * - fs (SandboxFileSystem): File system interface for the sandbox.
 * - processes (Record<number, SandboxProcess>): Map of running processes by PID.
 * - terminated (boolean): Whether the sandbox has been terminated.
 *
 * Process Management Methods:
 * - runCode(code, blocking?, cwd?, env?): Execute Python code in the sandbox.
 * - exec(command, opts?): Run argv safely or shell text for string input.
 * - execShell(command, opts?): Run shell text exactly as provided.
 * - listProcesses(): Get running processes from the server.
 */
export class SandboxInstance extends PodInstance {
  public stubId: string;
  public fs: SandboxFileSystem;
  public processes: Record<number, SandboxProcess> = {};
  public terminated: boolean = false;

  constructor(data: { stubId: string } & PodInstanceData, pod: Pod) {
    super(data, pod);
    this.stubId = data.stubId;
    this.fs = new SandboxFileSystem(this);
  }

  /**
   * Create a snapshot of the sandbox memory and filesystem.
   *
   * @returns string - The snapshot ID.
   */
  public async snapshot(): Promise<string> {
    // eslint-disable-next-line no-console
    const resp = await beamClient.request({
      method: "POST",
      url: `/api/v1/gateway/pods/${this.containerId}/snapshot-memory`,
      data: { stubId: this.stubId },
    });
    const data = resp.data as PodSandboxSnapshotResponse;
    if (!data.ok)
      throw new SandboxProcessError(data.errorMsg || "Failed to snapshot");
    return data.checkpointId;
  }

  /**
   * Create an image from the sandbox filesystem
   * @returns string - The image ID.
   */
  public async createImageFromFilesystem(): Promise<string> {
    const resp = await beamClient.request({
      method: "POST",
      url: `/api/v1/gateway/pods/${this.containerId}/create-image-from-filesystem`,
      data: { stubId: this.stubId },
      timeout: 600000,
    });
    const data = resp.data as PodSandboxCreateImageFromFilesystemResponse;
    if (!data.ok)
      throw new SandboxProcessError(
        data.errorMsg || "Failed to create image from filesystem",
      );
    return data.imageId;
  }

  /** Get the ID of the sandbox. */
  public get sandboxId(): string {
    return this.containerId;
  }

  /**
   * Update the keep warm setting of the sandbox.
   *
   * Parameters: ttl (number): The number of seconds to keep the sandbox alive. Use -1 for never timeout.
   */
  public async updateTtl(ttl: number): Promise<void> {
    const resp = await beamClient.request({
      method: "PATCH",
      url: `/api/v1/gateway/pods/${this.containerId}/ttl`,
      data: { ttl },
    });
    const data = resp.data as PodSandboxUpdateTtlResponse;
    if (!data.ok)
      throw new SandboxProcessError(data.errorMsg || "Failed to update TTL");
  }

  /**
   * Dynamically expose a port to the internet. Returns the public URL.
   */
  public async exposePort(port: number): Promise<string> {
    const resp = await beamClient.request({
      method: "POST",
      url: `/api/v1/gateway/pods/${this.containerId}/ports/expose`,
      data: { stubId: this.stubId, port },
    });
    const data = resp.data as PodSandboxExposePortResponse;
    if (data.ok && data.url) return data.url;
    throw new SandboxProcessError(data.errorMsg || "Failed to expose port");
  }

  /**
   * Dynamically update outbound network permissions for the sandbox.
   *
   * Parameters:
   * - blockNetwork (boolean): If true, block all outbound network access. Defaults to false.
   * - allowList (string[]): Optional list of allowed outbound domains/IPs. Cannot be used with blockNetwork=true.
   *
   * Throws: SandboxConnectionError if the update fails.
   */
  public async updateNetworkPermissions(
    blockNetwork: boolean = false,
    allowList?: string[],
  ): Promise<void> {
    if (blockNetwork && allowList !== undefined) {
      throw new Error(
        "Cannot specify both 'blockNetwork=true' and 'allowList'. Use 'allowList' with CIDR notation to allow specific ranges, or use 'blockNetwork=true' to block all outbound traffic.",
      );
    }

    const resp = await beamClient.request({
      method: "POST",
      url: `/api/v1/gateway/pods/${this.containerId}/network/update`,
      data: {
        stubId: this.stubId,
        blockNetwork,
        allowList: allowList ?? [],
      },
    });
    const data = resp.data as PodSandboxUpdateNetworkPermissionsResponse;
    if (!data.ok) {
      throw new SandboxConnectionError(
        data.errorMsg || "Failed to update network permissions",
      );
    }
  }

  /**
   * List all exposed URLs in the sandbox, keyed by port.
   */
  public async listUrls(): Promise<Record<number, string>> {
    const resp = await beamClient.request({
      method: "GET",
      url: `/api/v1/gateway/pods/${this.containerId}/urls`,
    });
    const data = resp.data as PodSandboxListUrlsResponse;
    if (!data.ok)
      throw new SandboxProcessError(data.errorMsg || "Failed to list URLs");

    const urlsByPort: Record<number, string> = {};
    for (const [port, url] of Object.entries(data.urls || {})) {
      urlsByPort[Number(port)] = url;
    }

    return urlsByPort;
  }

  /**
   * Terminate the sandbox instance.
   */
  public async terminate(): Promise<boolean> {
    const result = await super.terminate();
    if (result) {
      this.terminated = true;
    }
    return result;
  }

  /**
   * Run Python code in the sandbox.
   *
   * Parameters:
   * - code (string): The Python code to execute.
   * - blocking (boolean): Wait for completion and return response; otherwise return a SandboxProcess.
   * - cwd (string | undefined): Working directory.
   * - env (Record<string,string> | undefined): Environment variables.
   */
  public async runCode(
    code: string,
    blocking: boolean = true,
    cwd?: string,
    env?: Record<string, string>,
  ): Promise<SandboxProcessResponse | SandboxProcess> {
    const process = await this.exec(["python3", "-c", code], { cwd, env });
    if (blocking) {
      await process.wait();
      const [stdoutStr, stderrStr] = await Promise.all([
        process.stdout.read(),
        process.stderr.read(),
      ]);
      return {
        pid: process.pid,
        exitCode: process.exitCode,
        stdout: stdoutStr,
        stderr: stderrStr,
        result: stdoutStr + stderrStr,
      };
    }
    return process;
  }

  /** Run an arbitrary command in the sandbox. */
  public async exec(
    command: string | string[],
    opts?: ExecOptions,
  ): Promise<SandboxProcess> {
    if (Array.isArray(command)) {
      return this._exec(command.map((a) => shellQuote(String(a))).join(" "), opts);
    }
    return this.execShell(command, opts);
  }

  /** Run shell text in the sandbox exactly as provided. */
  public async execShell(
    command: string,
    opts?: ExecOptions,
  ): Promise<SandboxProcess> {
    return this._exec(command, opts);
  }

  private async _exec(
    shellCommand: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<SandboxProcess> {
    const resp = await beamClient.request({
      method: "POST",
      url: `/api/v1/gateway/pods/${this.containerId}/exec`,
      data: {
        command: shellCommand,
        cwd: opts?.cwd,
        env: opts?.env,
      },
    });
    const data = resp.data as PodSandboxExecResponse;
    if (!data.ok || !data.pid || data.pid <= 0) {
      throw new SandboxProcessError(data.errorMsg || "Failed to start process");
    }

    const process = new SandboxProcess(this, data.pid);
    this.processes[data.pid] = process;
    return process;
  }

  /** List all processes running in the sandbox. */
  public async listProcesses(): Promise<SandboxProcess[]> {
    const resp = await beamClient.request({
      method: "GET",
      url: `/api/v1/gateway/pods/${this.containerId}/processes`,
    });
    const data = resp.data as PodSandboxListProcessesResponse;
    if (!data.ok) {
      throw new SandboxProcessError(data.errorMsg || "Failed to list processes");
    }

    const processInfos =
      data.processes ??
      (data.pids ?? []).map((pid) => ({
        pid,
        cmd: "",
        cwd: "",
        env: [],
        exitCode: -1,
        running: true,
      }));

    this.processes = {};
    for (const processInfo of processInfos) {
      this.processes[processInfo.pid] = new SandboxProcess(this, processInfo.pid, {
        cwd: processInfo.cwd,
        command: processInfo.cmd,
        env: processInfo.env,
        exitCode: processInfo.exitCode,
        running: processInfo.running,
      });
    }

    return Object.values(this.processes);
  }

  /** Get a process handle by PID from the local cache. Call listProcesses() first to refresh from the server. */
  public getProcess(pid: number): SandboxProcess {
    const proc = this.processes[pid];
    if (!proc)
      throw new SandboxProcessError(`Process with pid ${pid} not found`);
    return proc;
  }
}

/**
 * Response object containing the results of a completed process execution.
 *
 * This class encapsulates the output and status information from a process
 * that has finished running in the sandbox.
 *
 * Attributes:
 * - pid (number): The process ID of the executed command.
 * - exitCode (number): The exit code of the process (0 typically indicates success).
 * - stdout (string): The full standard output captured for the process.
 * - stderr (string): The full standard error output captured for the process.
 * - result (string): Combined stdout and stderr output as a string.
 */
export interface SandboxProcessResponse {
  pid: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  result: string;
}

/**
 * A stream-like interface for reading process output in real-time.
 *
 * Provides an iterator interface and bulk reading capabilities.
 */
export class SandboxProcessStream {
  public process: SandboxProcess;
  private fetch_fn: () => Promise<string> | string;
  private _buffer: string = "";
  private _closed: boolean = false;
  private _last_output: string = "";

  constructor(
    process: SandboxProcess,
    fetchFn: () => Promise<string> | string,
  ) {
    this.process = process;
    this.fetch_fn = fetchFn;
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        while (true) {
          if (self._buffer.includes("\n")) {
            const idx = self._buffer.indexOf("\n");
            const line = self._buffer.slice(0, idx);
            self._buffer = self._buffer.slice(idx + 1);
            return { value: line + "\n", done: false };
          }

          if (self._closed) {
            if (self._buffer) {
              const line = self._buffer;
              self._buffer = "";
              return { value: line, done: false };
            }
            return { value: undefined as any, done: true };
          }

          const chunk = await self._fetch_next_chunk();
          if (chunk) {
            self._buffer += chunk;
          } else {
            const [exitCode] = await self.process.status();
            if (exitCode >= 0) {
              const lastChunk = await self._fetch_next_chunk();
              if (lastChunk) {
                self._buffer += lastChunk;
                continue;
              }
              self._closed = true;
            } else {
              await new Promise((r) => setTimeout(r, 100));
            }
          }
        }
      },
    } as AsyncIterableIterator<string>;
  }

  private async _fetch_next_chunk(): Promise<string> {
    const output =
      typeof this.fetch_fn === "function" ? await this.fetch_fn() : "";
    if (output === this._last_output) return "";

    let newOutput: string;
    if (output.startsWith(this._last_output)) {
      // Happy path: server buffer is append-only
      newOutput = output.slice(this._last_output.length);
    } else {
      // Buffer rotation detected: find longest suffix of _last_output
      // that matches a prefix of output (overlap detection).
      // NOTE: This is a best-effort heuristic. If new data coincidentally
      // matches a suffix of _last_output (e.g., repeated lines), the
      // overlap may be falsely detected and that data silently skipped.
      // Without server-side sequence numbers this is unavoidable; we
      // prefer this over the alternative (returning the entire buffer
      // and producing large duplicates on every rotation).
      newOutput = output;
      for (let i = 1; i < this._last_output.length; i++) {
        const suffix = this._last_output.slice(i);
        if (output.startsWith(suffix)) {
          newOutput = output.slice(suffix.length);
          break;
        }
      }
    }

    this._last_output = output;
    return newOutput;
  }

  /**
   * Fetch and return all available output at this moment.
   */
  public async read(): Promise<string> {
    let data = this._buffer;
    this._buffer = "";
    while (true) {
      const chunk = await this._fetch_next_chunk();
      if (chunk) {
        data += chunk;
      } else {
        break;
      }
    }
    return data;
  }
}

/**
 * Represents a running process within a sandbox.
 *
 * Control and monitoring capabilities for processes running in the sandbox.
 */
export class SandboxProcess {
  public sandbox_instance: SandboxInstance;
  public pid: number;
  public exitCode: number = -1;
  public cwd: string = "";
  public command: string = "";
  public env: string[] = [];
  public running: boolean = true;
  private _status: string = "";

  constructor(
    sandboxInstance: SandboxInstance,
    pid: number,
    info?: {
      cwd?: string;
      command?: string;
      env?: string[];
      exitCode?: number;
      running?: boolean;
    },
  ) {
    this.sandbox_instance = sandboxInstance;
    this.pid = pid;
    this.cwd = info?.cwd ?? "";
    this.command = info?.command ?? "";
    this.env = info?.env ?? [];
    this.exitCode = info?.exitCode ?? -1;
    this.running = info?.running ?? this.exitCode < 0;
  }

  /** Wait for the process to complete and return the exit code. */
  public async wait(): Promise<number> {
    [this.exitCode, this._status] = await this.status();
    while (this.exitCode < 0) {
      [this.exitCode, this._status] = await this.status();
      await new Promise((r) => setTimeout(r, 100));
    }
    return this.exitCode;
  }

  /** Return the latest exit code and status string. */
  public async poll(): Promise<[number, string]> {
    [this.exitCode, this._status] = await this.status();
    this.running = this.exitCode < 0;
    return [this.exitCode, this._status];
  }

  /** Kill the process. */
  public async kill(): Promise<void> {
    const resp = await beamClient.request({
      method: "POST",
      url: `api/v1/gateway/pods/${this.sandbox_instance.containerId}/kill`,
      data: { pid: this.pid },
    });
    const data = resp.data as { ok: boolean; errorMsg?: string };
    if (!data.ok)
      throw new SandboxProcessError(data.errorMsg || "Failed to kill process");
  }

  /** Get the status of the process: [exitCode, status]. */
  public async status(): Promise<[number, string]> {
    const resp = await beamClient.request({
      method: "GET",
      url: `api/v1/gateway/pods/${this.sandbox_instance.containerId}/status`,
      params: { pid: this.pid },
      timeout: 300000,
    });
    const data = resp.data as {
      ok: boolean;
      errorMsg?: string;
      status?: string;
      exitCode?: number;
    };
    if (!data.ok)
      throw new SandboxProcessError(data.errorMsg || "Failed to get status");
    return [data.exitCode ?? -1, data.status || ""];
  }

  /** Get a handle to a stream of the process's stdout. */
  public get stdout(): SandboxProcessStream {
    return new SandboxProcessStream(this, async () => {
      const resp = await beamClient.request({
        method: "GET",
        url: `api/v1/gateway/pods/${this.sandbox_instance.containerId}/stdout`,
        params: { pid: this.pid },
      });
      const data = resp.data as { ok: boolean; stdout?: string };
      return data.stdout || "";
    });
  }

  /** Get a handle to a stream of the process's stderr. */
  public get stderr(): SandboxProcessStream {
    return new SandboxProcessStream(this, async () => {
      const resp = await beamClient.request({
        method: "GET",
        url: `api/v1/gateway/pods/${this.sandbox_instance.containerId}/stderr`,
        params: { pid: this.pid },
      });
      const data = resp.data as { ok: boolean; stderr?: string };
      return data.stderr || "";
    });
  }

  /** Returns a combined stream of both stdout and stderr. */
  public get logs() {
    const self = this;
    class CombinedStream {
      _stdout = self.stdout;
      _stderr = self.stderr;
      _queue: string[] = [];
      _stdoutBuffer = "";
      _stderrBuffer = "";
      _stdoutExhausted = false;
      _stderrExhausted = false;

      async _process_stream(streamName: "stdout" | "stderr") {
        const isStdout = streamName === "stdout";
        const stream = isStdout ? this._stdout : this._stderr;
        const chunk = await (stream as any)._fetch_next_chunk();
        if (chunk) {
          if (isStdout) this._stdoutBuffer += chunk;
          else this._stderrBuffer += chunk;
          while (
            (isStdout ? this._stdoutBuffer : this._stderrBuffer).includes("\n")
          ) {
            const parts = (
              isStdout ? this._stdoutBuffer : this._stderrBuffer
            ).split("\n");
            const line = parts.shift()!;
            if (isStdout) this._stdoutBuffer = parts.join("\n");
            else this._stderrBuffer = parts.join("\n");
            this._queue.push(line + "\n");
          }
        } else {
          const [exitCode] = await self.status();
          if (exitCode >= 0) {
            const buf = isStdout ? this._stdoutBuffer : this._stderrBuffer;
            if (buf) {
              this._queue.push(buf);
              if (isStdout) this._stdoutBuffer = "";
              else this._stderrBuffer = "";
              return;
            }
            if (isStdout) this._stdoutExhausted = true;
            else this._stderrExhausted = true;
          }
        }
      }

      async _fill_queue() {
        await this._process_stream("stdout");
        await this._process_stream("stderr");
      }

      public [Symbol.asyncIterator](): AsyncIterableIterator<string> {
        const that = this;
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          async next() {
            while (true) {
              if (!that._queue.length) {
                await that._fill_queue();
                if (
                  !that._queue.length &&
                  that._stdoutExhausted &&
                  that._stderrExhausted
                ) {
                  return { value: undefined as any, done: true };
                }
                if (!that._queue.length) {
                  await new Promise((r) => setTimeout(r, 100));
                  continue;
                }
              }
              return { value: that._queue.shift()!, done: false };
            }
          },
        } as AsyncIterableIterator<string>;
      }

      public async read(): Promise<string> {
        return (await self.stdout.read()) + (await self.stderr.read());
      }
    }
    return new CombinedStream();
  }
}

/** Metadata of a file in the sandbox. */
export class SandboxFileInfo {
  public name: string;
  public isDir: boolean;
  public size: number;
  public mode: number;
  public modTime: number;
  public permissions: number;
  public owner: string;
  public group: string;

  constructor(init: {
    name: string;
    isDir: boolean;
    size: number;
    mode: number;
    modTime: number;
    permissions: number;
    owner: string;
    group: string;
  }) {
    this.name = init.name;
    this.isDir = init.isDir;
    this.size = init.size;
    this.mode = init.mode;
    this.modTime = init.modTime;
    this.permissions = init.permissions;
    this.owner = init.owner;
    this.group = init.group;
  }

  public toString(): string {
    const octal = (this.permissions & 0o7777).toString(8);
    return `SandboxFileInfo(name='${this.name}', isDir=${this.isDir}, size=${this.size}, mode=${this.mode}, modTime=${this.modTime}, permissions=${octal}, owner='${this.owner}', group='${this.group}')`;
  }
}

/** A position in a file. */
export class SandboxFilePosition {
  constructor(
    public line: number,
    public column: number,
  ) {}
}
/** A range in a file. */
export class SandboxFileSearchRange {
  constructor(
    public start: SandboxFilePosition,
    public end: SandboxFilePosition,
  ) {}
}
/** A match in a file. */
export class SandboxFileSearchMatch {
  constructor(
    public range: SandboxFileSearchRange,
    public content: string,
  ) {}
}
/** A search result in a file. */
export class SandboxFileSearchResult {
  constructor(
    public path: string,
    public matches: SandboxFileSearchMatch[],
  ) {}
}

/**
 * File system interface for managing files within a sandbox.
 *
 * Upload, download, stat, list, and manage files and directories.
 */
export class SandboxFileSystem {
  private sandbox_instance: SandboxInstance;
  constructor(sandboxInstance: SandboxInstance) {
    this.sandbox_instance = sandboxInstance;
  }

  /** Upload a local file to the sandbox. */
  public async upload(localPath: string, sandboxPath: string): Promise<void> {
    return this.uploadFile(localPath, sandboxPath);
  }

  /** Upload a local file to the sandbox. */
  public async uploadFile(
    localPath: string,
    sandboxPath: string,
  ): Promise<void> {
    await this.writeBytes(sandboxPath, fs.readFileSync(localPath));
  }

  /** Write bytes to a file in the sandbox. */
  public async writeBytes(
    sandboxPath: string,
    content: Buffer | Uint8Array | string,
    mode: number = 0o644,
  ): Promise<void> {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const resp = await beamClient.request({
      method: "POST",
      url: `api/v1/gateway/pods/${this.sandbox_instance.containerId}/files/upload`,
      data: {
        containerPath: sandboxPath,
        mode,
        data: buf.toString("base64"),
      },
    });
    const data = resp.data as { ok: boolean; errorMsg?: string };
    if (!data.ok)
      throw new SandboxFileSystemError(
        data.errorMsg || "Failed to upload file",
      );
  }

  /** Write text to a file in the sandbox. */
  public async writeText(
    sandboxPath: string,
    content: string,
    mode: number = 0o644,
  ): Promise<void> {
    return this.writeBytes(sandboxPath, Buffer.from(content, "utf8"), mode);
  }

  /** Download a file from the sandbox and return its bytes. */
  public async download(sandboxPath: string): Promise<Buffer> {
    return this.readBytes(sandboxPath);
  }

  /** Download a file from the sandbox to a local path. */
  public async downloadFile(
    sandboxPath: string,
    localPath: string,
  ): Promise<void> {
    fs.writeFileSync(localPath, await this.readBytes(sandboxPath));
  }

  /** Read a file from the sandbox as bytes. */
  public async readBytes(sandboxPath: string): Promise<Buffer> {
    const resp = await beamClient.request({
      method: "GET",
      url: `api/v1/gateway/pods/${
        this.sandbox_instance.containerId
      }/files/download/${encodeURIComponent(sandboxPath)}`,
    });
    const data = resp.data as { ok: boolean; errorMsg?: string; data?: string };
    if (!data.ok || !data.data)
      throw new SandboxFileSystemError(
        data.errorMsg || "Failed to download file",
      );
    return Buffer.from(data.data, "base64");
  }

  /** Read a file from the sandbox as UTF-8 text. */
  public async readText(sandboxPath: string): Promise<string> {
    return (await this.readBytes(sandboxPath)).toString("utf8");
  }

  /** Get the metadata of a file in the sandbox. */
  public async stat(sandboxPath: string): Promise<SandboxFileInfo> {
    return this.statFile(sandboxPath);
  }

  /** Get the metadata of a file in the sandbox. */
  public async statFile(sandboxPath: string): Promise<SandboxFileInfo> {
    const resp = await beamClient.request({
      method: "GET",
      url: `api/v1/gateway/pods/${this.sandbox_instance.containerId}/files/stat`,
      params: { containerPath: sandboxPath },
    });
    const data = resp.data as {
      ok: boolean;
      errorMsg?: string;
      fileInfo?: any;
    };
    if (!data.ok || !data.fileInfo)
      throw new SandboxFileSystemError(data.errorMsg || "Failed to stat file");
    return new SandboxFileInfo({
      name: data.fileInfo.name,
      isDir: data.fileInfo.isDir,
      size: Number(data.fileInfo.size),
      mode: Number(data.fileInfo.mode),
      modTime: Number(data.fileInfo.modTime),
      owner: data.fileInfo.owner,
      group: data.fileInfo.group,
      permissions: Number(data.fileInfo.permissions),
    });
  }

  /** List the files in a directory in the sandbox. */
  public async list(sandboxPath: string): Promise<SandboxFileInfo[]> {
    return this.listFiles(sandboxPath);
  }

  /** List the files in a directory in the sandbox. */
  public async listFiles(sandboxPath: string): Promise<SandboxFileInfo[]> {
    const resp = await beamClient.request({
      method: "GET",
      url: `/api/v1/gateway/pods/${this.sandbox_instance.containerId}/files`,
      params: { containerPath: sandboxPath },
    });
    const data = resp.data as PodSandboxListFilesResponse;
    if (!data.ok || !data.files)
      throw new SandboxFileSystemError(data.errorMsg || "Failed to list files");
    return data.files.map(
      (file: any) =>
        new SandboxFileInfo({
          name: file.name,
          isDir: !!file.isDir,
          size: Number(file.size),
          mode: Number(file.mode),
          modTime: Number(file.modTime),
          owner: file.owner,
          group: file.group,
          permissions: Number(file.permissions),
        }),
    );
  }

  /** Create a directory in the sandbox. */
  public async mkdir(sandboxPath: string): Promise<void> {
    return this.createDirectory(sandboxPath);
  }

  /** Create a directory in the sandbox. */
  public async createDirectory(sandboxPath: string): Promise<void> {
    const resp = await beamClient.request({
      method: "POST",
      url: `/api/v1/gateway/pods/${this.sandbox_instance.containerId}/directories`,
      data: { containerPath: sandboxPath, mode: 0o755 },
    });
    const data = resp.data as PodSandboxCreateDirectoryResponse;
    if (!data.ok)
      throw new SandboxFileSystemError(
        data.errorMsg || "Failed to create directory",
      );
  }

  /** Delete a directory in the sandbox. */
  public async removeDir(sandboxPath: string): Promise<void> {
    return this.deleteDirectory(sandboxPath);
  }

  /** Delete a directory in the sandbox. */
  public async deleteDirectory(sandboxPath: string): Promise<void> {
    const resp = await beamClient.request({
      method: "DELETE",
      url: `api/v1/gateway/pods/${
        this.sandbox_instance.containerId
      }/directories/${encodeURIComponent(sandboxPath)}`,
    });
    const data = resp.data as { ok: boolean; errorMsg?: string };
    if (!data.ok)
      throw new SandboxFileSystemError(
        data.errorMsg || "Failed to delete directory",
      );
  }

  /** Delete a file in the sandbox. */
  public async removeFile(sandboxPath: string): Promise<void> {
    return this.deleteFile(sandboxPath);
  }

  /** Delete a file in the sandbox. */
  public async deleteFile(sandboxPath: string): Promise<void> {
    const resp = await beamClient.request({
      method: "DELETE",
      url: `api/v1/gateway/pods/${
        this.sandbox_instance.containerId
      }/files/${encodeURIComponent(sandboxPath)}`,
    });
    const data = resp.data as { ok: boolean; errorMsg?: string };
    if (!data.ok)
      throw new SandboxFileSystemError(
        data.errorMsg || "Failed to delete file",
      );
  }

  /** Delete a file or directory in the sandbox. */
  public async remove(sandboxPath: string, opts?: { dir?: boolean }): Promise<void> {
    if (opts?.dir) return this.removeDir(sandboxPath);
    return this.removeFile(sandboxPath);
  }

  /** Replace a string in all files in a directory. */
  public async replace(
    sandboxPath: string,
    oldString: string,
    newString: string,
  ): Promise<void> {
    return this.replaceInFiles(sandboxPath, oldString, newString);
  }

  /** Replace a string in all files in a directory. */
  public async replaceInFiles(
    sandboxPath: string,
    oldString: string,
    newString: string,
  ): Promise<void> {
    const resp = await beamClient.request({
      method: "POST",
      url: `api/v1/gateway/pods/${this.sandbox_instance.containerId}/files/replace`,
      data: {
        containerPath: sandboxPath,
        pattern: oldString,
        newString: newString,
      },
    });
    const data = resp.data as { ok: boolean; errorMsg?: string };
    if (!data.ok)
      throw new SandboxFileSystemError(
        data.errorMsg || "Failed to replace in files",
      );
  }

  /** Find files matching a pattern in the sandbox. */
  public async find(
    sandboxPath: string,
    pattern: string,
  ): Promise<SandboxFileSearchResult[]> {
    return this.findInFiles(sandboxPath, pattern);
  }

  /** Find files matching a pattern in the sandbox. */
  public async findInFiles(
    sandboxPath: string,
    pattern: string,
  ): Promise<SandboxFileSearchResult[]> {
    const resp = await beamClient.request({
      method: "POST",
      url: `api/v1/gateway/pods/${this.sandbox_instance.containerId}/files/find`,
      data: { containerPath: sandboxPath, pattern },
    });
    const data = resp.data as {
      ok: boolean;
      errorMsg?: string;
      results?: any[];
    };
    if (!data.ok || !data.results)
      throw new SandboxFileSystemError(
        data.errorMsg || "Failed to find in files",
      );

    const results: SandboxFileSearchResult[] = [];
    for (const result of data.results) {
      const matches: SandboxFileSearchMatch[] = [];
      for (const match of result.matches || []) {
        matches.push(
          new SandboxFileSearchMatch(
            new SandboxFileSearchRange(
              new SandboxFilePosition(
                match.range.start.line,
                match.range.start.column,
              ),
              new SandboxFilePosition(
                match.range.end.line,
                match.range.end.column,
              ),
            ),
            match.content,
          ),
        );
      }
      results.push(new SandboxFileSearchResult(result.path, matches));
    }

    return results;
  }
}
