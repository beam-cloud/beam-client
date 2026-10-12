import axios, { AxiosRequestConfig } from "axios";
import beamClient, { beamOpts } from "../../client";
import type { VMArtifactInfo, VMInfo, VMSpec } from "../../types/vm";

/** VM management failures preserve HTTP status for agent recovery decisions. */
export class VMError extends Error {
  constructor(
    message: string,
    public status?: number,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "VMError";
  }
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason || new VMError("Operation aborted");
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason || new VMError("Operation aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function quote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export async function vmBasePath(): Promise<string> {
  if (!beamOpts.workspaceId) {
    const workspace = await beamClient._getWorkspace();
    beamOpts.workspaceId =
      workspace.external_id || workspace.id || workspace.workspace_id;
    if (!beamOpts.workspaceId)
      throw new VMError("Unable to resolve Beam workspace");
  }
  return `/api/v1/vm/${encodeURIComponent(beamOpts.workspaceId)}`;
}

export async function vmRequest<T = any>(
  method: string,
  path = "",
  data?: unknown,
  opts: AxiosRequestConfig = {},
): Promise<T> {
  const url = (await vmBasePath()) + path;
  const deadline = Date.now() + (opts.timeout ?? 240_000);
  while (true) {
    checkAbort(opts.signal as AbortSignal | undefined);
    try {
      const response = await beamClient.request({
        ...opts,
        method,
        url,
        data,
        timeout: Math.max(1, deadline - Date.now()),
      });
      return response.data as T;
    } catch (error) {
      if (!axios.isAxiosError(error)) throw error;
      const status = error.response?.status;
      const body = error.response?.data;
      const message =
        typeof body === "string"
          ? body
          : body?.message || body?.error || body?.error_msg || error.message;
      // Only lifecycle lock conflicts are safe to repeat. Other 409s are actionable.
      if (
        status === 409 &&
        message.includes("operation already in progress") &&
        Date.now() < deadline
      ) {
        await delay(
          Math.min(250, deadline - Date.now()),
          opts.signal as AbortSignal | undefined,
        );
        continue;
      }
      throw new VMError(message, status, error);
    }
  }
}

/** Convert protocol fields, while retaining caller-owned map keys verbatim. */
export function vmDecode(value: any): any {
  if (Array.isArray(value)) return value.map(vmDecode);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    const name = key.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    result[name] = [
      "metadata",
      "env",
      "urls",
      "memory_disk_snapshots",
    ].includes(key)
      ? item
      : vmDecode(item);
  }
  return result;
}

export function decodeSpec(raw: any): VMSpec {
  const spec = vmDecode(raw) as VMSpec;
  spec.cpu = raw.cpu / 1000;
  return spec;
}
export function decodeVM(raw: any): VMInfo {
  return { ...vmDecode(raw), spec: decodeSpec(raw.spec) };
}
export function decodeArtifact(raw: any): VMArtifactInfo {
  return { ...vmDecode(raw), spec: decodeSpec(raw.spec) };
}

export function idleSeconds(config: {
  idleTimeout?: number;
  ttl?: number;
}): number | undefined {
  if (
    config.idleTimeout !== undefined &&
    config.ttl !== undefined &&
    config.idleTimeout !== config.ttl
  )
    throw new VMError("Choose idleTimeout or ttl, or give them the same value");
  const value = config.idleTimeout ?? config.ttl;
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < 0 || value > 31_536_000)
  )
    throw new VMError(
      "idleTimeout must be whole seconds between 0 and 31536000",
    );
  return value;
}
