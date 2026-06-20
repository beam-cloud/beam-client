import * as fs from "fs";
import * as path from "path";
import {
  ImageConfig,
  BuildImageRequest,
  BuildImageResponse,
  VerifyImageBuildRequest,
  VerifyImageBuildResponse,
  ImageBuildResult,
  BuildStep,
  PythonVersion,
  GpuType,
  ImageCredentials,
  ImageCredentialValueNotFound,
} from "../../types/image";
import { camelCaseToSnakeCaseKeys } from "../../util";
import beamClient from "../..";

const DEFAULT_PYTHON_VERSION: PythonVersion = PythonVersion.Python3;
const DEFAULT_IMAGE_BUILD_CACHE_TTL_MS = 300_000;

type ImageBuildCacheEntry = {
  result: ImageBuildResult;
  expiresAt: number;
};

const imageBuildCache = new Map<string, ImageBuildCacheEntry>();

export interface CreateImageConfig extends Partial<ImageConfig> {
  pythonVersion?: PythonVersion | string;
  pythonPackages?: string[] | string;
  commands?: string[];
  baseImage?: string;
  baseImageCreds?: ImageCredentials;
}

export class Image {
  public id: string = "";
  public config: ImageConfig = {} as ImageConfig;
  public isAvailable: boolean = false;

  constructor({
    pythonVersion = DEFAULT_PYTHON_VERSION,
    pythonPackages = [],
    commands = [],
    buildSteps = [],
    baseImage = "",
    baseImageCreds = {},
    envVars = [],
    secrets = [],
    dockerfile = "",
    gpu = "",
    ignorePython = true,
    includeFilesPatterns = [],
    buildCtxObject = "",
    imageId = "",
  }: CreateImageConfig) {
    this.id = "";

    this.config.pythonVersion = pythonVersion;
    if (typeof pythonPackages === "string") {
      pythonPackages = this._loadRequirementsFile(pythonPackages);
    }
    this.config.pythonPackages = this._sanitizePythonPackages(pythonPackages);

    this.config.commands = commands;
    this.config.baseImage = baseImage;
    this.config.baseImageCreds = this._processCredentials(baseImageCreds);
    this.config.envVars = envVars;
    this.config.secrets = secrets;
    this.config.dockerfile = dockerfile;
    this.config.gpu = gpu;
    this.config.ignorePython = ignorePython;
    this.config.includeFilesPatterns = includeFilesPatterns;
    this.config.buildCtxObject = buildCtxObject;
    this.config.imageId = imageId;
  }

  static async fromDockerfile(
    dockerfilePath: string,
    contextDir?: string
  ): Promise<Image> {
    const image = new Image({
      dockerfile: dockerfilePath,
    });

    if (!contextDir) {
      contextDir = path.dirname(dockerfilePath);
    }

    try {
      // Sync files to get build context object ID
      console.log(`Syncing build context from: ${contextDir}`);
      const objectId = await image.syncFiles(contextDir);
      image.config.buildCtxObject = objectId;
      console.log(`Build context synced with object ID: ${objectId}`);
    } catch (error) {
      throw new Error(`Failed to sync build context: ${error}`);
    }

    try {
      const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
      image.config.dockerfile = dockerfile;
    } catch (error) {
      throw new Error(
        `Failed to read Dockerfile at ${dockerfilePath}: ${error}`
      );
    }

    return image;
  }

  static fromRegistry(imageUri: string, credentials?: ImageCredentials): Image {
    return new Image({
      baseImage: imageUri,
      baseImageCreds: credentials || {},
    });
  }

  public async buildImage(
    request: BuildImageRequest
  ): Promise<AsyncIterable<BuildImageResponse>> {
    const apiRequest = this._transformRequestToSnakeCase(request);

    const response = await beamClient.request({
      method: "POST",
      url: "/api/v1/gateway/images/build",
      data: apiRequest,
      responseType: "stream",
      timeout: 600000,
    });

    return this._createAsyncIterable(response);
  }

  private _transformRequestToSnakeCase(request: BuildImageRequest): any {
    const transformed = camelCaseToSnakeCaseKeys(request);

    if (transformed.gpu === GpuType.NoGPU) {
      delete transformed.gpu;
    }

    return transformed;
  }

