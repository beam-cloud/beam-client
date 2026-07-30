export function sandboxFileContentUrl(
  containerId: string,
  sandboxPath: string,
): string {
  return `api/v1/gateway/pods/${containerId}/files/download/${encodeURIComponent(sandboxPath)}`;
}
