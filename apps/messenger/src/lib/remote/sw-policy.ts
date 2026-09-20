/** Service worker may cache hashed immutable assets only. Navigation stays network/no-store. */
export function isImmutableAsset(url: string): boolean {
  try {
    const path = new URL(url, "https://invalid.invalid").pathname;
    return path.startsWith("/_app/immutable/");
  } catch {
    return false;
  }
}

export function shouldCacheRequest(request: { method: string; mode: RequestMode; url: string }): boolean {
  if (request.method !== "GET") return false;
  if (request.mode === "navigate") return false;
  return isImmutableAsset(request.url);
}