  private _cacheKey(): string {
    return JSON.stringify({
      pythonPackages: this.config.pythonPackages,
      pythonVersion: this.config.pythonVersion,
      commands: this.config.commands,
      buildSteps: this.config.buildSteps,
      baseImage: this.config.baseImage,
      envVars: this.config.envVars,
      dockerfile: this.config.dockerfile,
      buildCtxObject: this.config.buildCtxObject,
      secrets: this.config.secrets,
      gpu: this.config.gpu,
      ignorePython: this.config.ignorePython,
      imageId: this.config.imageId,
      includeFilesPatterns: this.config.includeFilesPatterns,
    });
  }

  private _cachedBuildResult(cacheKey: string): ImageBuildResult | undefined {
    if (this._imageBuildCacheDisabled()) {
      return undefined;
    }

    const entry = imageBuildCache.get(cacheKey);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      imageBuildCache.delete(cacheKey);
      return undefined;
    }

    return entry.result;
  }

  private _rememberBuildResult(
    cacheKey: string,
    result: ImageBuildResult
  ): void {
    if (!result.success) {
      return;
    }

    this.id = result.imageId || "";
    this.isAvailable = true;
    this.config.imageId = result.imageId || "";
    this.config.pythonVersion = result.pythonVersion || this.config.pythonVersion;

    const entry: ImageBuildCacheEntry = {
      result,
      expiresAt: Date.now() + this._imageBuildCacheTTLMS(),
    };

    imageBuildCache.set(cacheKey, entry);
    imageBuildCache.set(this._cacheKey(), entry);
  }

  private _imageBuildCacheDisabled(): boolean {
    if (typeof process === "undefined") {
      return false;
    }

    const value = process.env.BEAM_DISABLE_IMAGE_BUILD_CACHE || "";
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }

  private _imageBuildCacheTTLMS(): number {
    if (typeof process === "undefined") {
      return DEFAULT_IMAGE_BUILD_CACHE_TTL_MS;
    }

    const value = process.env.BEAM_IMAGE_BUILD_CACHE_TTL_SECONDS;
    if (!value) {
      return DEFAULT_IMAGE_BUILD_CACHE_TTL_MS;
    }

    const ttlSeconds = Number(value);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
      return DEFAULT_IMAGE_BUILD_CACHE_TTL_MS;
    }

    return ttlSeconds * 1000;
  }

  private async *_createAsyncIterable(
    response: any
  ): AsyncIterable<BuildImageResponse> {
    const stream = response.data;
    let buffer = "";

    for await (const chunk of stream) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine) {
          try {
            const jsonResponse = JSON.parse(trimmedLine).result;
            yield jsonResponse as BuildImageResponse;
          } catch (error) {
            console.warn("Failed to parse JSON line:", trimmedLine, error);
          }
        }
      }
    }

    if (buffer.trim()) {
      try {
        const jsonResponse = JSON.parse(buffer.trim()).result;
        yield jsonResponse as BuildImageResponse;
      } catch (error) {
        console.warn("Failed to parse final JSON:", buffer, error);
      }
    }
  }

  public async verifyImageBuild(
    request: VerifyImageBuildRequest
  ): Promise<VerifyImageBuildResponse> {
    const apiRequest = this._transformRequestToSnakeCase(request);

    const response = await beamClient.request({
      method: "POST",
      url: "/api/v1/gateway/images/verify-build",
      data: apiRequest,
    });

    return response.data;
  }

  static fromId(imageId: string): Image {
    const image = new Image({});
    image.config.imageId = imageId;
    return image;
  }

  async exists(): Promise<{ exists: boolean; result: ImageBuildResult }> {
    const request: VerifyImageBuildRequest = {
      pythonPackages: Array.isArray(this.config.pythonPackages)
        ? this.config.pythonPackages
        : [this.config.pythonPackages],
      pythonVersion: this.config.pythonVersion,
      commands: this.config.commands,
      forceRebuild: false,
      existingImageUri: this.config.baseImage,
      envVars: this._processEnvVars(this.config.envVars),
      dockerfile: this.config.dockerfile,
      buildCtxObject: this.config.buildCtxObject,
      secrets: this.config.secrets,
      gpu: this.config.gpu,
      ignorePython: this.config.ignorePython,
      imageId: this.config.imageId,
    };

    const response = await this.verifyImageBuild(request);

    return {
      exists: response.exists || false,
      result: {
        success: response.exists || false,
        imageId: response.imageId,
        pythonVersion: this.config.pythonVersion,
      },
    };
  }

  async build(): Promise<ImageBuildResult> {
    if (this.config.baseImage && this.config.dockerfile) {
      throw new Error(
        "Cannot use fromDockerfile and provide a custom base image."
      );
    }

    const cacheKey = this._cacheKey();
    const cachedResult = this._cachedBuildResult(cacheKey);
    if (cachedResult) {
      console.log("Using cached image");
      this.id = cachedResult.imageId || "";
      this.isAvailable = true;
      this.config.imageId = cachedResult.imageId || "";
      this.config.pythonVersion =
        cachedResult.pythonVersion || this.config.pythonVersion;
      return cachedResult;
    }

    console.log("Building image...");

    // Check if image already exists
    const { exists, result } = await this.exists();
    if (exists) {
      console.log("Using cached image");
      this._rememberBuildResult(cacheKey, result);
      return result;
    }

    const request: BuildImageRequest = {
      pythonPackages: Array.isArray(this.config.pythonPackages)
        ? this.config.pythonPackages
        : [this.config.pythonPackages],
      pythonVersion: this.config.pythonVersion,
      commands: this.config.commands,
      existingImageUri: this.config.baseImage,
      existingImageCreds: this.getCredentialsFromEnv(),
      envVars: this._processEnvVars(this.config.envVars),
      dockerfile: this.config.dockerfile,
      buildCtxObject: this.config.buildCtxObject,
      secrets: this.config.secrets,
      gpu: this.config.gpu,
      ignorePython: this.config.ignorePython,
    };

    let lastResponse: BuildImageResponse = { success: false };

    try {
      const responseIterable = await this.buildImage(request);
      for await (const response of responseIterable) {
        if (response.warning) {
          console.warn("WARNING: " + response.msg);
        } else if (response.msg && !response.done) {
          if (typeof process !== "undefined" && process.stdout) {
            process.stdout.write(response.msg);
          } else {
            console.log(response.msg);
          }
        }

        if (response.done) {
          lastResponse = response;
          break;
        }
      }
    } catch (error) {
      console.error("Build failed:", error);
      return { success: false };
    }

    if (!lastResponse.success) {
      console.error(lastResponse.msg || "Build failed");
      return { success: false };
    }

    console.log("Build complete");
    const buildResult = {
      success: true,
      imageId: lastResponse.imageId,
      pythonVersion: lastResponse.pythonVersion,
    };
    this._rememberBuildResult(cacheKey, buildResult);
    return buildResult;
  }

  /**
   * Switch the image to use micromamba for Python package installs.
   *
   * This rewrites the configured `pythonVersion` to a micromamba variant.
   *
   * @returns The image instance.
   */
  micromamba(): Image {
    if (this.config.pythonVersion === "python3") {
      this.config.pythonVersion = "python3.11";
    }
    this.config.pythonVersion = this.config.pythonVersion.replace(
      "python",
      "micromamba"
    );
    return this;
  }

  /**
   * Add micromamba packages to install during the image build.
   *
   * Packages are appended to the existing list and installed in the order added.
   * If a single string is provided, it is treated as a path to a requirements.txt file.
   *
   * @param packages The micromamba packages to add or the path to a requirements.txt file.
   * @param channels Optional micromamba channels. Currently unused.
   * @returns The image instance.
   * @throws Error if micromamba mode is not enabled (call `micromamba()` first).
   */
  addMicromambaPackages(
    packages: string[] | string,
    channels: string[] = []
  ): Image {
    if (!this.config.pythonVersion.startsWith("micromamba")) {
      throw new Error("Micromamba must be enabled to use this method.");
    }

    let packageList: string[];
    if (typeof packages === "string") {
      packageList = this._sanitizePythonPackages(
        this._loadRequirementsFile(packages)
      );
    } else {
      packageList = packages;
    }

    // Add the packages to the existing list
    this.config.pythonPackages = [
      ...this.config.pythonPackages,
      ...packageList,
    ];

    return this;
  }

  /**
   * Add Python packages to install during the image build.
   *
   * Packages are appended to the existing list and installed in the order added.
   * If a single string is provided, it is treated as a path to a requirements.txt file.
   *
   * @param packages The Python packages to add or the path to a requirements.txt file.
   * @returns The image instance.
   * @throws Error if a requirements.txt path is provided but cannot be read.
   */
  addPythonPackages(packages: string[] | string): Image {
    let packageList: string[];
    if (typeof packages === "string") {
      try {
        packageList = this._sanitizePythonPackages(
          this._loadRequirementsFile(packages)
        );
      } catch (error) {
        throw new Error(
          `Could not find valid requirements.txt file at ${packages}. Libraries must be specified as a list of valid package names or a path to a requirements.txt file.`
        );
      }
    } else {
      packageList = packages;
    }

    // Add the packages to the existing list
    this.config.pythonPackages = [
      ...this.config.pythonPackages,
      ...packageList,
    ];

    return this;
  }

  /**
   * Add a local path to the image.
   *
   * @param pattern The pattern to add. This can be a glob pattern or a single file.
   * @returns The image instance.
   */
  addLocalPath(pattern: string = "*"): Image {
    let processedPath = pattern;
    if (pattern === ".") {
      processedPath = "*";
    }
    this.config.includeFilesPatterns.push(processedPath);
    return this;
  }

  /**
   * Add environment variables to the image.
   *
   * These will be available when building the image and when the container is running.
   * This replaces any previously configured environment variables.
   *
   * @param envVars Environment variables. This can be a string, a list of strings, or a
   * dictionary of strings. The string must be in the format of "KEY=VALUE". If a list of
   * strings is provided, each element should be in the same format.
   * @returns The image instance.
   */
  withEnvs(envVars: string[] | Record<string, string> | string): Image {
    let envList: string[];

    if (typeof envVars === "object" && !Array.isArray(envVars)) {
      envList = Object.entries(envVars).map(
        ([key, value]) => `${key}=${value}`
      );
    } else if (typeof envVars === "string") {
      envList = [envVars];
    } else {
      envList = envVars;
    }

    this._validateEnvVars(envList);
    this.config.envVars = envList;
    return this;
  }

  /**
   * Add secrets stored in the platform to the build environment.
   *
   * @param secrets The secrets to add.
   * @returns The image instance.
   */
  withSecrets(secrets: string[]): Image {
    this.config.secrets.push(...secrets);
    return this;
  }

  /**
   * Build the image on a GPU node.
   *
   * @param gpu The GPU type to use.
   * @returns The image instance.
   */
  buildWithGpu(gpu: GpuType): Image {
    this.config.gpu = gpu;
    return this;
  }

  /**
   * Sync files using FileSyncer
   */
  async syncFiles(
    contextDir?: string,
    cacheObjectId: boolean = true
  ): Promise<string> {
    const { FileSyncer } = await import("../../sync");
    const syncer = new FileSyncer(contextDir || "./");
    const result = await syncer.sync([], [], cacheObjectId);

    if (!result.success) {
      throw new Error("File sync failed");
    }

    return result.objectId;
  }

  getCredentialsFromEnv(): Record<string, string> {
    if (typeof process === "undefined") {
      return {}; // Browser environment
    }

    const keys = Object.keys(this.config.baseImageCreds);
    const creds: Record<string, string> = {};

    for (const key of keys) {
      const value = process.env[key];
      if (value) {
        creds[key] = value;
      } else {
        throw new ImageCredentialValueNotFound(key);
      }
    }

    return creds;
  }

  private _sanitizePythonPackages(packages: string[]): string[] {
    const prefixExceptions = ["--", "-"];
    const sanitized: string[] = [];

    for (const pkg of packages) {
      if (prefixExceptions.some((prefix) => pkg.startsWith(prefix))) {
        sanitized.push(pkg);
      } else if (pkg.startsWith("#")) {
        continue;
      } else {
        sanitized.push(pkg.replace(/\s+/g, ""));
      }
    }

    return sanitized;
  }

  private _loadRequirementsFile(filePath: string): string[] {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return lines;
    } catch (error) {
      throw new Error(`File not found: ${filePath}`);
    }
  }

  private _processCredentials(creds: ImageCredentials): Record<string, string> {
    if (Array.isArray(creds)) {
      // List of environment variable keys
      const result: Record<string, string> = {};
      for (const key of creds) {
        result[key] = ""; // Will be filled from env vars during build
      }
      return result;
    } else {
      // Direct credential object
      return creds as Record<string, string>;
    }
  }

  private _validateEnvVars(envVars: string[]): void {
    for (const envVar of envVars) {
      const parts = envVar.split("=");
      if (parts.length !== 2) {
        throw new Error(`Environment variable must contain '=': ${envVar}`);
      }
      const [key, value] = parts;
      if (!key) {
        throw new Error(`Environment variable key cannot be empty: ${envVar}`);
      }
      if (!value) {
        throw new Error(
          `Environment variable value cannot be empty: ${envVar}`
        );
      }
    }
  }

  private _processEnvVars(
    envVars: string[] | Record<string, string> | string
  ): string[] {
    if (typeof envVars === "object" && !Array.isArray(envVars)) {
      return Object.entries(envVars).map(([key, value]) => `${key}=${value}`);
    } else if (typeof envVars === "string") {
      return [envVars];
    } else {
      return envVars;
    }
  }
}
