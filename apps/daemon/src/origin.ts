/** Origin whitelist from the local-api contract. No Origin is allowed (curl, tests). */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function hostName(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function originDecision(origin: string | null): "missing" | "allowed" | "forbidden" {
  if (!origin) return "missing";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "forbidden";
  }
  const host = hostName(url);
  if (url.protocol === "tauri:" && host === "localhost") {
    return "allowed";
  }
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(host)) {
    return "allowed";
  }
  return "forbidden";
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    // Chrome treats some loopback-to-loopback fetches as local-network access.
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Allow-Local-Network": "true",
    Vary: "Origin",
  };
}
