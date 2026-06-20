import * as path from "path";
import beamClient, { GpuType, GpuTypeAlias } from "../..";
import { Image } from "./image";
import { Volume } from "../volume";
import { FileSyncer } from "../../sync";
import { Autoscaler, QueueDepthAutoscaler } from "../../types/autoscaler";
import { TaskPolicy } from "../../types/task";
import { PricingPolicy } from "../../types/pricing";
import { Schema } from "../../types/schema";
import {
  DeployStubRequest,
  DeployStubResponse,
  GetOrCreateStubRequest,
  GetOrCreateStubResponse,
  GetUrlResponse,
  SecretVar,
} from "../../types/stub";
import {
  camelCaseToSnakeCaseKeys,
  formatEnv,
  parseCpu,
  parseGpu,
  parseMemory,
  schemaToApi,
} from "../../util";

export interface StubConfig {
  name: string;
  app: string;
  cpu: number | string;
  memory: number | string;
  gpu: GpuTypeAlias | GpuTypeAlias[];
  gpuCount: number;
  image: Image;
  workers: number;
  concurrentRequests: number;
  keepWarmSeconds: number;
  maxPendingTasks: number;
  retries: number;
  timeout: number;
  volumes: Volume[];
  secrets: SecretVar[];
  env: Record<string, string> | string[];
  callbackUrl: string;
  authorized: boolean;
  autoscaler: Autoscaler;
  taskPolicy: TaskPolicy;
  checkpointEnabled: boolean;
  entrypoint: string[];
  ports: number[];
  pricing?: PricingPolicy;
  inputs?: Schema;
  outputs?: Schema;
  tcp: boolean;
  blockNetwork: boolean;
  allowList?: string[];
}

export interface CreateStubConfig extends Partial<StubConfig> {
  name: string;
}

// Global stub creation state management
let _stubCreatedForWorkspace = false;
let _stubCreationLock = false;

function isStubCreatedForWorkspace(): boolean {
  return _stubCreatedForWorkspace;
}

function setStubCreatedForWorkspace(value: boolean): void {
  _stubCreatedForWorkspace = value;
}

export class StubBuilder {
  // Internal state
  public syncer: FileSyncer;
  public config: StubConfig;
  // Runtime state properties
  public imageAvailable?: boolean = false;
  public filesSynced?: boolean = false;
  public stubCreated?: boolean = false;
  public stubId?: string = "";
  public runtimeReady?: boolean = false;
  public extra?: any = {};
  public imageId?: string = "";
  public objectId?: string = "";
  public lastError?: Error;

  constructor({
    name,
    app = undefined,
    authorized = true,
    image,
    callbackUrl = "",
    cpu = 1,
    ports = [],
    memory = 128,
    gpuCount = 0,
    volumes = [],
    gpu = GpuType.NoGPU,
    secrets = [],
    env = {},
    workers = 1,
    concurrentRequests = 1,
    keepWarmSeconds = 60,
    maxPendingTasks = 100,
    autoscaler = new QueueDepthAutoscaler(),
    taskPolicy = new TaskPolicy(),
    checkpointEnabled = false,
    entrypoint = [],
    pricing = undefined,
    inputs = undefined,
    outputs = undefined,
    tcp = false,
    blockNetwork = false,
    allowList = undefined,
  }: CreateStubConfig) {
    this.config = {} as StubConfig;
    this.config.name = name;
    this.config.app = app || name;
    this.config.authorized = authorized;
    this.config.image = image || new Image({});
    this.config.callbackUrl = callbackUrl;
    this.config.cpu = cpu;
    this.config.memory = memory;
    this.config.gpu = gpu;
    this.config.gpuCount = gpuCount;
    this.config.volumes = volumes;
    this.config.secrets = secrets;
    this.config.env = env;
    this.config.workers = workers;
    this.config.concurrentRequests = concurrentRequests;
    this.config.keepWarmSeconds = keepWarmSeconds;
    this.config.maxPendingTasks = maxPendingTasks;
    this.config.autoscaler = autoscaler || new QueueDepthAutoscaler();
    this.config.taskPolicy = taskPolicy;
    this.config.checkpointEnabled = checkpointEnabled;
    this.config.entrypoint = entrypoint;
    this.config.tcp = tcp;
    this.config.ports = ports || [];
    this.config.pricing = pricing;
    this.config.inputs = inputs;
    this.config.outputs = outputs;
    this.config.blockNetwork = blockNetwork;
    this.config.allowList = allowList;

    if (this.config.blockNetwork && this.config.allowList !== undefined) {
      throw new Error(
        "Cannot specify both 'blockNetwork=true' and 'allowList'. Use 'allowList' with CIDR notation to allow specific ranges, or use 'blockNetwork=true' to block all outbound traffic."
      );
    }

    // Set GPU count if GPU specified but count is 0
    if (
      (this.config.gpu !== "" || Array.isArray(this.config.gpu)) &&
      this.config.gpuCount === 0
    ) {
      this.config.gpuCount = 1;
    }

    // Initialize client and syncer (will be set when prepare_runtime is called)
    this.syncer = new FileSyncer();
  }

