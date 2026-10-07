import beamClient, { Image, Sandbox } from "../lib";
import { EStubType } from "../lib/types/stub";

describe("Docker-enabled sandboxes", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([undefined, false, true])(
    "sends docker_enabled=%s through the create-stub API",
    async (dockerEnabled) => {
      const request = jest.spyOn(beamClient, "request").mockResolvedValue({
        data: { ok: true, stubId: "docker-stub" },
      });
      const sandbox = new Sandbox({ name: "docker-sandbox", dockerEnabled });
      sandbox.stub.imageAvailable = true;
      sandbox.stub.filesSynced = true;
      sandbox.stub.objectId = "object-docker";
      sandbox.stub.config.image.id = "image-docker";

      await expect(
        sandbox.stub.prepareRuntime(undefined, EStubType.Sandbox, true, ["*"])
      ).resolves.toBe(true);

      expect(request).toHaveBeenCalledWith(expect.objectContaining({
        url: "/api/v1/gateway/stubs",
        data: expect.objectContaining({ docker_enabled: dockerEnabled ?? false }),
      }));
      expect(request.mock.calls[0][0].data).not.toHaveProperty("dockerEnabled");
    }
  );

  test("appends the installer without modifying caller commands or adding it twice", () => {
    const commands = ["echo before-docker"];
    const image = new Image({ commands });
    expect(image.withDocker()).toBe(image);
    expect(image.withDocker()).toBe(image);
    expect(commands).toEqual(["echo before-docker"]);
    expect(image.config.commands).toHaveLength(2);
    const installer = image.config.commands[1];
    expect(installer).not.toMatch(/[\r\n]/);
    expect(installer).toContain("ubuntu|debian");
    expect(installer).toContain("https://download.docker.com/linux/$ID/gpg");
    expect(installer).toContain("signed-by=/etc/apt/keyrings/docker.asc");
    expect(installer).toContain("docker-buildx-plugin docker-compose-plugin");
    expect(installer).not.toContain("get.docker.com");
  });

  test("does not enable Docker or modify images unless requested", () => {
    const image = Image.fromRegistry("node:20-slim");
    const sandbox = new Sandbox({ name: "plain-sandbox", image });
    expect(sandbox.stub.config.dockerEnabled).toBe(false);
    expect(image.config.commands).toEqual([]);
    image.withDocker();
    expect(sandbox.stub.config.dockerEnabled).toBe(false);
    expect(Image.fromRegistry("node:20-slim").config.commands).toEqual([]);
  });

  test("preserves plain sandbox cache keys and separates Docker-enabled runtimes", () => {
    const key = (dockerEnabled?: boolean) => new Sandbox({
      name: "docker-cache",
      image: Image.fromRegistry("node:20-slim"),
      dockerEnabled,
    }).stub.preparationCacheKey(EStubType.Sandbox, ["*"]);
    expect(key(false)).toBe(key());
    expect(key(true)).not.toBe(key());
    expect(key(true)).toBe(key(true));
  });

  test("includes the installer in image verification and build requests", async () => {
    const image = Image.fromRegistry("node:20-slim").withDocker();
    const request = jest.spyOn(beamClient, "request").mockResolvedValue({
      data: { exists: false },
    });
    const build = jest.spyOn(image, "buildImage").mockResolvedValue(
      (async function* () {
        yield { done: true, success: true, imageId: "image-docker" };
      })()
    );

    await expect(image.build()).resolves.toMatchObject({ success: true });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      url: "/api/v1/gateway/images/verify-build",
      data: expect.objectContaining({ commands: image.config.commands }),
    }));
    expect(build).toHaveBeenCalledWith(expect.objectContaining({
      commands: image.config.commands,
      existingImageUri: "node:20-slim",
    }));
  });
});
