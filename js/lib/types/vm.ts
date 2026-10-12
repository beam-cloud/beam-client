import type { Image } from "../resources/abstraction/image";
import type { Volume } from "../resources/volume";
import type { ExecOptions } from "./pod";
import type { VolumeGateway } from "./volume";

export type VMStatus =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "pausing"
  | "paused"
  | "deleting"
  | "deleted"
  | "error";
export type VMIdleAction = "stop" | "pause";

/** An additional persistent ext4 disk. The VM root is managed automatically. */
export interface VMDisk {
  name: string;
  size: string;
  mountPath: string;
  filesystem?: "ext4";
  driver?: "qcow";
  readOnly?: boolean;
}

/** CPU-only persistent machine configuration. Omitted fields inherit a seed's configuration. */
export interface VMConfig {
  name?: string;
  image?: Image;
  /** CPU cores, or millicores such as "1000m". Default: 4 cores. */
  cpu?: number | string;
  /** MiB, or a quantity such as "8Gi". Default: 8192 MiB. */
  memory?: number | string;
  /** Writable root capacity, 1–100 GiB. Default: "50Gi". */
  diskSize?: string;
  desktop?: boolean;
  dockerEnabled?: boolean;
  env?: Record<string, string> | string[];
  secrets?: (string | { name: string })[];
  ports?: number[];
  privatePorts?: number[];
  protectedPorts?: number[];
  ssh?: boolean;
  sshPublicKey?: string;
  /** Local SSH identity; a persistent Ed25519 key is generated if omitted. */
  sshKeyPath?: string;
  /** Idle seconds until stop/pause. Zero keeps running. Does not delete the VM. */
  idleTimeout?: number;
  /** Alias for Python/CLI ttl, in idle seconds. */
  ttl?: number;
  idleAction?: VMIdleAction;
  autoResume?: boolean;
  pool?: string;
  template?: string;
  snapshot?: string;
  metadata?: Record<string, string>;
  blockNetwork?: boolean;
  allowList?: string[];
  disks?: VMDisk[];
  volumes?: Volume[];
  /** Reuse the UUID and identical configuration to retry creation safely. */
  requestId?: string;
}

export interface VMWaitOptions {
  /** Operation deadline in milliseconds. Default: 180000. */
  timeoutMs?: number;
  /** Also wait for terminal, SSH and desktop services. */
  services?: boolean;
  signal?: AbortSignal;
}
export interface VMCreateOptions extends VMWaitOptions {
  wait?: boolean;
}
export interface VMStartOptions extends VMCreateOptions {
  /** Discard saved RAM and cold boot from disk. */
  cold?: boolean;
}
export interface VMConnectOptions extends VMStartOptions {
  sshKeyPath?: string;
}
export interface VMListOptions {
  all?: boolean;
  metadata?: Record<string, string>;
  status?: VMStatus;
}
export interface VMUpdateOptions {
  idleTimeout?: number;
  ttl?: number;
  idleAction?: VMIdleAction;
  autoResume?: boolean;
  /** Replaces the complete map. Pass {} to clear it. */
  metadata?: Record<string, string>;
  blockNetwork?: boolean;
  allowList?: string[];
}
export interface VMExecOptions extends ExecOptions {
  /** Text or bytes uploaded before execution, followed by EOF. */
  stdin?: string | Uint8Array;
}
export interface VMProcessWaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Resolved specification. CPU is exposed in cores; memory is in MiB. Env is redacted by the API. */
export interface VMSpec {
  imageId: string;
  cpu: number;
  memory: number;
  diskSize: string;
  desktop: boolean;
  dockerEnabled: boolean;
  ssh: boolean;
  sshPublicKey?: string;
  idleTimeout: number;
  idleAction?: VMIdleAction;
  autoResume: boolean;
  blockNetwork: boolean;
  allowList?: string[];
  ports?: number[];
  privatePorts?: number[];
  protectedPorts?: number[];
  pool?: string;
  secrets?: string[];
  disks?: VMDisk[];
  volumes?: VolumeGateway[];
  sourceSnapshotId?: string;
}
export interface VMInfo {
  id: string;
  name: string;
  handle: string;
  metadata?: Record<string, string>;
  spec: VMSpec;
  stubId?: string;
  containerId?: string;
  desiredState: string;
  status: VMStatus;
  error?: string;
  generation: number;
  launchAttempts: number;
  everRunning: boolean;
  rootSnapshotId?: string;
  stopSnapshotId?: string;
  memoryCheckpointId?: string;
  memoryDiskSnapshots?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
  terminalUrl?: string;
  desktopUrl?: string;
  urls: Record<number, string>;
  execReady?: boolean;
}
export interface VMArtifactInfo {
  id: string;
  name: string;
  vmId: string;
  kind: "snapshot" | "template";
  rootSnapshotId: string;
  spec: VMSpec;
  createdAt: string;
  description?: string;
}
export interface VMArtifactCreateOptions {
  name?: string;
  description?: string;
  vm?: string;
}
export interface VMArtifactListOptions {
  vmId?: string;
}
export interface VMMetrics {
  timestamp: number;
  cpuCount: number;
  cpuUsedPercent: number;
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
}
export interface VMLogsOptions {
  unit?: string;
  session?: string;
  pid?: number;
  follow?: boolean;
  lines?: number;
}
export interface VMPromptOptions {
  agent?: "claude" | "codex";
  background?: boolean;
  cwd?: string;
  env?: Record<string, string>;
}
export interface VMPromptSession {
  session: string;
  unit: string;
}
export interface VMSyncOptions {
  remotePath?: string;
  watch?: boolean;
  /** Defaults to [".git"]. Passed as literal rsync exclusions. */
  exclude?: string[];
  signal?: AbortSignal;
}
export interface VMSSHOptions {
  signal?: AbortSignal;
}
export interface VMSCPOptions extends VMSSHOptions {
  recursive?: boolean;
}
export interface VMTunnelOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface VMPortForwardOptions extends VMTunnelOptions {
  localPort?: number;
  host?: string;
}
export interface VMDesktopClickOptions {
  x?: number;
  y?: number;
  button?: "left" | "middle" | "right";
  count?: number;
}
export interface VMDesktopScrollOptions {
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
}
