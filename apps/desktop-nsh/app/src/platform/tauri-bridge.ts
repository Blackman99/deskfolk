/**
 * The messenger's desktop integration speaks Tauri (`__TAURI_INTERNALS__.invoke("local_api_endpoint")`,
 * `invoke("open_external_url")`, menu events through `plugin:event|listen`). On an NSH desktop the
 * same calls go to the shell through the host channel, named `tauri.<command>`, so that logic runs
 * unchanged and the shell answers the commands the Tauri shell did, with the same arguments.
 *
 * A few commands need no shell, because NSH does them on every target: links open with `openUrl`,
 * the clipboard's text comes from `Clipboard`, the window theme is the app's colour scheme
 * (`APP_COMMANDS`). The rest go to the shell.
 *
 * Installed only where a shell hosts the app (`host.available()`, not the web).
 */
import { Clipboard, host, openUrl, platform, setColorScheme } from "nsh";

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
export const APP_COMMANDS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  /** `system_open.rs` `open_external_url`: http(s) and mailto only. */
  open_external_url: async (args) => {
    const url = String(args.url ?? "").trim();
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error("only http(s) and mailto links open outside");
    await openUrl(url);
    return null;
  },
  /** `system_open.rs` `read_clipboard_text`: the text, or null when there is none. */
  read_clipboard_text: async () => (await Clipboard.readText()) || null,
  /** The window's appearance (`window-chrome.ts` `syncWindowTheme`): null follows the system. */
  "plugin:window|set_theme": async (args) => {
    const value = args.value;
    setColorScheme(value === "light" || value === "dark" ? value : "system");
    return null;
  },
};

function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const own = APP_COMMANDS[command];
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
  return host.call(hostName(command), args ?? null);
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
  g.__TAURI_INTERNALS__ = { invoke, transformCallback };
}
