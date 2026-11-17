/**
 * The Tauri commands the Windows and Linux shells leave to the app, answered with NSH (the macOS
 * shell answers them itself, `host/src/host_calls.rs`):
 *
 * - `pick_workspace_folder({ current, title })`: the system's folder dialog (`Files.pickFolder`,
 *   `app/native/src/files.rs`), the folder picked or null when cancelled.
 * - `open_workspace_path({ path, reveal })`: opens a file with its app or shows it in the file
 *   manager (`Files.openPath`); a file that would run is shown, as in the Tauri app.
 * - `hide_main_window`: puts the window away (⌘W / Ctrl+W once no tab is left to close).
 */
import { currentWindow } from "nsh/desktop";
import { Files } from "deskfolk/native";

export const DESKTOP_COMMANDS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  pick_workspace_folder: async (args) => {
    const title = typeof args.title === "string" ? args.title : "";
    const current = typeof args.current === "string" ? args.current : "";
    return (await Files.pickFolder(title, current)) ?? null;
  },
  open_workspace_path: async (args) => {
    const path = String(args.path ?? "");
    await Files.openPath(path, args.reveal === true);
    return null;
  },
  hide_main_window: async () => {
    currentWindow().hide();
    return null;
  },
};

/** Whether this shell leaves those commands to the app. */
export function answersDesktopCommands(os: string): boolean {
  return os === "windows" || os === "linux";
}