  public async printInvocationSnippet(
    urlType: string = ""
  ): Promise<GetUrlResponse | null> {
    if (!beamClient) {
      console.error("Client not set");
      return null;
    }

    try {
      const response = await beamClient.request({
        method: "GET",
        url: `/api/v1/gateway/stubs/${this.stubId}/url`,
        data: {
          deploymentId: "", // TODO: Add deployment_id if needed
          urlType: urlType,
          // TODO: Is shell?
        },
      });

      const res: GetUrlResponse = response.data;

      if (!res.ok) {
        console.error("Failed to get invocation URL");
        return null;
      }

      if (res.url.includes("<PORT>") || this.config.tcp) {
        console.log("Exposed endpoints\n");

        let url = res.url;
        if (this.config.tcp) {
          url = url.replace("http://", "").replace("https://", "") + ":443";
        }

        this.config.ports?.forEach((port) => {
          const urlText = url.replace("<PORT>", port.toString());
          console.log(`\tPort ${port}: ${urlText}`);
        });

        return res;
      }

      console.log("Invocation details");
      const commands = [
        `curl -X POST '${res.url}' \\`,
        "-H 'Connection: keep-alive' \\",
        "-H 'Content-Type: application/json' \\",
        ...(this.config.authorized
          ? [`-H 'Authorization: Bearer [YOUR_TOKEN]' \\`]
          : []),
        "-d '{}'",
      ];

      return res;
    } catch (error) {
      console.error("Failed to get invocation URL:", error);
      return null;
    }
  }

