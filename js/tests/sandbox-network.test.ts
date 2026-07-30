import beamClient from "../lib";
import { Sandbox, SandboxConnectionError, SandboxInstance } from "../lib/resources/abstraction/sandbox";
import { EStubType } from "../lib/types/stub";

describe("Sandbox network parity", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("rejects sandbox configs that set both blockNetwork and allowList", () => {
    expect(() => {
      new Sandbox({
        name: "networked-sandbox",
        blockNetwork: true,
        allowList: ["8.8.8.8/32"],
      });
    }).toThrow(
      "Cannot specify both 'blockNetwork=true' and 'allowList'. Use 'allowList' with CIDR notation to allow specific ranges, or use 'blockNetwork=true' to block all outbound traffic."
    );
  });

  test("includes allowList in stub creation requests", async () => {
    const requestMock = jest.spyOn(beamClient, "request").mockResolvedValue({
      data: {
        ok: true,
        stubId: "stub-123",
      },
    });

    const sandbox = new Sandbox({
      name: "networked-sandbox",
      allowList: ["8.8.8.8/32"],
    });

    sandbox.stub.imageAvailable = true;
    sandbox.stub.filesSynced = true;
    sandbox.stub.objectId = "object-123";
    sandbox.stub.config.image.id = "image-123";

    await expect(
      sandbox.stub.prepareRuntime(undefined, EStubType.Sandbox, true, ["*"])
    ).resolves.toBe(true);

    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "/api/v1/gateway/stubs",
        data: expect.objectContaining({
          block_network: false,
          allow_list: ["8.8.8.8/32"],
        }),
      })
    );
  });

  test("creates from a prepared stub without rebuilding or syncing", async () => {
    const sandbox = new Sandbox({ name: "cached-sandbox" });
    const buildMock = jest.spyOn(sandbox.stub.config.image, "build");
    const syncMock = jest.spyOn(sandbox.stub.syncer, "sync");
    const requestMock = jest
      .spyOn(beamClient, "request")
      .mockImplementation(async (config) => {
        if (config.url?.endsWith("/connect")) {
          return { data: { ok: true } };
        }
        return {
          data: {
            ok: true,
            containerId: "sandbox-1",
            stubId: "stub-cached",
          },
        };
      });

    await expect(sandbox.create()).resolves.toMatchObject({
      containerId: "sandbox-1",
      stubId: "stub-cached",
    });

    expect(sandbox.stub.stubId).toBe("stub-cached");
    expect(buildMock).not.toHaveBeenCalled();
    expect(syncMock).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "api/v1/gateway/pods",
        data: {},
        headers: {
          "Grpc-Metadata-Preparation-Cache-Key": expect.stringMatching(
            /^[0-9a-f]{64}$/
          ),
        },
      })
    );
  });

  test("can return before readiness when the next operation waits for it", async () => {
    const requestMock = jest.spyOn(beamClient, "request").mockResolvedValue({
      data: {
        ok: true,
        containerId: "sandbox-1",
        stubId: "stub-cached",
      },
    });

    await expect(
      new Sandbox({ name: "cached-sandbox" }).create({ waitForReady: false })
    ).resolves.toMatchObject({ containerId: "sandbox-1" });

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: "api/v1/gateway/pods" })
    );
  });

  test("terminates by ID without connecting first", async () => {
    const requestMock = jest.spyOn(beamClient, "request").mockResolvedValue({
      data: { ok: true },
    });

    await expect(Sandbox.terminate("sandbox-1")).resolves.toBe(true);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith({
      method: "POST",
      url: "api/v1/gateway/containers/sandbox-1/stop",
      data: {},
    });
  });

  test("does not prepare again when a prepared sandbox cannot be scheduled", async () => {
    const sandbox = new Sandbox({ name: "cached-sandbox" });
    const prepareMock = jest.spyOn(sandbox.stub, "prepareRuntime");
    jest.spyOn(beamClient, "request").mockResolvedValue({
      data: {
        ok: false,
        errorMsg: "cpu quota exceeded",
        stubId: "stub-cached",
      },
    });

    await expect(sandbox.create()).rejects.toThrow("cpu quota exceeded");
    expect(prepareMock).not.toHaveBeenCalled();
  });

  test("skips file sync for an ignored workspace and caches the stub", async () => {
    const sandbox = new Sandbox({ name: "empty-workspace" });
    sandbox.stub.imageAvailable = true;
    sandbox.stub.config.image.id = "image-123";
    const syncMock = jest.spyOn(sandbox.stub.syncer, "sync");
    const requestMock = jest
      .spyOn(beamClient, "request")
      .mockResolvedValue({ data: { ok: true, stubId: "stub-new" } });

    await expect(
      sandbox.stub.prepareRuntime(undefined, EStubType.Sandbox, true, ["*"])
    ).resolves.toBe(true);

    expect(syncMock).not.toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "/api/v1/gateway/stubs",
        data: expect.objectContaining({ object_id: "" }),
        headers: {
          "Grpc-Metadata-Preparation-Cache-Key": expect.stringMatching(
            /^[0-9a-f]{64}$/
          ),
        },
      })
    );
  });

  test("updates network permissions with the sandbox update endpoint", async () => {
    const requestMock = jest.spyOn(beamClient, "request").mockResolvedValue({
      data: {
        ok: true,
        errorMsg: "",
      },
    });

    const instance = new SandboxInstance(
      {
        containerId: "sandbox-123",
        stubId: "stub-123",
        url: "",
        ok: true,
        errorMsg: "",
      },
      new Sandbox({ name: "networked-sandbox" })
    );

    await expect(instance.updateNetworkPermissions(true)).resolves.toBeUndefined();

    expect(requestMock).toHaveBeenCalledWith({
      method: "POST",
      url: "/api/v1/gateway/pods/sandbox-123/network/update",
      data: {
        stubId: "stub-123",
        blockNetwork: true,
        allowList: [],
      },
    });
  });

  test("rejects conflicting network permission updates before making a request", async () => {
    const requestMock = jest.spyOn(beamClient, "request");

    const instance = new SandboxInstance(
      {
        containerId: "sandbox-123",
        stubId: "stub-123",
        url: "",
        ok: true,
        errorMsg: "",
      },
      new Sandbox({ name: "networked-sandbox" })
    );

    await expect(
      instance.updateNetworkPermissions(true, ["8.8.8.8/32"])
    ).rejects.toThrow(
      "Cannot specify both 'blockNetwork=true' and 'allowList'. Use 'allowList' with CIDR notation to allow specific ranges, or use 'blockNetwork=true' to block all outbound traffic."
    );

    expect(requestMock).not.toHaveBeenCalled();
  });

  test("rejects blockNetwork=true with empty allowList", async () => {
    const requestMock = jest.spyOn(beamClient, "request");

    const instance = new SandboxInstance(
      {
        containerId: "sandbox-123",
        stubId: "stub-123",
        url: "",
        ok: true,
        errorMsg: "",
      },
      new Sandbox({ name: "networked-sandbox" })
    );

    await expect(
      instance.updateNetworkPermissions(true, [])
    ).rejects.toThrow(
      "Cannot specify both 'blockNetwork=true' and 'allowList'. Use 'allowList' with CIDR notation to allow specific ranges, or use 'blockNetwork=true' to block all outbound traffic."
    );

    expect(requestMock).not.toHaveBeenCalled();
  });

  test("returns exposed URLs keyed by port", async () => {
    jest.spyOn(beamClient, "request").mockResolvedValue({
      data: {
        ok: true,
        urls: {
          "3000": "https://3000.example.com",
          "8080": "https://8080.example.com",
        },
        errorMsg: "",
      },
    });

    const instance = new SandboxInstance(
      {
        containerId: "sandbox-123",
        stubId: "stub-123",
        url: "",
        ok: true,
        errorMsg: "",
      },
      new Sandbox({ name: "networked-sandbox" })
    );

    await expect(instance.listUrls()).resolves.toEqual({
      3000: "https://3000.example.com",
      8080: "https://8080.example.com",
    });
  });

  test("shares runtime preparation across concurrent sandbox creates", async () => {
    const sandbox = new Sandbox({ name: "concurrent-sandbox" });
    let releasePreparation!: (prepared: boolean) => void;
    const preparation = new Promise<boolean>((resolve) => {
      releasePreparation = (prepared) => {
        sandbox.stub.stubId = "stub-1";
        sandbox.stub.runtimeReady = prepared;
        resolve(prepared);
      };
    });
    const prepareRuntimeMock = jest
      .spyOn(sandbox.stub, "prepareRuntime")
      .mockReturnValue(preparation);
    let nextContainer = 0;
    const requestMock = jest
      .spyOn(beamClient, "request")
      .mockImplementation(async (config) => {
        if (config.url === "api/v1/gateway/pods") {
          if (!config.data?.stubId) {
            return { data: { ok: false } };
          }
          nextContainer += 1;
          return {
            data: {
              ok: true,
              containerId: `sandbox-${nextContainer}`,
            },
          };
        }
        if (config.url?.endsWith("/connect")) {
          return { data: { ok: true } };
        }
        throw new Error(`Unexpected request: ${config.url}`);
      });

    const firstCreate = sandbox.create();
    const secondCreate = sandbox.create();

    await new Promise((resolve) => setImmediate(resolve));
    expect(prepareRuntimeMock).toHaveBeenCalledTimes(1);
    releasePreparation(true);

    const instances = await Promise.all([firstCreate, secondCreate]);
    expect(instances.map((instance) => instance.containerId)).toEqual([
      "sandbox-1",
      "sandbox-2",
    ]);
    expect(requestMock).toHaveBeenCalledTimes(6);
  });

  test("returns inline exec results without follow-up requests", async () => {
    const requestMock = jest.spyOn(beamClient, "request").mockResolvedValue({
      data: {
        ok: true,
        pid: 7,
        done: true,
        exitCode: 0,
        stdout: "v20.0.0\n",
        stderr: "",
      },
    });

    const instance = new SandboxInstance(
      {
        containerId: "sandbox-123",
        stubId: "stub-123",
        url: "",
        ok: true,
        errorMsg: "",
      },
      new Sandbox({ name: "networked-sandbox" })
    );

    const process = await instance.exec(["node", "-v"], { wait: true });

    await expect(process.wait()).resolves.toBe(0);
    await expect(process.stdout.read()).resolves.toBe("v20.0.0\n");
    await expect(process.stderr.read()).resolves.toBe("");
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ wait: true }),
      })
    );
  });

  test("iterates inline combined logs without follow-up requests", async () => {
    const requestMock = jest.spyOn(beamClient, "request").mockResolvedValue({
      data: {
        ok: true,
        pid: 8,
        done: true,
        exitCode: 0,
        stdout: "first\nsecond\n",
        stderr: "warning\n",
      },
    });

    const instance = new SandboxInstance(
      {
        containerId: "sandbox-123",
        stubId: "stub-123",
        url: "",
        ok: true,
        errorMsg: "",
      },
      new Sandbox({ name: "networked-sandbox" })
    );

    const process = await instance.exec(["node", "-v"], { wait: true });
    const lines: string[] = [];
    for await (const line of process.logs) {
      lines.push(line);
    }

    expect(lines).toEqual(["first\n", "second\n", "warning\n"]);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

describe("prepareRuntime surfaces real errors via lastError", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("file sync exception is surfaced in SandboxConnectionError", async () => {
    const sandbox = new Sandbox({ name: "test-sandbox" }, true);
    sandbox.stub.imageAvailable = true;
    jest.spyOn(beamClient, "request").mockResolvedValue({
      data: { ok: false },
    });

    jest
      .spyOn(sandbox.stub.syncer, "sync")
      .mockRejectedValue(new Error("EROFS: read-only file system, open '.beamignore'"));

    await expect(sandbox.create()).rejects.toThrow(SandboxConnectionError);
    await expect(sandbox.create()).rejects.toThrow(/EROFS/);
  });

  test("stub creation API error message is surfaced in SandboxConnectionError", async () => {
    const sandbox = new Sandbox({ name: "test-sandbox" });
    sandbox.stub.imageAvailable = true;
    sandbox.stub.filesSynced = true;
    sandbox.stub.objectId = "object-123";
    sandbox.stub.config.image.id = "image-123";

    jest.spyOn(beamClient, "request").mockResolvedValue({
      data: { ok: false, errMsg: "Workspace quota exceeded" },
    });

    await expect(sandbox.create()).rejects.toThrow(SandboxConnectionError);
    await expect(sandbox.create()).rejects.toThrow(/Workspace quota exceeded/);
  });
});
