import { HttpError } from "./errors";
import { corsHeaders, originDecision } from "./origin";

export function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (origin && originDecision(origin) === "allowed") Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(body), { status, headers });
}

export function emptyResponse(status: number, origin: string | null): Response {
  const headers: Record<string, string> = {};
  if (origin && originDecision(origin) === "allowed") Object.assign(headers, corsHeaders(origin));
  return new Response(null, { status, headers });
}

export function fromError(error: unknown, origin: string | null): Response {
  if (error instanceof HttpError) {
    return jsonResponse(errorBody(error.code, error.message), error.status, origin);
  }
  return jsonResponse(errorBody("failed", "internal error"), 500, origin);
}

export function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header);
  return match?.[1] ?? null;
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(422, "invalid_args", "body must be JSON");
  }
}

export function matchPath(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  const a = pathname.split("/").filter(Boolean);
  const b = pattern.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (b[i]!.startsWith(":")) params[b[i]!.slice(1)] = decodeURIComponent(a[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
