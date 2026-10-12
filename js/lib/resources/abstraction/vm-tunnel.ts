import { randomUUID } from "crypto";
import { Duplex } from "stream";
import WebSocket from "ws";
import { beamOpts } from "../../client";
import type { VMTunnelOptions } from "../../types/vm";
import { VMError, vmBasePath } from "./vm-api";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
function uuidBytes(id: string): Buffer {
  return Buffer.from(id.replace(/-/g, ""), "hex");
}
function bytesUUID(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A private TCP byte stream using beta9's resumable protocol and exactly-once request acknowledgements. */
export class VMTunnel extends Duplex {
  readonly session = randomUUID();
  private socket?: WebSocket;
  private readId = randomUUID();
  private readAck = ZERO_UUID;
  private inputAck = ZERO_UUID;
  private pendingInput?: {
    id: string;
    frame: Buffer | string;
    callback: (error?: Error | null) => void;
  };
  private pendingOutput = false;
  private wantRead = false;
  private sentRead?: string;
  private recoverySince = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private abort?: () => void;
  readonly ready: Promise<void>;

  constructor(
    private url: string,
    private opts: VMTunnelOptions = {},
  ) {
    super({ allowHalfOpen: true });
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    if (opts.signal) {
      this.abort = () => this.destroy(new VMError("Tunnel aborted"));
      if (opts.signal.aborted) {
        this.abort();
        return;
      }
      opts.signal.addEventListener("abort", this.abort, { once: true });
    }
    this.connect();
  }
  static async open(
    vmId: string,
    port: number,
    opts: VMTunnelOptions = {},
  ): Promise<VMTunnel> {
    const base = await vmBasePath();
    const url = new URL(
      `${base}/${encodeURIComponent(vmId)}/tunnel/${port}`,
      beamOpts.gatewayUrl,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const tunnel = new VMTunnel(url.toString(), opts);
    // ready is the caller's initial error channel; stream errors are still observable afterward.
    const initialError = () => {};
    tunnel.on("error", initialError);
    try {
      await tunnel.ready;
      return tunnel;
    } finally {
      tunnel.removeListener("error", initialError);
    }
  }
  private connect(): void {
    if (this.destroyed) return;
    const url = new URL(this.url);
    url.searchParams.set("protocol", "2");
    url.searchParams.set("session", this.session);
    const socket = new WebSocket(url.toString(), {
      headers: { Authorization: `Bearer ${beamOpts.token}` },
      handshakeTimeout: this.opts.timeoutMs ?? 30_000,
    });
    this.socket = socket;
    let fatal = false;
    socket.on("unexpected-response", (_request, response) => {
      fatal = [400, 401, 403, 404, 410, 501].includes(response.statusCode || 0);
      response.resume();
      if (fatal)
        this.destroy(
          new VMError(
            `Tunnel refused (HTTP ${response.statusCode})`,
            response.statusCode,
          ),
        );
      socket.terminate();
    });
    socket.on("open", () => {
      this.sentRead = undefined;
      this.readyResolve();
      if (this.pendingInput) this.send(this.pendingInput.frame);
      if (this.wantRead && !this.pendingOutput) this.requestRead();
    });
    socket.on("message", (data, binary) => {
      try {
        this.recoverySince = 0;
        this.attempt = 0;
        if (binary) {
          const frame = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
          if (
            frame.length < 16 ||
            bytesUUID(frame.subarray(0, 16)) !== this.readId ||
            this.pendingOutput
          )
            throw new VMError("Invalid tunnel output frame");
          this.pendingOutput = true;
          // Ack only after the local reader accepts output; honor Node backpressure.
          if (this.push(frame.subarray(16))) this.finishRead();
          return;
        }
        const control = JSON.parse(data.toString()) as {
          type: string;
          id: string;
        };
        if (control.type === "input" && control.id === this.pendingInput?.id) {
          const pending = this.pendingInput;
          this.pendingInput = undefined;
          this.inputAck = pending.id;
          pending.callback();
          return;
        }
        if (control.id !== this.readId)
          throw new VMError("Invalid tunnel acknowledgement");
        if (control.type === "eof") {
          this.push(null);
          this.destroy();
          return;
        }
        if (control.type !== "output")
          throw new VMError("Invalid tunnel control");
        this.finishRead();
      } catch (error) {
        this.destroy(
          error instanceof Error ? error : new VMError(String(error)),
        );
      }
    });
    socket.on("error", () => {
      socket.terminate();
    });
    socket.on("close", () => {
      if (this.destroyed || fatal || this.socket !== socket) return;
      this.socket = undefined;
      this.recoverySince ||= Date.now();
      if (Date.now() - this.recoverySince >= 120_000) {
        this.destroy(
          new VMError("Tunnel did not reconnect within two minutes"),
        );
        return;
      }
      this.retry = setTimeout(
        () => this.connect(),
        Math.min(5000, 100 * 2 ** this.attempt++),
      );
    });
  }
  private send(frame: string | Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(frame, (error) => {
        if (error) this.socket?.terminate();
      });
  }
  private requestRead(): void {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      this.sentRead === this.readId
    )
      return;
    this.sentRead = this.readId;
    this.send(
      JSON.stringify({ type: "read", id: this.readId, ack: this.readAck }),
    );
  }
  private finishRead(): void {
    this.readAck = this.readId;
    this.readId = randomUUID();
    this.pendingOutput = false;
    if (this.wantRead) this.requestRead();
  }
  _read(): void {
    this.wantRead = true;
    if (this.pendingOutput) this.finishRead();
    else this.requestRead();
  }
  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    // The gateway bounds frames to 64 KiB of input. Split larger Node writes and acknowledge each piece.
    let offset = 0;
    const next = (error?: Error | null) => {
      if (error) {
        callback(error);
        return;
      }
      if (offset >= chunk.length) {
        callback();
        return;
      }
      const part = chunk.subarray(offset, offset + 65536);
      offset += part.length;
      const id = randomUUID();
      const frame = Buffer.concat([
        uuidBytes(id),
        uuidBytes(this.inputAck),
        part,
      ]);
      this.pendingInput = { id, frame, callback: next };
      this.send(frame);
    };
    next();
  }
  _final(callback: (error?: Error | null) => void): void {
    const id = randomUUID();
    const frame = JSON.stringify({ type: "eof", id, ack: this.inputAck });
    this.pendingInput = { id, frame, callback };
    this.send(frame);
  }
  _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.abort) this.opts.signal?.removeEventListener("abort", this.abort);
    this.readyReject(error || new VMError("Tunnel closed before connecting"));
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      // Explicit close releases the worker's reconnect lease, rather than waiting for expiry.
      socket.send(JSON.stringify({ type: "close", id: randomUUID() }), () =>
        socket.close(),
      );
      const timer = setTimeout(() => socket.terminate(), 1000);
      timer.unref();
    } else socket?.terminate();
    this.pendingInput?.callback(error || new VMError("Tunnel closed"));
    this.pendingInput = undefined;
    callback(error);
  }
  close(): void {
    this.destroy();
  }
}
