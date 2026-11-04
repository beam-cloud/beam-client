import beamClient from "../lib";
import { Sandbox } from "../lib/resources/abstraction/sandbox";
import { VM } from "../lib/resources/abstraction/vm";
import { EStubType } from "../lib/types/stub";

afterEach(() => jest.restoreAllMocks());

async function prepare(
  config: ConstructorParameters<typeof Sandbox>[0],
  accountTier = "performance"
) {
  const catalog = jest.spyOn(beamClient, "cpuTiers").mockResolvedValue({
    enabled: true,
    default_cpu_tier: accountTier as "performance",
  });
  const request = jest.spyOn(beamClient, "request").mockResolvedValue({
    data: { ok: true, stubId: "stub-tiered" },
  });
  const sandbox = new Sandbox({ name: "tier-contract", ...config });
  Object.assign(sandbox.stub, {
    imageAvailable: true,
    filesSynced: true,
    objectId: "object",
  });
  sandbox.stub.config.image.id = "image";
  expect(
    await sandbox.stub.prepareRuntime(undefined, EStubType.Sandbox, true, ["*"])
  ).toBe(true);
  return { catalog, payload: request.mock.calls.at(-1)![0].data };
}

test("sends the requested tier without looking up the account default", async () => {
  const { payload, catalog } = await prepare({
    cpuTier: "performance",
    useVm: true,
  });
  expect(payload).toMatchObject({
    cpu_tier: "performance",
    use_vm: true,
    memory: 1024,
  });
  expect(catalog).not.toHaveBeenCalled();
});

test.each([
  [{ useVm: true }, "performance", 1024, 1],
  [{ useVm: true }, "", 128, 1],
  [{ useVm: true, memory: 128, cpuTier: "shared" }, "performance", 128, 0],
  [{ useVm: false }, "performance", 128, 0],
  [{ useVm: true, gpu: "T4" }, "performance", 128, 0],
] as const)(
  "native omitted defaults retain explicit, legacy and GPU resource requests: %p",
  async (config, tier, memory, lookups) => {
    const { payload, catalog } = await prepare(config, tier);
    expect(payload.memory).toBe(memory);
    expect(catalog).toHaveBeenCalledTimes(lookups);
  }
);

test("VM stopped updates and forks transmit only the requested tier", async () => {
  const request = jest.spyOn(beamClient, "request").mockResolvedValue({
    data: {
      id: "vm",
      status: "stopped",
      spec: { cpu: 1000, memory: 1024, cpu_tier: "shared" },
      stop_reason: "preempted",
    },
  });
  const vm = await VM.get("vm");
  await vm.update({ cpuTier: "performance" });
  await vm.fork(undefined, { cpuTier: "spot", wait: false });
  expect(request.mock.calls.find(([c]) => c.method === "PATCH")![0].data).toEqual({ cpu_tier: "performance" });
  expect(request.mock.calls.find(([c]) => c.url.endsWith("/fork"))![0].data).toMatchObject({ cpu_tier: "spot" });
  expect(vm.info.stopReason).toBe("preempted");
});
