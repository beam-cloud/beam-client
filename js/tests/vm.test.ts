import beamClient, { beamOpts } from "../lib";
import { Image } from "../lib/resources/abstraction/image";
import { VM } from "../lib/resources/abstraction/vm";
import { VMError } from "../lib/resources/abstraction/vm-api";
import { Volume } from "../lib/resources/volume";

const raw = (overrides: Record<string, any> = {}) => ({
  id: "vm-123",
  name: "test-vm",
  handle: "test-vm-handle",
  container_id: "boot-1",
  stub_id: "stub-1",
  status: "running",
  desired_state: "running",
  generation: 1,
  launch_attempts: 0,
  ever_running: true,
  spec: {
    cpu: 2000,
    memory: 4096,
    image_id: "vm-image",
    disk_size: "53687091200",
    ssh: false,
    desktop: false,
    docker_enabled: false,
    idle_timeout: 0,
    auto_resume: false,
    block_network: false,
  },
  urls: { "3000": "https://vm.example" },
  metadata: { user_id: "123", USER_ID: "456" },
  memory_disk_snapshots: { data_disk: "snapshot-id" },
  created_at: "2026-10-12T00:00:00Z",
  updated_at: "2026-10-12T00:00:00Z",
  last_active_at: "2026-10-12T00:00:00Z",
  ...overrides,
});
const artifact = (kind = "snapshot", vmId = "vm-123") => ({
  id: `${kind}-id`,
  name: "checkpoint",
  vm_id: vmId,
  kind,
  root_snapshot_id: "disk-snapshot",
  spec: raw().spec,
  created_at: "2026-10-12T00:00:00Z",
});

