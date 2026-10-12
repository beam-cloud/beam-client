import { spawn } from "child_process";
import { watch, FSWatcher } from "fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { createServer, Server, Socket } from "net";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import type { VM } from "./vm";
import type {
  VMConfig,
  VMInfo,
  VMPortForwardOptions,
  VMSCPOptions,
  VMSSHOptions,
  VMSyncOptions,
  VMTunnelOptions,
  VMWaitOptions,
} from "../../types/vm";
import { checkAbort, quote, VMError } from "./vm-api";
import { VMTunnel } from "./vm-tunnel";

function run(
  program: string,
  args: string[],
  opts: { signal?: AbortSignal; inherit?: boolean } = {},
): Promise<{ code: number; stdout: string }> {
  checkAbort(opts.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      signal: opts.signal,
    });
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) =>
      reject(
        new VMError(
          `${program} failed to start: ${error.message}`,
          undefined,
          error,
        ),
      ),
    );
    child.on("close", (code) => {
      if (!opts.inherit && code !== 0)
        reject(new VMError(stderr.trim() || `${program} exited with ${code}`));
      else resolve({ code: code ?? 1, stdout });
    });
  });
}

export interface VMPortForward {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}
export interface VMSyncHandle {
  close(): Promise<void>;
  readonly done: Promise<void>;
}

/** Native SSH/SCP/rsync helpers and private TCP access. close() releases local resources only. */
export abstract class VMAccess {
  abstract readonly config: VMConfig;
  abstract readonly info: VMInfo;
  abstract readonly id: string;
  abstract readonly name: string;
  abstract runtime(): Promise<unknown>;
  abstract wait(opts?: VMWaitOptions): Promise<unknown>;
  abstract bind(port: number): Promise<void>;
  abstract keepAlive<T>(callback: (vm: this) => Promise<T>): Promise<T>;
  private local = new Set<{ close(): void | Promise<void> }>();
  private keyPreparation?: Promise<string>;

