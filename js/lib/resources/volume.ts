import BeamClient from "../";
import {
  CloudBucketConfig,
  GetOrCreateVolumeResponse,
  VolumeGateway,
} from "../types/volume";

export class Volume {
  public name: string;
  public ready: boolean = false;
  public volumeId?: string;
  public mountPath: string;

  constructor(name: string, mountPath: string) {
    /**
     * Creates a Volume instance.
     *
     * Parameters:
     *   name: The name of the volume, a descriptive identifier for the data volume.
     *         Note that when using an external provider, the name must be the same as the bucket name.
     *   mountPath: The absolute path where the volume is mounted within the container (e.g. "/mnt/weights").
     *
     * Example:
     *   ```typescript
     *   import { Volume } from "@beamcloud/beam-js";
     *
     *   // Shared Volume
     *   const sharedVolume = new Volume("model_weights", "/mnt/weights");
     *
     *   const stub = new StubBuilder({
     *     volumes: [sharedVolume]
     *   });
     *   ```
     */
    this.name = name;
    this.mountPath = mountPath;
  }

  public async getOrCreate(): Promise<boolean> {
    try {
      const response = await BeamClient.request({
        method: "POST",
        url: "/api/v1/gateway/volumes",
        data: { name: this.name, mount_path: this.mountPath },
      });

      const data = response.data as GetOrCreateVolumeResponse;

      if (data.ok && data.volume) {
        this.ready = true;
        this.volumeId = data.volume.id;
        return true;
      }

      console.error(
        `Failed to get or create volume: ${data.error || "Unknown error"}`
      );
      return false;
    } catch (error) {
      console.error(`Failed to get or create volume ${this.name}:`, error);
      return false;
    }
  }

  public export(): VolumeGateway {
    return {
      id: this.volumeId,
      mountPath: this.mountPath,
    };
  }
}

export class CloudBucket extends Volume {
  public config: CloudBucketConfig;

  constructor(name: string, mountPath: string, config: CloudBucketConfig = {}) {
    super(name, mountPath);
    this.config = config;
  }

  public async getOrCreate(): Promise<boolean> {
    this.ready = true;
    return true;
  }

  public export(): VolumeGateway {
    return {
      mountPath: this.mountPath,
      config: {
        bucketName: this.name,
        accessKey: this.config.accessKey,
        secretKey: this.config.secretKey,
        endpointUrl: this.config.endpoint,
        region: this.config.region,
        readOnly: this.config.readOnly,
        forcePathStyle: this.config.forcePathStyle,
      },
    };
  }
}
