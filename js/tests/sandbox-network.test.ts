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
      releasePreparation = resolve;
    });
    const prepareRuntimeMock = jest
      .spyOn(sandbox.stub, "prepareRuntime")
      .mockReturnValue(preparation);
    let nextContainer = 0;
    const requestMock = jest
      .spyOn(beamClient, "request")
      .mockImplementation(async (config) => {
        if (config.url === "api/v1/gateway/pods") {
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

    expect(prepareRuntimeMock).toHaveBeenCalledTimes(1);
    releasePreparation(true);

    const instances = await Promise.all([firstCreate, secondCreate]);
    expect(instances.map((instance) => instance.containerId)).toEqual([
      "sandbox-1",
      "sandbox-2",
    ]);
    expect(requestMock).toHaveBeenCalledTimes(4);
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
    const sandbox = new Sandbox({ name: "test-sandbox" });
    sandbox.stub.imageAvailable = true;

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
