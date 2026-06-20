import beamClient from "../lib";
import {
  CloudBucket,
  Sandbox,
  SandboxInstance,
} from "../lib";

function sandboxInstance(): SandboxInstance {
  return new SandboxInstance(
    {
      containerId: "sandbox-123",
      stubId: "stub-123",
      url: "",
      ok: true,
      errorMsg: "",
    },
    new Sandbox({ name: "test" }),
  );
}

describe("sandbox parity APIs", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("exec safely quotes argv while execShell sends shell text as-is", async () => {
    const requestMock = jest.spyOn(beamClient, "request").mockResolvedValue({
      data: { ok: true, pid: 42 },
    });
    const instance = sandboxInstance();

    await instance.exec(["printf", "hello world"]);
    await instance.execShell("printf hello | wc -c");

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        url: "/api/v1/gateway/pods/sandbox-123/exec",
        data: expect.objectContaining({
          command: "'printf' 'hello world'",
        }),
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          command: "printf hello | wc -c",
        }),
      }),
    );
  });

  test("listProcesses reads server state and refreshes cached handles", async () => {
    jest.spyOn(beamClient, "request").mockResolvedValue({
      data: {
        ok: true,
        processes: [
          {
            pid: 7,
            cmd: "python3 server.py",
            cwd: "/app",
            env: ["A=B"],
            exitCode: -1,
            running: true,
          },
        ],
      },
    });

    const processes = await sandboxInstance().listProcesses();

    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({
      pid: 7,
      command: "python3 server.py",
      cwd: "/app",
      env: ["A=B"],
      exitCode: -1,
      running: true,
    });
  });

  test("filesystem aliases use the sandbox file endpoints", async () => {
    const requestMock = jest
      .spyOn(beamClient, "request")
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          data: Buffer.from("hello", "utf8").toString("base64"),
        },
      });

    const fs = sandboxInstance().fs;
    await fs.writeText("/tmp/hello.txt", "hello");
    await expect(fs.readText("/tmp/hello.txt")).resolves.toBe("hello");

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "POST",
        url: "api/v1/gateway/pods/sandbox-123/files/upload",
        data: expect.objectContaining({
          containerPath: "/tmp/hello.txt",
          data: Buffer.from("hello", "utf8").toString("base64"),
        }),
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "GET",
        url: "api/v1/gateway/pods/sandbox-123/files/download/%2Ftmp%2Fhello.txt",
      }),
    );
  });

  test("CloudBucket exports Beam mount config", () => {
    const bucket = new CloudBucket("models", "/mnt/models", {
      accessKey: "AWS_ACCESS_KEY_ID",
      secretKey: "AWS_SECRET_ACCESS_KEY",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      readOnly: true,
      forcePathStyle: true,
    });

    expect(bucket.export()).toEqual({
      mountPath: "/mnt/models",
      config: {
        bucketName: "models",
        accessKey: "AWS_ACCESS_KEY_ID",
        secretKey: "AWS_SECRET_ACCESS_KEY",
        endpointUrl: "https://s3.example.com",
        region: "us-east-1",
        readOnly: true,
        forcePathStyle: true,
      },
    });
  });
});