  protected async publicKey(): Promise<string> {
    if (this.config.sshPublicKey) return this.config.sshPublicKey;
    const path = await this.identity();
    return (await run("ssh-keygen", ["-y", "-f", path])).stdout.trim();
  }
  private async identity(): Promise<string> {
    if (!this.keyPreparation) this.keyPreparation = this.prepareIdentity();
    try {
      return await this.keyPreparation;
    } catch (error) {
      this.keyPreparation = undefined;
      throw error;
    }
  }
  private async prepareIdentity(): Promise<string> {
    const path = resolve(
      this.config.sshKeyPath || join(homedir(), ".beam", "ssh", "vm_ed25519"),
    );
    if (this.config.sshKeyPath) {
      await stat(path);
      return path;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await stat(path);
      return path;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    const directory = await mkdtemp(join(dirname(path), ".identity-"));
    try {
      const temporary = join(directory, "key");
      await run("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        temporary,
      ]);
      await chmod(temporary, 0o600);
      try {
        await link(temporary, path);
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
      }
      // Always derive the public key from the winning private key in a concurrent creation.
      const publicKey = (await run("ssh-keygen", ["-y", "-f", path])).stdout;
      await writeFile(join(directory, "public"), publicKey, { mode: 0o644 });
      try {
        await link(join(directory, "public"), `${path}.pub`);
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
      }
      return path;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  /** A Node Duplex stream to a private guest TCP port. No public URL is created. */
  async tunnel(port: number, opts: VMTunnelOptions = {}): Promise<VMTunnel> {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new VMError("port must be between 1 and 65535");
    await this.runtime();
    if (port === 2222) {
      if (!this.info.spec.ssh) throw new VMError("SSH is disabled for this VM");
      await this.wait({ ...opts, services: true });
    } else await this.bind(port);
    const tunnel = await VMTunnel.open(this.id, port, opts);
    this.local.add(tunnel);
    tunnel.once("close", () => this.local.delete(tunnel));
    return tunnel;
  }
  /** Forward a guest TCP port to loopback, returning the chosen local port and a close handle. */
  async portForward(
    port: number,
    opts: VMPortForwardOptions = {},
  ): Promise<VMPortForward> {
    checkAbort(opts.signal);
    await this.runtime();
    if (port !== 2222) await this.bind(port);
    const host = opts.host || "127.0.0.1";
    const connections = new Set<Socket>();
    const tunnels = new Set<VMTunnel>();
    const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
      connections.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => connections.delete(socket));
      socket.pause();
      void this.tunnel(port, opts)
        .then((tunnel) => {
          if (socket.destroyed) {
            tunnel.close();
            return;
          }
          tunnels.add(tunnel);
          tunnel.on("error", () => socket.destroy());
          tunnel.once("close", () => {
            tunnels.delete(tunnel);
            socket.destroy();
          });
          socket.once("close", () => tunnel.close());
          socket.pipe(tunnel).pipe(socket);
          socket.resume();
        })
        .catch(() => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.localPort ?? 0, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new VMError("Unable to bind local TCP port");
    }
    let closed = false;
    const abort = () => {
      void handle.close();
    };
    const handle: VMPortForward = {
      host,
      port: address.port,
      url: `tcp://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
      close: async () => {
        if (closed) return;
        closed = true;
        opts.signal?.removeEventListener("abort", abort);
        for (const socket of connections) socket.destroy();
        for (const tunnel of tunnels) tunnel.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        this.local.delete(handle);
      },
    };
    opts.signal?.addEventListener("abort", abort, { once: true });
    this.local.add(handle);
    return handle;
  }
  private async sshConnection(
    opts: VMSSHOptions = {},
  ): Promise<{ forward: VMPortForward; key: string; args: string[] }> {
    await this.runtime();
    if (!this.info.spec.ssh) throw new VMError("SSH is disabled for this VM");
    await this.wait({ services: true, signal: opts.signal });
    const key = await this.identity();
    const forward = await this.portForward(2222, opts);
    const args = [
      "-i",
      key,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${join(dirname(key), "known_hosts")}`,
      "-o",
      `HostKeyAlias=${this.id}`,
    ];
    return { forward, key, args };
  }
  /** Interactive OpenSSH, or execute literal argv remotely. Requires local OpenSSH. */
  async ssh(
    command?: string | string[],
    opts: VMSSHOptions = {},
  ): Promise<number> {
    const { forward, args } = await this.sshConnection(opts);
    try {
      return (
        await run(
          "ssh",
          [
            ...args,
            "-p",
            String(forward.port),
            "--",
            "root@127.0.0.1",
            ...(command === undefined
              ? []
              : [
                  typeof command === "string"
                    ? command
                    : command.map(quote).join(" "),
                ]),
          ],
          { signal: opts.signal, inherit: true },
        )
      ).code;
    } finally {
      await forward.close();
    }
  }
  /** Copy one local and one remote path. Prefix the remote path with vm:, the VM name, or its ID. */
  async scp(
    source: string,
    destination: string,
    opts: VMSCPOptions = {},
  ): Promise<void> {
    const remote = (path: string) =>
      ["vm:", `${this.name}:`, `${this.id}:`].find((prefix) =>
        path.startsWith(prefix),
      );
    const sourcePrefix = remote(source),
      destinationPrefix = remote(destination);
    if (!!sourcePrefix === !!destinationPrefix)
      throw new VMError(
        "Specify exactly one remote path, such as vm:/workspace/file",
      );
    const { forward, args } = await this.sshConnection(opts);
    const converted = (path: string, prefix?: string) =>
      prefix ? `root@127.0.0.1:${path.slice(prefix.length)}` : path;
    try {
      await run(
        "scp",
        [
          ...args,
          "-P",
          String(forward.port),
          ...(opts.recursive ? ["-r"] : []),
          "--",
          converted(source, sourcePrefix),
          converted(destination, destinationPrefix),
        ],
        { signal: opts.signal },
      );
    } finally {
      await forward.close();
    }
  }
  /** Sync a directory with rsync over the private SSH tunnel, optionally watching for edits. */
  async sync(directory = ".", opts: VMSyncOptions = {}): Promise<VMSyncHandle> {
    const localPath = resolve(directory);
    if (!(await stat(localPath)).isDirectory())
      throw new VMError("sync requires a local directory");
    const remotePath = opts.remotePath || "/workspace";
    if (!remotePath.startsWith("/"))
      throw new VMError("remotePath must be an absolute guest directory");
    const { forward, args } = await this.sshConnection(opts);
    const ssh = ["ssh", ...args, "-p", String(forward.port)]
      .map(quote)
      .join(" ");
    const controller = new AbortController();
    const doSync = () =>
      this.keepAlive(() =>
        run(
          "rsync",
          [
            "-az",
            ...(opts.exclude || [".git"]).flatMap((pattern) => [
              "--exclude",
              pattern,
            ]),
            "-e",
            ssh,
            "--",
            `${localPath}/`,
            `root@127.0.0.1:${quote(remotePath + "/")}`,
          ],
          { signal: controller.signal },
        ).then(() => {}),
      );
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: Promise<void> | undefined;
    let queued = false,
      closed = false;
    let resolveDone!: () => void, rejectDone!: (error: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    // Errors remain observable through done without becoming unhandled before callers attach.
    void done.catch(() => {});
    const abort = () => {
      void handle.close();
    };
    const handle: VMSyncHandle = {
      done,
      close: async () => {
        if (closed) return;
        closed = true;
        controller.abort();
        watcher?.close();
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        await active?.catch(() => {});
        await forward.close();
        this.local.delete(handle);
        resolveDone();
      },
    };
    try {
      await doSync();
      if (!opts.watch) {
        await handle.close();
        return handle;
      }
      watcher = watch(localPath, { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (active) {
            queued = true;
            return;
          }
          active = (async () => {
            do {
              queued = false;
              await doSync();
            } while (queued && !closed);
          })();
          void active
            .catch((error) => {
              // Closing intentionally aborts the in-flight rsync; it is completion,
              // while unexpected transfer failures remain visible through done.
              if (!closed) rejectDone(error);
              void handle.close();
            })
            .finally(() => {
              active = undefined;
            });
        }, 200);
      });
      watcher.on("error", (error) => {
        rejectDone(error);
        void handle.close();
      });
      opts.signal?.addEventListener("abort", abort, { once: true });
      this.local.add(handle);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  /** Release local tunnels and watchers. The persistent VM keeps its current lifecycle state. */
  async close(): Promise<void> {
    await Promise.all([...this.local].map((resource) => resource.close()));
    this.local.clear();
  }
}
