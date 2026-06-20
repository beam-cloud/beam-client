import { serializeNestedBaseObject } from "../types/base";
import beamClient, { beamOpts } from "../index";
import axios, { AxiosRequestConfig } from "axios";

export interface ResourceObject<ResourceType> {
  data: ResourceType;
  manager: APIResource<any, ResourceType>;
}

abstract class APIResource<Resource, ResourceType> {
  protected object: string;

  constructor() {}

  protected abstract _constructResource(data: ResourceType): Resource;

  public copyValues(data: any): void {
    // This copy values of data into `this` object only if the key exists in `this`
    (Object.keys(this) as Array<keyof this>).forEach((key) => {
      if (data.hasOwnProperty(key)) {
        this[key] = data[key];
      }
    });
  }

  public async request<ResponseType>(
    config: AxiosRequestConfig
  ): Promise<ResponseType> {
    return await beamClient.request(config);
  }

  public async get({ id }: { id: string }): Promise<Resource> {
    try {
      const resp = await beamClient.request({
        url: `/api/v1/${this.object}/${beamOpts.workspaceId}/${id}`,
      });

      const serializedData = serializeNestedBaseObject(resp.data);
      return this._constructResource(serializedData);
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          const objectName = this.object
            ? this.object.charAt(0).toUpperCase() + this.object.slice(1)
            : "Resource";
          throw new Error(`${objectName} not found`);
        }

        const statusText = error.response?.statusText || "Request failed";
        throw new Error(
          `Failed to retrieve ${this.object || "resource"}: ${
            status || ""
          } ${statusText}`.trim()
        );
      }
      throw error;
    }
  }

  // TODO: Add pagination types/parsing (Check frontend for reference)
  public async list(opts?: any): Promise<Resource[]> {
    if (!opts) {
      opts = {};
    }

    const params = beamClient._parseOptsToURLParams(opts);
    const resp = await beamClient.request({
      url: `/api/v1/${this.object}/${
        beamOpts.workspaceId
      }?${params.toString()}`,
    });

    if (resp.status !== 200) {
      throw new Error(`Failed to list deployments: ${resp.statusText}`);
    }

    if (!resp.data.data) {
      return [];
    }
    return resp.data.data.map((d: ResourceType) => {
      const serializedData = serializeNestedBaseObject(d);

      return this._constructResource(serializedData);
    });
  }

  public async delete(id: string): Promise<void> {
    return await beamClient.request({
      method: "DELETE",
      url: `/api/v1/${this.object}/${beamOpts.workspaceId}/${id}`,
    });
  }
}

export default APIResource;
