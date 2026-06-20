import {
  CreatePodRequest,
  CreatePodResponse,
  PodInstanceData,
  EPodStatus,
} from "../../types/pod";
import { StopContainerResponse } from "../../types/pod";
import { StubBuilder, CreateStubConfig } from "./stub";
import {
  EStubType,
  DeployStubRequest,
  DeployStubResponse,
} from "../../types/stub";
import beamClient from "../..";

// TODO: Temp fix until common.py is implemented
let USER_CODE_DIR = "/mnt/code";

export class Pod {
  public stub: StubBuilder;
  public containerId: string;
  public status: EPodStatus;
  public url?: string;

  constructor(config: CreateStubConfig) {
    this.stub = new StubBuilder({ ...config, authorized: false });
    if (this.stub.config.image) {
      this.stub.config.image.config.ignorePython = true;
    }
    this.containerId = "";
    this.status = EPodStatus.PENDING;
    this.url = undefined;
  }

  private async _createPod(
    request: CreatePodRequest
  ): Promise<CreatePodResponse> {
    const response = await beamClient.request({
      method: "POST",
      url: `/api/v1/gateway/pods`,
      data: request,
    });

    return response.data;
  }

  public async create(entrypoint?: string[]): Promise<PodInstance> {
    if (entrypoint) {
      this.stub.config.entrypoint = entrypoint;
    }

    const { ignorePatterns } = this.parseAndValidate();

    const prepared = await this.stub.prepareRuntime(
      undefined,
      EStubType.PodRun,
      true,
      ignorePatterns
    );
    if (!prepared) {
      throw new Error("Failed to prepare runtime");
    }

    if (!this.stub.stubId) {
      throw new Error("Stub not created");
    }

    const createResp = await this._createPod({
      stubId: this.stub.stubId,
    });

    if (!createResp.ok) {
      throw new Error(createResp.errorMsg || "Failed to create pod");
    }

    console.log(
      `Container created successfully ===> ${createResp.containerId}`
    );

    if (this.stub.config.keepWarmSeconds < 0) {
      console.log(
        "This container has no timeout, it will run until it completes."
      );
    } else {
      console.log(
        `This container will timeout after ${this.stub.config.keepWarmSeconds} seconds.`
      );
    }

    const urlRes = await this.stub.printInvocationSnippet();
    const url = urlRes?.url || "";

    return new PodInstance(
      {
        containerId: createResp.containerId,
        url,
        ok: createResp.ok,
        errorMsg: createResp.errorMsg,
      },
      this
    );
  }

  /**
   * Deploy a pod.
   *
   * @param name Optional deployment name. If omitted, uses the pod's configured `name`
   * @returns Deployment details and a success boolean
   *
   * @example
   * ```ts
   * const pod = new Pod({
   *   name: "my-pod",
   *   cpu: 1.0,
   *   memory: 128,
   *   image: new Image({}),
   *   keepWarmSeconds: 1000
   * });
   * const { deploymentDetails, success } = await pod.deploy("my-pod");
   * ```
   */
  public async deploy(
    name?: string
  ): Promise<{ deploymentDetails: Record<string, any>; success: boolean }> {
    this.stub.config.name = name || this.stub.config.name;
    if (!this.stub.config.name) {
      console.error(
        "You must specify an app name (either in the constructor or via the name argument)."
      );
    }

    const { ignorePatterns } = this.parseAndValidate();

    const prepared = await this.stub.prepareRuntime(
      undefined,
      EStubType.PodDeployment,
      true,
      ignorePatterns
    );
    if (!prepared) {
      throw new Error("Failed to prepare runtime");
    }

    if (!this.stub.stubId) {
      throw new Error("Stub not created");
    }

    try {
      const req: DeployStubRequest = {
        stubId: this.stub.stubId,
        name: this.stub.config.name || "",
      };

      const deployRes: DeployStubResponse = await this.stub.deployStub(req);

      if (deployRes.ok) {
        console.log("Deployed 🎉");
        // Invokation details func
        if ((this.stub.config.ports?.length || 0) > 0) {
          await this.stub.printInvocationSnippet();
        }
      }

      return {
        deploymentDetails: {
          deploymentId: deployRes.deploymentId,
          deploymentName: this.stub.config.name,
          invokeUrl: deployRes.invokeUrl,
          version: deployRes.version,
        },
        success: deployRes.ok,
      };
    } catch (error) {
      console.error("Failed to deploy pod:", error);
      return { deploymentDetails: {}, success: false };
    }
  }

  public parseAndValidate(): { ignorePatterns: string[] } {
    const isCustomImage = !!(
      this.stub.config.image?.config.baseImage ||
      this.stub.config.image?.config.dockerfile
    );

    if (!this.stub.config.entrypoint.length && !isCustomImage) {
      throw new Error("You must specify an entrypoint.");
    }

    let ignorePatterns: string[] = [];
    if (isCustomImage) {
      ignorePatterns = ["**"];
    }

    if (
      !isCustomImage &&
      this.stub.config.entrypoint &&
      this.stub.config.entrypoint.length > 0
    ) {
      this.stub.config.entrypoint = [
        "sh",
        "-c",
        `cd ${USER_CODE_DIR} && ${this.stub.config.entrypoint.join(" ")}`,
      ];
    }

    return { ignorePatterns };
  }
}

export class PodInstance {
  public containerId: string;
  public url: string;
  public ok: boolean;
  public errorMsg?: string;
  public pod: Pod;

  constructor(data: PodInstanceData, pod: Pod) {
    this.containerId = data.containerId;
    this.url = data.url;
    this.ok = data.ok;
    this.errorMsg = data.errorMsg;
    this.pod = pod;
  }

  public async terminate(): Promise<boolean> {
    const response = await beamClient.request({
      method: "POST",
      url: `api/v1/gateway/containers/${this.containerId}/stop`,
      data: {},
    });
    const data = response.data as StopContainerResponse;
    return data.ok;
  }
}
