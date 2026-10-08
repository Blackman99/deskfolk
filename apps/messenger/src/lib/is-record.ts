/** A non-null object, for narrowing parsed JSON before its fields are read. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
