import beamClient, { Image, Sandbox, SandboxConnectionError } from "../lib";
import { EStubType } from "../lib/types/stub";

describe("sandbox prepared runtime cache", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  test("keeps the published 1.0.18 benchmark cache identity", () => {
    const sandbox = new Sandbox({
      name: "computesdk-benchmarks",
      image: Image.fromRegistry("node:24-slim"),
      keepWarmSeconds: 300,
    });
    sandbox.stub.config.entrypoint = ["tail", "-f", "/dev/null"];
    expect(sandbox.stub.preparationCacheKey(EStubType.Sandbox, ["*"]))
      .toBe("ef9c9e6feee21f47b23a089ba82db0c5a9a1a423c97885ea03d8ce02dda3c9e1");
  });

  test("a fresh client creates 100 distinct sandboxes without preparing a cached runtime", async () => {
    const sandbox = new Sandbox({ name: "cached", image: Image.fromRegistry("node:24") });
    const prepare = jest.spyOn(sandbox.stub, "prepareRuntime");
    let next = 0;
    const request = jest.spyOn(beamClient, "request").mockImplementation(async () => ({
      data: { ok: true, stubId: "cached-stub", containerId: `sandbox-${++next}` },
    }));

    const instances = await Promise.all(Array.from({ length: 100 }, () => sandbox.create({ waitForReady: false })));

    expect(new Set(instances.map((s) => s.containerId)).size).toBe(100);
    expect(prepare).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(100);
    const keys = request.mock.calls.map(([r]) => (r.headers as Record<string, string>)["Grpc-Metadata-Preparation-Cache-Key"]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(sandbox.stub.stubId).toBe("cached-stub");
    expect(sandbox.stub.runtimeReady).toBe(true);

    await sandbox.create({ waitForReady: false });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ data: { stubId: "cached-stub" }, headers: undefined }));
  });

  test("a cold burst prepares once and registers the same key for a fresh client", async () => {
    const sandbox = new Sandbox({ name: "cold", image: Image.fromRegistry("node:24") });
    const build = jest.spyOn(sandbox.stub.config.image, "build").mockResolvedValue({
      success: true, imageId: "image-1", pythonVersion: "python3.10",
    });
    const sync = jest.spyOn(sandbox.stub.syncer, "sync").mockResolvedValue({ success: true, objectId: "object-1" });
    let cachedKey: string | undefined;
    let next = 0;
    const request = jest.spyOn(beamClient, "request").mockImplementation(async (r) => {
      const key = (r.headers as Record<string, string> | undefined)?.["Grpc-Metadata-Preparation-Cache-Key"];
      if (r.url === "/api/v1/gateway/stubs") {
        cachedKey = key;
        return { data: { ok: true, stubId: "prepared-stub" } };
      }
      if (r.data?.stubId || (cachedKey && key === cachedKey)) {
        return { data: { ok: true, stubId: "prepared-stub", containerId: `sandbox-${++next}` } };
      }
      return { data: { ok: false, errorMsg: "load stub : not found" } };
    });

    const instances = await Promise.all(Array.from({ length: 100 }, () => sandbox.create({ waitForReady: false })));
    const firstKey = (request.mock.calls[0][0].headers as Record<string, string>)["Grpc-Metadata-Preparation-Cache-Key"];
    expect(cachedKey).toBe(firstKey);
    expect(build).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([r]) => r.url === "/api/v1/gateway/stubs")).toHaveLength(1);
    expect(new Set(instances.map((s) => s.containerId)).size).toBe(100);

    const fresh = new Sandbox({ name: "cold", image: Image.fromRegistry("node:24") });
    const prepare = jest.spyOn(fresh.stub, "prepareRuntime");
    await fresh.create({ waitForReady: false });
    expect(prepare).not.toHaveBeenCalled();
    expect(fresh.stub.stubId).toBe("prepared-stub");
  });

  test("independent clients share preparation, not sandbox instances", async () => {
    let next = 0;
    const request = jest.spyOn(beamClient, "request").mockImplementation(async () => ({
      data: { ok: true, stubId: "shared-stub", containerId: `sandbox-${++next}` },
    }));
    const clients = Array.from({ length: 100 }, () => new Sandbox({ name: "shared" }));
    const preparations = clients.map((s) => jest.spyOn(s.stub, "prepareRuntime"));
    const instances = await Promise.all(clients.map((s) => s.create({ waitForReady: false })));
    expect(new Set(instances.map((s) => s.containerId)).size).toBe(100);
    expect(request).toHaveBeenCalledTimes(100);
    for (const prepare of preparations) expect(prepare).not.toHaveBeenCalled();
    expect(new Set(request.mock.calls.map(([r]) =>
      (r.headers as Record<string, string>)["Grpc-Metadata-Preparation-Cache-Key"],
    )).size).toBe(1);
  });

  test("the gateway's empty-stub UUID response is a preparation cache miss", async () => {
    const sandbox = new Sandbox({ name: "cache-miss" });
    const prepare = jest.spyOn(sandbox.stub, "prepareRuntime").mockImplementation(async () => {
      sandbox.stub.stubId = "prepared";
      return true;
    });
    jest.spyOn(beamClient, "request")
      .mockResolvedValueOnce({ data: { ok: false, errorMsg: 'load stub : pq: invalid input syntax for type uuid: ""' } })
      .mockResolvedValueOnce({ data: { ok: true, stubId: "prepared", containerId: "sandbox-prepared" } });
    await expect(sandbox.create({ waitForReady: false })).resolves.toMatchObject({ containerId: "sandbox-prepared" });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  test.each([
    { ok: false, stubId: "existing", errorMsg: "insufficient credits" },
    { ok: false, errorMsg: "permission denied" },
    { ok: false, errorMsg: "load stub : context deadline exceeded" },
    { ok: false, errorMsg: "load stub cached: database unavailable" },
  ])("does not reprepare after an admission failure: $errorMsg", async (data) => {
    const sandbox = new Sandbox({ name: "denied" });
    const prepare = jest.spyOn(sandbox.stub, "prepareRuntime");
    const request = jest.spyOn(beamClient, "request").mockResolvedValue({ data });
    await expect(sandbox.create()).rejects.toThrow(data.errorMsg);
    expect(prepare).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("retries failed preparation on the next create", async () => {
    const sandbox = new Sandbox({ name: "retry" });
    const prepare = jest.spyOn(sandbox.stub, "prepareRuntime")
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => { sandbox.stub.stubId = "retried"; return true; });
    jest.spyOn(beamClient, "request").mockImplementation(async (r) => ({
      data: r.data?.stubId
        ? { ok: true, stubId: "retried", containerId: "sandbox-retried" }
        : { ok: false, errorMsg: "load stub : not found" },
    }));
    await expect(sandbox.create({ waitForReady: false })).rejects.toBeInstanceOf(SandboxConnectionError);
    await expect(sandbox.create({ waitForReady: false })).resolves.toMatchObject({ containerId: "sandbox-retried" });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  test.each(["HTTP 401: unauthorized", "HTTP 503: unavailable", "ECONNRESET"])(
    "does not prepare or retry after a failed cache request: %s", async (message) => {
      const sandbox = new Sandbox({ name: "request-failed" });
      const prepare = jest.spyOn(sandbox.stub, "prepareRuntime");
      const request = jest.spyOn(beamClient, "request").mockRejectedValue(new Error(message));
      await expect(sandbox.create({ waitForReady: false })).rejects.toThrow(message);
      expect(prepare).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  test("still waits for readiness by default on a cache hit", async () => {
    const request = jest.spyOn(beamClient, "request")
      .mockResolvedValueOnce({ data: { ok: true, stubId: "cached", containerId: "sandbox-cached" } })
      .mockResolvedValueOnce({ data: { ok: true } });
    await new Sandbox({ name: "ready" }).create();
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ url: "api/v1/gateway/pods/sandbox-cached/connect" }));
  });

  test("local file synchronization bypasses the shared cache", async () => {
    const sandbox = new Sandbox({ name: "local" }, true);
    const prepare = jest.spyOn(sandbox.stub, "prepareRuntime").mockResolvedValue(true);
    const request = jest.spyOn(beamClient, "request").mockResolvedValue({ data: { ok: true, containerId: "sandbox-local" } });
    await sandbox.create({ waitForReady: false });
    expect(prepare).toHaveBeenCalledWith(undefined, EStubType.Sandbox, true, undefined);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ headers: undefined }));
  });

  test("cache identity includes runtime configuration and entrypoint", () => {
    const key = (config: ConstructorParameters<typeof Sandbox>[0]) => new Sandbox(config).stub.preparationCacheKey(EStubType.Sandbox, ["*"]);
    const config = { name: "identity", image: Image.fromRegistry("node:24") };
    const original = key(config);
    expect(key(config)).toBe(original);
    for (const change of [
      { image: Image.fromRegistry("node:22") }, { cpu: 2 }, { memory: 512 },
      { env: { SECRET: "value" } }, { allowList: ["8.8.8.8/32"] },
      { secrets: [{ name: "SECRET" }] }, { entrypoint: ["sleep", "100"] }, { app: "other" },
    ]) {
      expect(key({ ...config, ...change })).not.toBe(original);
    }
  });
});
