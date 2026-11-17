/**
 * The messenger's desktop integration speaks Tauri (`__TAURI_INTERNALS__.invoke("local_api_endpoint")`,
 * `invoke("open_external_url")`, menu events through `plugin:event|listen`). On an NSH desktop the
 * same calls go to the shell through the host channel, named `tauri.<command>`, so that logic runs
 * unchanged and the shell answers the commands the Tauri shell did, with the same arguments.
 *
 * One command needs no shell, because NSH does it on every target: links open with `openUrl`
 * (`APP_COMMANDS`). On Windows and Linux,
 * where the shell posts no banners, the app answers the notification commands too (`app-banners.ts`
 * `bannerCommands`), and the folder dialog, the file manager and hiding the window
 * (`desktop-commands.ts`). The rest go to the shell.
 *
 * Installed only where a shell hosts the app (`host.available()`, not the web).
 */
import { host, openUrl, platform } from "nsh";
import { appBanners, bannerCommands } from "./app-banners";
import { answersDesktopCommands, DESKTOP_COMMANDS } from "./desktop-commands";

type Callback = (payload: unknown) => void;

const callbacks = new Map<number, Callback>();
const listeners = new Map<number, () => void>();
let nextCallback = 1;
let nextListener = 1;

/** The host function a Tauri command goes to: `[A-Za-z0-9_.:-]` only, as the host channel allows. */
export function hostName(command: string): string {
  return `tauri.${command.replace(/[^A-Za-z0-9_.:-]/g, ".")}`;
}

/** The Tauri commands the app answers itself, with NSH, by their Tauri names. */
/** System Settings' Sharing pane, where Screen Sharing is turned on for the remote screen: the one
 * settings address the app may open (`system_open.rs` `SHARING_SETTINGS_URL`). */
export const SHARING_SETTINGS_URL = "x-apple.systempreferences:com.apple.Sharing-Settings.extension";

/** `system_open.rs` `is_allowed_external_url`: http(s), mailto and the Sharing pane, nothing padded
 * or split by whitespace. */
export function allowedExternalUrl(url: string): boolean {
  if (!url || url.trim() !== url || /[\s\u0000-\u001f\u007f]/.test(url)) return false;
  return url.startsWith("https://") || url.startsWith("http://") || url.startsWith("mailto:") || url === SHARING_SETTINGS_URL;
}

export const APP_COMMANDS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  /** `system_open.rs` `open_external_url`. */
  open_external_url: async (args) => {
    const url = String(args.url ?? "");
    if (!allowedExternalUrl(url)) throw new Error("url not allowed");
    await openUrl(url);
    return null;
  },
};

let banners: Record<string, (args: Record<string, unknown>) => Promise<unknown>> | null = null;
/** The folder dialog, the file manager and hiding the window, where the shell leaves them to the app. */
let desktop: Record<string, (args: Record<string, unknown>) => Promise<unknown>> | null = null;

function windowId(): number {
  return Number((host.params as { windowId?: number }).windowId ?? 0);
}

/**
 * The commands that wait on a person or on a long exchange, with no time limit, as in the Tauri
 * shell: a folder dialog stays open as long as you look, the Touch ID or Windows Hello sheet waits
 * up to 110 s and pairing's setup channel up to 130 s (the shell times those out itself). The host
 * channel's own default would give up on them after 30 s.
 */
export const UNTIMED_COMMANDS: ReadonlySet<string> = new Set(["pick_workspace_folder", "remote_local_setup", "remote_native_confirmation"]);

/**
 * What a command rejects with, as the Tauri shell rejected it: the shell's own words, a string
 * (`desktop_channel_unavailable`, `not-installed`, …), which is what the messenger compares. NSH
 * rejects with an `Error` that carries them as its message.
 */
export function tauriRejection(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  return answer(command, args).catch((error: unknown) => {
    throw tauriRejection(error);
  });
}

function answer(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const own = APP_COMMANDS[command] ?? banners?.[command] ?? desktop?.[command];
  if (own) return own(args ?? {});
  if (command === "plugin:event|listen") {
    const event = String(args?.event ?? "");
    const handler = callbacks.get(Number(args?.handler));
    const id = nextListener++;
    if (handler) listeners.set(id, host.on(`tauri.event.${event}`, (payload) => handler({ event, payload })));
    return Promise.resolve(id);
  }
  if (command === "plugin:event|unlisten") {
    const id = Number(args?.eventId);
    listeners.get(id)?.();
    listeners.delete(id);
    return Promise.resolve(null);
  }
  return host.call(hostName(command), args ?? null, UNTIMED_COMMANDS.has(command) ? { timeout: 0 } : undefined);
}

function transformCallback(callback: Callback, once = false): number {
  const id = nextCallback++;
  callbacks.set(id, (payload) => {
    if (once) callbacks.delete(id);
    callback(payload);
  });
  return id;
}

export function installTauriBridge(): void {
  if (platform.os === "web" || !host.available()) return;
  const g = globalThis as Record<string, unknown>;
  if (g.__TAURI_INTERNALS__) return;
  const loop = appBanners();
  if (loop) banners = bannerCommands(loop, (command, args) => host.call(hostName(command), args), windowId);
  if (answersDesktopCommands(platform.os)) desktop = DESKTOP_COMMANDS;
  g.__TAURI_INTERNALS__ = { invoke, transformCallback };
}