  public async prepareRuntime(
    func?: Function,
    stubType: string = "container",
    forceCreateStub: boolean = false,
    ignorePatterns?: string[]
  ): Promise<boolean> {
    if (!beamClient) {
      this.lastError = new Error("Client not set. Call setClient() first.");
      console.error(this.lastError.message);
      return false;
    }

    if (this.runtimeReady) {
      return true;
    }

    // Build image if not available
    if (!this.imageAvailable) {
      try {
        const imageBuildResult = await this.config.image?.build();
        if (imageBuildResult && imageBuildResult.success) {
          const image = this.config.image;
          image.isAvailable = true;
          image.id = imageBuildResult.imageId || "";
          image.config.pythonVersion =
            imageBuildResult.pythonVersion || "python3.10";
        } else {
          this.lastError = new Error("Image build failed");
          console.error("Image build failed ❌");
          return false;
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
        console.error("Image build failed:", error);
        return false;
      }
    }

    // Sync files if not already synced
    if (!this.filesSynced) {
      try {
        const syncResult = await this.syncer.sync(ignorePatterns);
        if (syncResult.success) {
          this.filesSynced = true;
          this.objectId = syncResult.objectId;
        } else {
          this.lastError = new Error("File sync failed");
          console.error("File sync failed");
          return false;
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
        console.error("File sync failed:", error);
        return false;
      }
    }

    // Prepare volumes
    for (const volume of this.config.volumes || []) {
      if (!volume.ready && !(await volume.getOrCreate())) {
        this.lastError = new Error(`Volume is not ready: ${volume.name}`);
        console.error(this.lastError.message);
        return false;
      }
    }

    // Validate autoscaler
    if (!this.config.autoscaler.type) {
      this.lastError = new Error(
        `Invalid Autoscaler class: ${
          this.config.autoscaler.constructor.name || ""
        }`
      );
      console.error(this.lastError.message);
      return false;
    }

    // Set app name if not provided
    if (!this.config.app) {
      this.config.app = this.config.name || path.basename(process.cwd());
    }

    // Prepare schemas
    const inputs = this.config.inputs
      ? schemaToApi(this.config.inputs)
      : undefined;
    const outputs = this.config.outputs
      ? schemaToApi(this.config.outputs)
      : undefined;

    // Create stub if not already created
    if (!this.stubCreated) {
      const stubRequest: GetOrCreateStubRequest = {
        objectId: this.objectId!,
        imageId: this.config.image.id,
        stubType,
        name: this.config.name,
        appName: this.config.app,
        pythonVersion: this.config.image?.config.pythonVersion || "python3.10",
        cpu: parseCpu(this.config.cpu),
        memory: parseMemory(this.config.memory),
        gpu: parseGpu(this.config.gpu),
        gpuCount: this.config.gpuCount,
        keepWarmSeconds: this.config.keepWarmSeconds,
        workers: this.config.workers,
        maxPendingTasks: this.config.maxPendingTasks,
        volumes: this.config.volumes.map((v) => v.export()),
        secrets: this.config.secrets,
        env: formatEnv(this.config.env),
        forceCreate: forceCreateStub,
        authorized: this.config.authorized,
        autoscaler: {
          type: this.config.autoscaler.type,
          maxContainers: this.config.autoscaler.maxContainers,
          tasksPerContainer: this.config.autoscaler.tasksPerContainer,
          minContainers: this.config.autoscaler.minContainers,
        },
        taskPolicy: {
          maxRetries: this.config.taskPolicy.maxRetries,
          timeout: this.config.taskPolicy.timeout,
          ttl: this.config.taskPolicy.ttl,
        },
        concurrentRequests: this.config.concurrentRequests,
        checkpointEnabled: this.config.checkpointEnabled,
        entrypoint: this.config.entrypoint,
        ports: this.config.ports,
        pricing: this.config.pricing
          ? {
              costPerTask: this.config.pricing.costPerTask,
              costPerTaskDurationMs: this.config.pricing.costPerTaskDurationMs,
              costModel: this.config.pricing.costModel,
              maxInFlight: this.config.pricing.maxInFlight,
            }
          : undefined,
        inputs,
        outputs,
        tcp: this.config.tcp,
        blockNetwork: this.config.blockNetwork,
        allowList: this.config.allowList,
      };

      try {
        let stubResponse: GetOrCreateStubResponse;

        if (isStubCreatedForWorkspace()) {
          const response = await beamClient.request({
            method: "POST",
            url: "/api/v1/gateway/stubs",
            data: camelCaseToSnakeCaseKeys(stubRequest),
          });
          stubResponse = response.data;
        } else {
          // Use a simple lock mechanism
          if (_stubCreationLock) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return this.prepareRuntime(
              func,
              stubType,
              forceCreateStub,
              ignorePatterns
            );
          }

          _stubCreationLock = true;
          try {
            const response = await beamClient.request({
              method: "POST",
              url: "/api/v1/gateway/stubs",
              data: camelCaseToSnakeCaseKeys(stubRequest),
            });
            stubResponse = response.data;
            setStubCreatedForWorkspace(true);
          } finally {
            _stubCreationLock = false;
          }
        }

        if (stubResponse.ok) {
          this.stubCreated = true;
          this.stubId = stubResponse.stubId;
          if (stubResponse.warnMsg) {
            console.warn(stubResponse.warnMsg);
          }
        } else {
          const error = stubResponse.errMsg || "Failed to get or create stub";
          this.lastError = new Error(error);
          console.error(error);
          return false;
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error : new Error(String(error));
        console.error("Failed to create stub:", error);
        return false;
      }
    }

    this.runtimeReady = true;
    return true;
  }

  public async deployStub(
    request: DeployStubRequest
  ): Promise<DeployStubResponse> {
    const response = await beamClient.request({
      method: "POST",
      url: "/api/v1/gateway/stubs/deploy",
      data: camelCaseToSnakeCaseKeys(request),
    });
    return response.data;
  }
}
