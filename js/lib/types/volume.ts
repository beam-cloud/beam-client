import BaseData from "./base";

export interface VolumeData extends BaseData {
  name: string;
  mountPath: string;
}

export interface GetOrCreateVolumeRequest {
  name: string;
}

export interface GetOrCreateVolumeResponse {
  ok: boolean;
  volume?: VolumeData;
  error?: string;
}

// Volume export format for stub requests - matches Python VolumeGateway
export interface VolumeGateway {
  id?: string;
  mountPath: string;
  config?: VolumeConfigGateway;
}

// Configuration for cloud bucket volumes
export interface CloudBucketConfig {
  readOnly?: boolean;
  forcePathStyle?: boolean;
  accessKey?: string;
  secretKey?: string;
  endpoint?: string;
  region?: string;
}

// Gateway configuration for volume mounting - matches Python MountPointConfig
export interface VolumeConfigGateway {
  bucketName?: string;
  accessKey?: string;
  secretKey?: string;
  endpointUrl?: string;
  region?: string;
  readOnly?: boolean;
  forcePathStyle?: boolean;
}