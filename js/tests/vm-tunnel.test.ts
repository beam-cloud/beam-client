import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "net";
import { once } from "events";
import { VMTunnel } from "../lib/resources/abstraction/vm-tunnel";
import { VM } from "../lib/resources/abstraction/vm";
import { Duplex } from "stream";
import { beamOpts } from "../lib";

function fromBytes(bytes: Buffer): string {
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function toBytes(id: string): Buffer {
  return Buffer.from(id.replace(/-/g, ""), "hex");
}

test("private tunnels replay lost input acknowledgements without duplicating bytes, handle large writes, and release sessions", async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, "listening");
  const written: Buffer[] = [];
  const requests = new Set<string>();
  let pending: { socket: WebSocket; id: string } | undefined;
  let lostAck = false;
  let closes = 0;
  let sessions: string[] = [];
  const output: Buffer[] = [];
  const deliver = () => {
    if (
      !pending ||
      !output.length ||
      pending.socket.readyState !== WebSocket.OPEN
    )
      return;
    const read = pending;
    pending = undefined;
    read.socket.send(Buffer.concat([toBytes(read.id), output.shift()!]));
  };
  server.on("connection", (socket, request) => {
    sessions.push(
      new URL(request.url!, "http://localhost").searchParams.get("session")!,
    );
    socket.on("message", (data, binary) => {
      if (binary) {
        const frame = data as Buffer;
        const id = fromBytes(frame.subarray(0, 16));
        if (!requests.has(id)) {
          requests.add(id);
          written.push(frame.subarray(32));
          output.push(frame.subarray(32));
        }
        if (!lostAck) {
          lostAck = true;
          pending = undefined;
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: "input", id }));
        deliver();
        return;
      }
      const control = JSON.parse(data.toString());
      if (control.type === "read") {
        pending = { socket, id: control.id };
        deliver();
      }
      if (control.type === "close") {
        closes++;
        socket.close();
      }
      if (control.type === "eof")
        socket.send(JSON.stringify({ type: "input", id: control.id }));
    });
  });
  const previous = { ...beamOpts };
  beamOpts.gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  beamOpts.workspaceId = "workspace";
  beamOpts.token = "test-token";
  let tunnel: VMTunnel | undefined;
  try {
    tunnel = await VMTunnel.open("vm-test", 3000);
    tunnel.on("error", () => {});
    const received: Buffer[] = [];
    tunnel.on("data", (chunk) => received.push(chunk));
    const input = Buffer.alloc(200_000, "a");
    await new Promise<void>((resolve, reject) =>
      tunnel!.write(input, (error) => (error ? reject(error) : resolve())),
    );
    const deadline = Date.now() + 5000;
    while (
      Buffer.concat(received).length < input.length &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(Buffer.concat(written)).toEqual(input);
    expect(Buffer.concat(received)).toEqual(input);
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions).size).toBe(1);
    tunnel.close();
    await once(tunnel, "close");
    const closeDeadline = Date.now() + 1000;
    while (!closes && Date.now() < closeDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closes).toBe(1);
  } finally {
    tunnel?.destroy();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    Object.assign(beamOpts, previous);
  }
}, 10_000);

test("an aborted tunnel cancels connection establishment", async () => {
  const controller = new AbortController();
  controller.abort();
  const tunnel = new VMTunnel("ws://127.0.0.1:1", {
    signal: controller.signal,
  });
  tunnel.on("error", () => {});
  await expect(tunnel.ready).rejects.toThrow("Tunnel aborted");
});


test("SSH waits for a greeting and retries early closure without sending client input", async () => {
  const streams: Duplex[] = [];
  const open = jest.spyOn(VMTunnel, "open").mockImplementation(async () => {
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(new Error("no client input expected")); } });
    (stream as any).close = () => stream.destroy();
    streams.push(stream);
    if (streams.length === 1) setImmediate(() => stream.destroy());
    else setImmediate(() => stream.push(Buffer.from("SSH-2.0-test\r\n")));
    return stream as VMTunnel;
  });
  const vm = new VM({ ssh: true });
  jest.spyOn(vm, "runtime").mockResolvedValue({ containerId: "runtime" } as any);
  jest.spyOn(vm, "wait").mockResolvedValue(vm);
  Object.defineProperty(vm, "info", { value: { id: "vm-test", spec: { ssh: true } } });
  try {
    const tunnel = await vm.tunnel(2222, { timeoutMs: 1000 });
    expect(open).toHaveBeenCalledTimes(2);
    expect(tunnel.read().toString()).toBe("SSH-2.0-test\r\n");
    tunnel.destroy();
  } finally {
    for (const stream of streams) stream.destroy();
    jest.restoreAllMocks();
  }
});
