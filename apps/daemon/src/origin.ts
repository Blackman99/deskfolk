/** Origin whitelist from the local-api contract. No Origin is allowed (curl, tests). */

export function originDecision(origin: string | null): "missing" | "allowed" | "forbidden" {
  if (!origin) return "missing";
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "forbidden";
  }
  if (url.protocol === "tauri:" && (url.hostname === "localhost" || url.host === "localhost")) {
    return "allowed";
  }
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return "allowed";
  }
  return "forbidden";
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    Vary: "Origin",
  };
}
