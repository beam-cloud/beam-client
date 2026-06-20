export enum LifeCycleMethod {
  OnStart = "on_start",
}

export enum TaskStatus {
  Complete = "COMPLETE",
  Error = "ERROR",
  Pending = "PENDING",
  Running = "RUNNING",
  Cancelled = "CANCELLED",
  Retry = "RETRY",
  Timeout = "TIMEOUT",
}

export class TaskStatusHelper {
  static isComplete(status: TaskStatus): boolean {
    return [
      TaskStatus.Complete,
      TaskStatus.Error,
      TaskStatus.Cancelled,
      TaskStatus.Timeout,
    ].includes(status);
  }
}

export class TaskExitCode {
  static readonly SigTerm = -15;
  static readonly SigKill = -9;
  static readonly Success = 0;
  static readonly Error = 1;
  static readonly ErrorLoadingApp = 2;
  static readonly Cancelled = 3;
  static readonly Timeout = 4;
  static readonly Disconnect = 5;
}

export enum PythonVersion {
  Python3 = "python3",
  Python39 = "python3.9",
  Python310 = "python3.10",
  Python311 = "python3.11",
  Python312 = "python3.12",
  Micromamba38 = "micromamba3.8",
  Micromamba39 = "micromamba3.9",
  Micromamba310 = "micromamba3.10",
  Micromamba311 = "micromamba3.11",
  Micromamba312 = "micromamba3.12",
}

export type PythonVersionLiteral =
  | "python3"
  | "python3.9"
  | "python3.10"
  | "python3.11"
  | "python3.12"
  | "micromamba3.8"
  | "micromamba3.9"
  | "micromamba3.10"
  | "micromamba3.11"
  | "micromamba3.12";

export type PythonVersionAlias = PythonVersion | PythonVersionLiteral;

export enum GpuType {
  NoGPU = "",
  Any = "any",
  T4 = "T4",
  L4 = "L4",
  A10G = "A10G",
  A100_40 = "A100-40",
  A100_80 = "A100-80",
  H100 = "H100",
  A6000 = "A6000",
  RTX4090 = "RTX4090",
  L40S = "L40S",
}

export type GpuTypeLiteral =
  | ""
  | "any"
  | "T4"
  | "L4"
  | "A10G"
  | "A100-40"
  | "A100-80"
  | "H100"
  | "A6000"
  | "RTX4090"
  | "L40S";

export type GpuTypeAlias = GpuType | GpuTypeLiteral;
