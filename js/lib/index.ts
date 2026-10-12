export { default } from "./client";
export { beamOpts } from "./client";
export type { BeamClientOpts } from "./client";

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
export type { SandboxCreateOptions } from "./resources/abstraction/sandbox";

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

// Persistent VM APIs use the existing SDK authentication, images and transports.
export { VM } from "./resources/abstraction/vm";
export { VMError } from "./resources/abstraction/vm-api";
export { VMArtifact, VMArtifacts } from "./resources/abstraction/vm-artifacts";
export { VMDesktop } from "./resources/abstraction/vm-desktop";
export { VMProcess, VMProcessManager, VMFileSystem, VMDocker } from "./resources/abstraction/vm-runtime";
export { VMTunnel } from "./resources/abstraction/vm-tunnel";
export type { VMPortForward, VMSyncHandle } from "./resources/abstraction/vm-access";
export * from "./types/vm";
