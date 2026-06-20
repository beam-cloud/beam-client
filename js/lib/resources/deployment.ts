import { AxiosResponse } from "axios";
import { DeploymentData } from "../types/deployment";
import APIResource, { ResourceObject } from "./base";
import { EStubType } from "../types/stub";
import { beamOpts } from "../index";

export interface ListDeploymentsOptions {
  stubType?: EStubType;
  name?: string;
  cursor?: string;
  active?: boolean;
  stringFilter?: string;
  version?: string;
  createdAtStart?: string;
  createdAtEnd?: string;
}

interface DeploymentGetParams {
  id?: string;
  name?: string;
  stubType?: EStubType;
  url?: string;
}

class Deployments extends APIResource<Deployment, DeploymentData> {
  public object: string = "deployment";

  protected _constructResource(data: any): Deployment {
    return new Deployment(this, data);
  }

  public async get(opts: DeploymentGetParams): Promise<Deployment> {
    const isId = opts.id !== undefined;
    const isNameAndStubType =
      opts.name !== undefined && opts.stubType !== undefined;
    const isUrl = opts.url !== undefined;

    if (!isId && !isNameAndStubType && !isUrl) {
      throw new Error(
        "Invalid parameters for get(). Must provide id, or name + stubType, or url."
      );
    }

    if (isId) {
      return super.get({ id: opts.id! });
    }

    if (isNameAndStubType) {
      let stubType = opts.stubType!.toString();
      const stubTypeSplit = stubType.split("/");

      if (stubTypeSplit.length < 2) {
        stubType = `${stubType}/deployment`;
      }

      const res = await this.list({
        stubType,
        name: opts.name!,
      });

      if (res.length === 0) {
        throw new Error("Deployment not found.");
      }

      return res[0];
    }

    if (isUrl) {
      const url = new URL(opts.url!);
      const subdomain = url.hostname.split(".")[0];
      const regex = /(-v\d+|-latest)$/;
      const versionMatch = subdomain.match(regex);
      let version;
      if (versionMatch && versionMatch.length > 0) {
        version = versionMatch[0].replace("-", "");
      }

      const res = await this.list({
        subdomain: subdomain.replace(regex, ""),
        version,
      });

      if (res.length === 0) {
        throw new Error("Deployment not found.");
      }

      return res[0];
    }

    throw new Error(
      "Invalid parameters for get(). Must provide id, or name + stubType, or url."
    );
  }
}

export default new Deployments();

export class Deployment implements ResourceObject<DeploymentData> {
  data: DeploymentData;
  manager: Deployments;

  constructor(resource: Deployments, data: DeploymentData) {
    this.manager = resource;
    this.data = data;
  }

  public async refresh(): Promise<Deployment> {
    const data = await this.manager.get({ id: this.data.id });
    this.data = data.data;
    return this;
  }

  public async delete(): Promise<void> {
    return await this.manager.delete(this.data.id);
  }

  public async call(
    data: any,
    path: string = "",
    method: "GET" | "POST" = "POST"
  ): Promise<AxiosResponse<any>> {
    return await this.manager.request({
      method,
      url: this.httpUrl(path),
      data,
    });
  }

  public async realtime(
    path: string = "",
    onmessage?: (event: MessageEvent) => void
  ): Promise<WebSocket> {
    let _WebSocket: any;
    try {
      _WebSocket = WebSocket;
    } catch (e) {
      _WebSocket = (await import("ws")).WebSocket;
    }
    const ws = new _WebSocket(this.websocketUrl(path));

    ws.onmessage = (event: MessageEvent) => {
      onmessage && onmessage(event);
    };

    let isReady = false;
    ws.onopen = () => {
      isReady = true;
    };

    while (!isReady) {
      // TODO: Add timeout
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return ws;
  }

  public websocketUrl(path: string = ""): string {
    let version = `v${this.data.version}`;
    if (this.data.version === -1) {
      version = "latest";
    }

    return `${beamOpts.gatewayUrl?.replace("http", "ws")}/${
      this.stubDeploymentType
    }/${this.data.name}/${version}${path}?auth_token=${beamOpts.token}`;
  }

  public httpUrl(path: string = ""): string {
    let version = `v${this.data.version}`;
    if (this.data.version === -1) {
      version = "latest";
    }

    return `${beamOpts.gatewayUrl}/${this.stubDeploymentType}/${this.data.name}/${version}${path}`;
  }

  public get stubDeploymentType(): string {
    return this.data.stubType.split("/")[0];
  }
}
