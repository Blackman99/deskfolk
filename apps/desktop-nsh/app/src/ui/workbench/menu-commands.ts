/**
 * The workbench's window-menu commands for views the workbench is not handed to: the pane menu's
 * Equalise and Reset Layout on Windows and Linux, where 0.4.0 had them in its window's own
 * menu bar (the native app draws no menu bar there; on the Mac the View menu has them). The shell
 * provides its workbench's `runMenuCommand` as it mounts.
 */
let runner: ((id: string) => void) | null = null;

export function provideMenuCommands(run: (id: string) => void): void {
  runner = run;
}

export function runMenuCommand(id: string): void {
  runner?.(id);
}

/** Whether the pane menu carries the window menu's layout commands here (no menu bar of its own). */
export function layoutCommandsInPaneMenu(os: string): boolean {
  return os === "windows" || os === "linux";
}
