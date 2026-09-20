const codes = new Set([
  "invalid_args", "not_found", "conflict", "revision_conflict", "draining", "cancelled", "remote_denied",
  "credential_superseded", "receipt_expired", "key_write_pending", "request_unknown", "request_pending",
  "not_retryable", "probe_failed", "no_models", "file_limit", "stream_limit", "snapshot_limit",
  "host_permission",
  "lifecycle_pending", "lifecycle_failed", "lifecycle_unknown", "unauthorized", "not_a_member", "failed", "rejected",
]);
export function remoteError(code: unknown): { error: { code: string; message: string } } {
  return { error: { code: typeof code === "string" && codes.has(code) ? code : "rejected", message: "remote request rejected" } };
}
export async function responseError(response: Response): Promise<ReturnType<typeof remoteError>> {
  const value = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
  return remoteError(value?.error?.code);
}
