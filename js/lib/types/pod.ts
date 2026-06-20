import BaseData from "./base";
import { GpuType } from "./image";

export { GpuType };

export enum EPodStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  STOPPED = "STOPPED",
  ERROR = "ERROR",
  TIMEOUT = "TIMEOUT",
  COMPLETE = "COMPLETE",
}

export interface PodVolume {
  name: string;
  mountPath: string;
}

export interface PodInstanceData {
  containerId: string;
  url: string;
  ok: boolean;
  errorMsg?: string;
}

export interface CreatePodRequest {
  stubId: string;
  checkpointId?: string;
}

export interface CreatePodResponse {
  ok: boolean;
  containerId: string;
  errorMsg?: string;
  stubId?: string;
}

export interface StopContainerRequest {
  containerId: string;
}

export interface StopContainerResponse {
  ok: boolean;
  errorMsg?: string;
}

export interface PodSandboxExecRequest {
  containerId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface PodSandboxExecResponse {
  ok: boolean;
  errorMsg?: string;
  pid: number;
}
export interface PodSandboxStatusRequest {
  containerId: string;
  pid: number;
}

export interface PodSandboxStatusResponse {
  ok: boolean;
  errorMsg?: string;
  status: string;
  exitCode: number;
}

export interface PodSandboxStdoutRequest {
  containerId: string;
  pid: number;
}

export interface PodSandboxStdoutResponse {
  ok: boolean;
  errorMsg?: string;
  stdout: string;
}

export interface PodSandboxStderrRequest {
  containerId: string;
  pid: number;
}

export interface PodSandboxStderrResponse {
  ok: boolean;
  errorMsg?: string;
  stderr: string;
}

export interface PodSandboxKillRequest {
  containerId: string;
  pid: number;
}

export interface PodSandboxKillResponse {
  ok: boolean;
  errorMsg: string;
}

export interface PodSandboxListProcessesRequest {
  containerId: string;
}

export interface PodSandboxProcessInfo {
  running: boolean;
  pid: number;
  cmd: string;
  cwd: string;
  env: string[];
  exitCode: number;
}

export interface PodSandboxListProcessesResponse {
  ok: boolean;
  errorMsg?: string;
  processes?: PodSandboxProcessInfo[];
  // Older gateways returned only pids. Keep the field typed so old responses
  // still hydrate process handles.
  pids?: number[];
}

export interface PodSandboxUploadFileRequest {
  containerId: string;
  containerPath: string;
  mode: number;
  data: string;
}

export interface PodSandboxUploadFileResponse {
  ok: boolean;
  errorMsg: string;
}

export interface PodSandboxDownloadFileRequest {
  containerId: string;
  containerPath: string;
}

export interface PodSandboxDownloadFileResponse {
  ok: boolean;
  errorMsg: string;
  data: string;
}

export interface PodSandboxListFilesRequest {
  containerId: string;
  containerPath: string;
}

export interface PodSandboxListFilesResponse {
  ok: boolean;
  errorMsg: string;
  files: PodSandboxFileInfo[];
}

export interface PodSandboxDeleteFileRequest {
  containerId: string;
  containerPath: string;
}

export interface PodSandboxDeleteFileResponse {
  ok: boolean;
  errorMsg: string;
}

export interface PodSandboxCreateDirectoryRequest {
  containerId: string;
  containerPath: string;
  mode: number;
}

export interface PodSandboxCreateDirectoryResponse {
  ok: boolean;
  errorMsg: string;
}

export interface PodSandboxDeleteDirectoryRequest {
  containerId: string;
  containerPath: string;
}

export interface PodSandboxStatFileRequest {
  containerId: string;
  containerPath: string;
}

export interface PodSandboxStatFileResponse {
  ok: boolean;
  errorMsg: string;
  fileInfo: PodSandboxFileInfo;
}

export interface PodSandboxFileInfo {
  mode: number;
  size: number;
  modTime: number;
  owner: string;
  group: string;
  isDir: boolean;
  name: string;
  permissions: number;
}

export interface PodSandboxReplaceInFilesRequest {
  containerId: string;
  containerPath: string;
  pattern: string;
  newString: string;
}

export interface PodSandboxReplaceInFilesResponse {
  ok: boolean;
  errorMsg: string;
}

export interface PodSandboxExposePortRequest {
  containerId: string;
  stubId: string;
  port: number;
}

export interface PodSandboxExposePortResponse {
  ok: boolean;
  url: string;
  errorMsg: string;
}

export interface PodSandboxUpdateNetworkPermissionsRequest {
  containerId: string;
  stubId: string;
  blockNetwork: boolean;
  allowList: string[];
}

export interface PodSandboxUpdateNetworkPermissionsResponse {
  ok: boolean;
  errorMsg: string;
}

export interface PodSandboxListUrlsResponse {
  ok: boolean;
  urls: Record<string, string>;
  errorMsg: string;
}

// No unexpose port request?

export interface PodSandboxFindInFilesRequest {
  containerId: string;
  containerPath: string;
  pattern: string;
}

export interface PodSandboxFindInFilesResponse {
  ok: boolean;
  errorMsg: string;
  results: FileSearchResult[];
}

export interface FileSearchPosition {
  line: number;
  column: number;
}

export interface FileSearchRange {
  start: FileSearchPosition;
  end: FileSearchPosition;
}

export interface FileSearchMatch {
  range: FileSearchRange;
  content: string;
}

export interface FileSearchResult {
  path: string;
  matches: FileSearchMatch[];
}

export interface PodSandboxConnectRequest {
  containerId: string;
}

export interface PodSandboxConnectResponse {
  ok: boolean;
  errorMsg: string;
  stubId: string;
}

export interface PodSandboxUpdateTtlRequest {
  containerId: string;
  ttl: number;
}

export interface PodSandboxUpdateTtlResponse {
  ok: boolean;
  errorMsg: string;
}

export interface PodSandboxSnapshotRequest {
  stubId: string;
  containerId: string;
}

export interface PodSandboxSnapshotResponse {
  ok: boolean;
  errorMsg: string;
  checkpointId: string;
}

export interface PodSandboxCreateImageFromFilesystemRequest {
  stubId: string;
  containerId: string;
}

export interface PodSandboxCreateImageFromFilesystemResponse {
  ok: boolean;
  errorMsg: string;
  imageId: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
}

// Store requests here?
