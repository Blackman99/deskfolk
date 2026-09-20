/** Pinned HTTPS origin: no slash, userinfo, or rewritten host. */
export function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("expected pinned HTTPS origin");
  }
  return value;
}