describe("Persistent VM contract", () => {
  let request: jest.SpyInstance;
  beforeEach(() => {
    beamOpts.workspaceId = "workspace";
    request = jest.spyOn(beamClient, "request");
  });
  afterEach(() => jest.restoreAllMocks());

  test("get/list return one manageable VM class, preserve map keys, and do not start compute", async () => {
    request
      .mockResolvedValueOnce({ data: raw() })
      .mockResolvedValueOnce({ data: [raw()] });
    const vm = await VM.get("vm-123");
    const listed = await VM.list({
      metadata: { user_id: "123" },
      status: "running",
    });
    expect(vm).toBeInstanceOf(VM);
    expect(listed[0]).toBeInstanceOf(VM);
    expect(vm.info.spec.cpu).toBe(2);
    expect(vm.info.metadata).toEqual({ user_id: "123", USER_ID: "456" });
    expect(vm.info.memoryDiskSnapshots).toEqual({ data_disk: "snapshot-id" });
    expect(
      request.mock.calls.every(([config]) => config.method === "GET"),
    ).toBe(true);
    expect(request.mock.calls[1][0].params.metadata).toBe('{"user_id":"123"}');
  });

  test("creation freezes one UUID and the exact request across retries, with zero/false overrides intact", async () => {
    jest
      .spyOn(Image.prototype, "build")
      .mockResolvedValue({ success: true, imageId: "vm-image" });
    request.mockImplementation(async (config) => ({
      data: config.method === "GET" ? [] : raw({ exec_ready: true }),
    }));
    const config = {
      name: "test-vm",
      image: Image.fromId("vm-image"),
      cpu: 2,
      memory: "4Gi",
      ssh: false,
      desktop: false,
      ttl: 0,
      autoResume: false,
      metadata: { user_id: "1" },
      env: { API_KEY: "literal" },
    };
    const vm = new VM(config);
    await vm.create();
    config.env.API_KEY = "changed";
    await vm.create();
    const posts = request.mock.calls
      .map(([config]) => config)
      .filter((config) => config.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].data).toEqual(posts[1].data);
    expect(posts[0].data).toMatchObject({
      request_id: vm.requestId,
      metadata: { user_id: "1" },
      spec: {
        cpu: 2000,
        memory: 4096,
        idle_timeout: 0,
        auto_resume: false,
        desktop: false,
        ssh: false,
        env: ["API_KEY=literal"],
      },
    });
    expect(Image.prototype.build).toHaveBeenCalledTimes(1);
  });

  test("concurrent creates on one object share image preparation and submission", async () => {
    jest
      .spyOn(Image.prototype, "build")
      .mockResolvedValue({ success: true, imageId: "vm-image" });
    request.mockImplementation(async (config) => ({
      data: config.method === "GET" ? [] : raw({ exec_ready: true }),
    }));
    const vm = new VM({ image: Image.fromId("vm-image"), ssh: false });
    const [a, b] = await Promise.all([vm.create(), vm.create()]);
    expect(a).toBe(vm);
    expect(b).toBe(vm);
    expect(
      request.mock.calls.filter(([config]) => config.method === "POST"),
    ).toHaveLength(1);
  });

  test("snapshot/template seeds inherit omitted settings and support explicit overrides and shared volumes", async () => {
    jest
      .spyOn(Volume.prototype, "getOrCreate")
      .mockImplementation(async function (this: Volume) {
        this.volumeId = "volume-id";
        return true;
      });
    request.mockImplementation(async (config) => ({
      data: config.url.includes("/artifacts/")
        ? [
            {
              ...artifact(),
              spec: {
                ...raw().spec,
                ssh: true,
                desktop: true,
                ports: [7681, 2222, 8080, 3000],
                protected_ports: [3000],
              },
            },
          ]
        : config.method === "GET"
          ? []
          : raw(),
    }));
    await VM.create(
      {
        snapshot: "checkpoint",
        ssh: false,
        desktop: false,
        idleTimeout: 0,
        volumes: [new Volume("shared", "/data")],
        disks: [{ name: "scratch", size: "1Gi", mountPath: "/scratch" }],
      },
      { wait: false },
    );
    const post = request.mock.calls.find(
      ([config]) => config.method === "POST",
    )![0];
    expect(post.data.spec).not.toHaveProperty("cpu");
    expect(post.data.spec).not.toHaveProperty("image_id");
    expect(post.data.spec.volumes).toEqual([
      { id: "volume-id", mount_path: "/data" },
    ]);
    expect(post.data.spec.disks[0]).toMatchObject({
      mount_path: "/scratch",
      driver: "qcow",
      filesystem: "ext4",
    });
    expect(post.data.spec.ports).toEqual([7681, 3000]);
    expect(post.data.spec.protected_ports).toEqual([3000]);
  });

  test("connect resumes a stopped VM, get does not, and cold start explicitly discards RAM", async () => {
    request
      .mockResolvedValueOnce({
        data: raw({ status: "stopped", container_id: undefined }),
      })
      .mockResolvedValueOnce({ data: raw({ exec_ready: true }) });
    const vm = await VM.connect("test-vm", { cold: true });
    expect(vm.status).toBe("running");
    expect(request.mock.calls[1][0]).toMatchObject({
      method: "POST",
      url: "/api/v1/vm/workspace/vm-123/start",
      data: { cold: true },
      params: { wait: "exec" },
    });
  });

  test("network, idle policy, access credentials and ports use the persistent management routes", async () => {
    request.mockImplementation(async (config) => ({
      data: config.url.endsWith("access-session")
        ? { url: "https://entry.example" }
        : config.url.endsWith("access-token")
          ? { token: "traffic" }
          : raw(),
    }));
    const vm = await VM.get("test-vm");
    await vm.update({
      idleTimeout: 0,
      idleAction: "pause",
      autoResume: false,
      metadata: {},
    });
    await vm.updateNetworkPermissions(false, ["10.0.0.0/8"]);
    expect(await vm.exposePort(3000, { protected: true })).toBe(
      "https://vm.example",
    );
    await vm.unexposePort(3000);
    await vm.bind(4000);
    expect(await vm.getAccessToken()).toBe("traffic");
    expect(await vm.rotateAccessToken()).toBe("traffic");
    expect(await vm.accessUrl(3000, { ttl: 60 })).toBe("https://entry.example");
    expect(request.mock.calls[1][0].data).toEqual({
      idle_timeout: 0,
      idle_action: "pause",
      auto_resume: false,
      metadata: {},
    });
    expect(request.mock.calls[2][0].data).toEqual({
      block_network: false,
      allow_list: ["10.0.0.0/8"],
    });
    expect(
      request.mock.calls.every(([config]) =>
        config.url.includes("/api/v1/vm/workspace"),
      ),
    ).toBe(true);
  });

  test("snapshots can be scoped, retrieved, removed and forked after the source is gone", async () => {
    request.mockImplementation(async (config) => ({
      data: config.url.includes("/artifacts/")
        ? [artifact(), artifact("snapshot", "other-vm")]
        : config.url.endsWith("/snapshot")
          ? artifact()
          : raw(),
    }));
    const vm = await VM.get("test-vm");
    const snapshot = await vm.snapshots.create("checkpoint");
    expect(snapshot.id).toBe("snapshot-id");
    expect(await vm.snapshots.list()).toHaveLength(1);
    expect(await VM.snapshots.list()).toHaveLength(2);
    const create = jest.spyOn(VM, "create").mockResolvedValue(vm);
    await snapshot.fork({ name: "branch", cpu: 1 });
    expect(create).toHaveBeenCalledWith(
      { name: "branch", cpu: 1, snapshot: "snapshot-id" },
      {},
    );
    await snapshot.delete();
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "DELETE",
        url: "/api/v1/vm/workspace/artifacts/snapshot/snapshot-id",
      }),
    );
    await expect(vm.snapshots.get("missing")).rejects.toMatchObject({
      status: 404,
    });
  });

  test("templates are private immutable artifacts with create/get/list/delete controls", async () => {
    request.mockImplementation(async (config) => ({
      data: config.url.includes("/artifacts/")
        ? [artifact("template")]
        : config.url.endsWith("/template")
          ? artifact("template")
          : raw(),
    }));
    const vm = await VM.get("test-vm");
    expect(
      (await vm.templates.create({ name: "base", description: "ready" })).kind,
    ).toBe("template");
    expect((await VM.templates.get("checkpoint")).info.spec.cpu).toBe(2);
    await VM.templates.delete("checkpoint");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "DELETE",
        url: "/api/v1/vm/workspace/artifacts/template/template-id",
      }),
    );
  });

  test("an operation lock retries, but a conflicting name is immediately actionable", async () => {
    request
      .mockResolvedValueOnce({ data: raw() })
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 409,
          data: { message: "operation already in progress" },
        },
      })
      .mockResolvedValueOnce({ data: raw({ status: "paused" }) });
    const vm = await VM.get("test-vm");
    await expect(vm.pause()).resolves.toBe(vm);
    request.mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 409, data: { message: "name already exists" } },
    });
    await expect(vm.pause()).rejects.toMatchObject({
      status: 409,
      message: "name already exists",
    });
  });

  test("lease renewal is released on failure without hiding the callback's error", async () => {
    request.mockResolvedValue({ data: raw({ exec_ready: true }) });
    const vm = await VM.get("test-vm");
    await expect(
      vm.keepAlive(async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    const touches = request.mock.calls
      .map(([config]) => config)
      .filter((config) => config.url.endsWith("/touch"));
    expect(touches.map((config) => config.params.release)).toEqual(["0", "1"]);
    expect(touches[0].params.lease).toBe(touches[1].params.lease);
  });

  test("processes retain their boot identity and reject stale kills after a restart", async () => {
    let boot = "boot-1";
    request.mockImplementation(async (config) => ({
      data: config.url.endsWith("/exec")
        ? { ok: true, pid: 7 }
        : raw({ container_id: boot, exec_ready: true }),
    }));
    const vm = await VM.get("test-vm");
    const process = await vm.exec(["sleep", "60"]);
    boot = "boot-2";
    await vm.refresh();
    await expect(process.kill()).rejects.toThrow("previous VM runtime");
    expect(
      request.mock.calls.some(([config]) => config.url.endsWith("/kill")),
    ).toBe(false);
    await expect(vm.getProcess(7, { containerId: "boot-1" })).rejects.toThrow(
      "previous VM runtime",
    );
  });

  test("cached output is consumed once and inline completion does not poll the server", async () => {
    request.mockImplementation(async (config) => ({
      data: config.url.endsWith("/exec")
        ? {
            ok: true,
            pid: 1,
            done: true,
            exitCode: 0,
            stdout: "hello\n",
            stderr: "warn\n",
          }
        : raw({ exec_ready: true }),
    }));
    const vm = await VM.get("test-vm");
    const process = await vm.exec(["echo", "hello"], { wait: true });
    expect(await process.wait()).toBe(0);
    expect(await process.stdout.read()).toBe("hello\n");
    expect(await process.stdout.read()).toBe("");
    expect(await process.stderr.read()).toBe("warn\n");
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("stdin preserves literal argv and is unlinked by the launched process", async () => {
    request.mockImplementation(async (config) => ({
      data: config.url.endsWith("/exec")
        ? { ok: true, pid: 1, done: true, exitCode: 0 }
        : config.url.endsWith("/files/upload")
          ? { ok: true }
          : raw({ exec_ready: true }),
    }));
    const vm = await VM.get("test-vm");
    await vm.exec(["cat", "--"], { stdin: "$(literal)\n😀" });
    const upload = request.mock.calls.find(([config]) =>
      config.url.endsWith("/files/upload"),
    )![0];
    expect(Buffer.from(upload.data.data, "base64").toString()).toBe(
      "$(literal)\n😀",
    );
    const exec = request.mock.calls
      .map(([config]) => config)
      .filter((config) => config.url.endsWith("/exec"))
      .pop();
    expect(exec.data.command).toContain("rm --");
    expect(exec.data.command).toContain("'cat' '--'");
  });

  test("filesystem resolves the current boot and auto-resumes only when enabled", async () => {
    request.mockImplementation(async (config) => ({
      data: config.url.endsWith("/wake")
        ? raw({ container_id: "boot-2", exec_ready: true })
        : config.url.includes("/files/download/")
          ? { ok: true, data: Buffer.from("persistent").toString("base64") }
          : raw({
              status: "stopped",
              container_id: undefined,
              spec: { ...raw().spec, auto_resume: true },
            }),
    }));
    const vm = await VM.get("test-vm");
    expect(await vm.fs.readText("/workspace/file")).toBe("persistent");
    expect(
      request.mock.calls.find(([config]) =>
        config.url.includes("/files/download/"),
      )![0].url,
    ).toContain("/pods/boot-2/");
  });

  test("invalid configurations fail before image builds or compute creation", () => {
    expect(() => new VM({ template: "x", snapshot: "y" })).toThrow(VMError);
    expect(() => new VM({ idleTimeout: 1, ttl: 2 })).toThrow(VMError);
    expect(() => new VM({ idleTimeout: -1 })).toThrow(VMError);
    expect(() => new VM({ requestId: "bad" })).toThrow(VMError);
  });
});
