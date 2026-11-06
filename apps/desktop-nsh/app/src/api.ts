/**
 * The runtime this window talks to. A desktop shell hands over its origin and token in
 * `host.params` (read from the dev data directory's `local-api.json`); on the web the page's host
 * module answers `host.call("runtime.endpoint")`. The app never builds an address itself, so it
 * cannot drift to the stable instance's port.
 */
import { host } from "nsh";

type Params = { origin: string; token: string; windowId: number; material: string; openSession: string; pane: string; pdfPath: string; scrollProbe: boolean; terminal: string };

const params = host.params as Partial<Params>;

let origin = params.origin ?? "";
let token = params.token ?? "";

let known: Promise<void> | null = null;

/** Settles once the runtime's address is known; asked of the page's host the first time. */
export function ready(): Promise<void> {
  known ??=
    origin && token
      ? Promise.resolve()
      : host.call("runtime.endpoint").then((answer) => {
          const endpoint = answer as { origin?: string; token?: string };
          origin = endpoint.origin ?? "";
          token = endpoint.token ?? "";
        });
  return known;
}

export function authToken(): string {
  return token;
}

export function apiOrigin(): string {
  return origin;
}
export const windowId: number = params.windowId ?? 0;
export const glass: boolean = params.material === "glass";
/** Development checks: the conversation and pane a window opens on (`--open-session`, `--pane`). */
export const initialSession: string | null = params.openSession ?? null;
export const initialPane: string | null = params.pane ?? null;
export const initialPdf: string = params.pdfPath ?? "";
export const scrollProbe: boolean = params.scrollProbe === true;
/** Development comparison: the macOS NSView terminal (`--terminal native`) instead of the canvas. */
export const nativeTerminal: boolean = params.terminal === "native";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  await ready();
  if (!origin) throw new ApiError(0, "no_runtime", "the shell gave no runtime address");
  const res = await fetch(`${origin}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    let code = "http_error";
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // Not JSON; the status says enough.
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function eventsUrl(): string {
  return `${origin.replace(/^http/, "ws")}/v1/events`;
}
