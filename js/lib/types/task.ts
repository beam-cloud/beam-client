import BaseData from "./base";

export interface TaskPolicyConfig {
  maxRetries?: number;
  timeout?: number;
  ttl?: number;
}

/**
 * Task policy for a function. This helps manage the lifecycle of an individual task.
 *
 * Parameters:
 *   maxRetries: The maximum number of times a task will be retried if the container crashes. Default is 0.
 *   timeout: The maximum number of seconds a task can run before it times out. Default is 0.
 *            Use a positive value to override the platform default.
 *   ttl: The expiration time for a task in seconds. Default is 0. When set, must be greater than 0 and
 *        less than 24 hours (86400 seconds).
 */
export class TaskPolicy {
  public maxRetries: number;
  public timeout: number;
  public ttl: number;

  constructor(config: TaskPolicyConfig = {}) {
    this.maxRetries = config.maxRetries ?? 0;
    this.timeout = config.timeout ?? 0;
    this.ttl = config.ttl ?? 0;
  }
}

export interface TaskData extends BaseData {
  status: ETaskStatus;
  containerId: string;
  startedAt: string;
  endedAt: string;
  stubId: string;
  stubName: string;
  workspaceId: string;
  workspaceName: string;
}

export interface ListTasksResponse {
  ok: boolean;
  errMsg: string;
  tasks: TaskData[];
  total: number;
}

export enum ETaskStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  ERROR = "ERROR",
  TIMEOUT = "TIMEOUT",
  RETRY = "RETRY",
  COMPLETE = "COMPLETE",
  CANCELLED = "CANCELLED",
  EXPIRED = "EXPIRED",
}
