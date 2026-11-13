/**
 * What `scripts/ui-tests.ts` seeded and how to open the app on its runtime: a desktop window whose
 * shell answers the Tauri commands the runtime asks first.
 */
import { open, type OpenOptions } from "nsh/test";
import fixture from "./.fixture.json";

export const seeded = fixture as {
  origin: string;
  token: string;
  writerDirect: string;
  editorDirect: string;
  group: string;
  workspace: string;
  /** A directory outside the workspace holding `src/main.py`, for a project session a test makes. */
  projectDir: string;
  /** A Markdown file in neither the workspace nor `projectDir`, as an agent may cite from `~/Downloads`. */
  elsewhere: string;
  /** Whether the runtime can start a shell: a built pty helper (README); the terminal tests need one. */
  pty: boolean;
};

/** The app on the fixture's runtime. */
export function openApp(options: Partial<OpenOptions> = {}) {
  return openEntry("../App.tsx", {}, options);
}

/** One screen on its own (`stories/index.ts`), on the fixture's runtime; `params` reach it as `host.params`. */
export function openStory(name: string, options: Partial<OpenOptions> = {}, params: Record<string, unknown> = {}) {
  return openEntry("../Story.tsx", { ...params, story: name }, options);
}

function openEntry(entry: string, params: Record<string, unknown>, options: Partial<OpenOptions>) {
  const endpoint = { origin: seeded.origin, token: seeded.token };
  // `options.host.handlers` answer more of the shell's commands than the three every screen needs.
  const { host: extra, ...rest } = options;
  return open(entry, {
    platform: "macos",
    width: 1100,
    height: 760,
    locale: "zh-CN",
    network: "live",
    ...rest,
    host: {
      params: { ...endpoint, windowId: 1, material: "none", ...params },
      handlers: {
        "tauri.local_api_endpoint": endpoint,
        "tauri.app_version": "0.0.0",
        "tauri.window_material": "none",
        ...extra?.handlers,
      },
    },
  });
}

/** Calls the fixture's runtime directly, to seed what a test needs. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${seeded.origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${seeded.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}
