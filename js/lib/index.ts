import axios, { Axios, AxiosRequestConfig } from "axios";
import { camelCaseToSnakeCaseKeys } from "./util";

export interface BeamClientOpts {
  token: string;
  workspaceId: string;
  gatewayUrl?: string;
  timeout?: number;
}

export const beamOpts = {
  token: "",
  workspaceId: "",
  gatewayUrl: "https://app.beam.cloud",
  timeout: 30000,
};

class BeamClient {
  private _client: Axios;

  public async request(config: AxiosRequestConfig): Promise<any> {
    if (!beamOpts.token) {
      throw new Error("Beam token is not set");
    }
    if (!beamOpts.gatewayUrl) {
      throw new Error("Beam gateway URL is not set");
    }
    if (!beamOpts.workspaceId) {
      throw new Error("Beam workspace ID is not set");
    }

    if (!this._client) {
      this._client = axios.create({
        baseURL: beamOpts.gatewayUrl,
        headers: {
          Authorization: `Bearer ${beamOpts.token}`,
          "Content-Type": "application/json",
        },
        timeout: beamOpts.timeout,
      });
    }

    return await this._client.request(config);
  }

  public async _getWorkspace(): Promise<any> {
    const response = await this.request({
      method: "GET",
      url: `/api/v1/workspace/current`,
    });

    return response.data;
  }

  public _parseOptsToURLParams(opts: Record<string, any>): URLSearchParams {
    return new URLSearchParams(camelCaseToSnakeCaseKeys(opts));
  }
}

export default new BeamClient();

export { FileSyncer, setWorkspaceObjectId, getWorkspaceObjectId } from "./sync";

// Export Deployment classes and types
export { default as Deployments } from "./resources/deployment";
export * from "./resources/deployment";
export * from "./types/deployment";

// Export Task classes and types
export * from "./resources/task";
export * from "./types/task";

// Export Pod classes and types
export { Pod, PodInstance } from "./resources/abstraction/pod";
export * from "./types/pod";

// Export Sandbox classes and types
export {
  Sandbox,
  SandboxInstance,
  SandboxFileSystem,
  SandboxProcess,
  SandboxProcessStream,
  SandboxFileInfo,
  SandboxConnectionError,
  SandboxFileSystemError,
  SandboxProcessError,
} from "./resources/abstraction/sandbox";

// Export Image classes and types
export { Image } from "./resources/abstraction/image";
export * from "./types/image";

// Export Volume classes and types
export { CloudBucket, Volume } from "./resources/volume";
export * from "./types/volume";

// Export Stub classes and types
export * from "./resources/abstraction/stub";

// Export supporting types
export * from "./types/autoscaler";
export * from "./types/task";
export * from "./types/pricing";
export * from "./types/schema";

// Export common types
export {
  LifeCycleMethod,
  TaskStatus,
  TaskStatusHelper,
  TaskExitCode,
  PythonVersion,
  GpuType,
} from "./types/common";
export type { GpuTypeAlias } from "./types/common";

// Export stub types and constants
export * from "./types/stub";
