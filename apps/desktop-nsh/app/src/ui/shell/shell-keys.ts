/**
 * The window's own keys (`Shell.svelte`'s `<svelte:window onkeydown>`), as `keymap` bindings made
 * when the shell mounts: Escape steps out of the topmost layer, ⌘K opens search, ⌘O the workspace,
 * ⌘B folds the sidebar, and the workbench's keys (split, focus, resize, cycle tabs) on a desktop.
 *
 * The order the Svelte decided by listening on the window after every child, NSH decides by age:
 * the newest binding of a key wins, so a layer that binds Escape while it is open answers it first,
 * and this one is what is left. Typing keeps its keys (`when` default) except Escape, ⌘K and ⌘B,
 * which the Svelte took from inputs too. ⌘W is the native menu's on the Mac, as before.
 */
import { keymap } from "nsh";
import { WB_KEY_RESIZE_PX, type WorkbenchCommand } from "../../m/workbench/workbench-commands.ts";
import type { ShellState } from "./shell-state";

/** A keystroke the platform keeps or does not know is skipped, not fatal: the rest still bind. */
function bind(keys: string, run: () => void, options?: { when?: "always" | "notEditing" }): void {
  try {
    keymap.bind(keys, () => run(), options);
  } catch (error) {
    console.warn(`shell: cannot bind ${keys}: ${String(error)}`);
  }
}

const ARROWS = ["left", "right", "up", "down"] as const;

export function bindShellKeys(s: ShellState): void {
  bind("escape", () => void s.escape(), { when: "always" });
  bind("mod+k", () => s.openGlobalSearch(), { when: "always" });
  bind("mod+o", () => {
    if (s.searchOpen() || s.showOnboarding()) return;
    s.artifact.toggleWorkspaceExplorer();
  });
  bind("mod+b", () => {
    if (s.sidebarColumn()) s.toggleSidebar();
  }, { when: "always" });

  const workbenchKey = (command: WorkbenchCommand) => () => {
    if (s.wide()) s.workbench.runWorkbenchCommand(command);
  };
  bind("ctrl+tab", workbenchKey({ kind: "cycle-tab", dir: 1 }), { when: "notEditing" });
  bind("ctrl+shift+tab", workbenchKey({ kind: "cycle-tab", dir: -1 }), { when: "notEditing" });
  bind("mod+\\", workbenchKey({ kind: "split", axis: "row", side: "after" }), { when: "notEditing" });
  bind("mod+shift+\\", workbenchKey({ kind: "split", axis: "column", side: "after" }), { when: "notEditing" });
  for (const dir of ARROWS) {
    bind(`mod+alt+${dir}`, workbenchKey({ kind: "focus", dir }), { when: "notEditing" });
    bind(`mod+alt+shift+${dir}`, workbenchKey({ kind: "resize", dir, px: WB_KEY_RESIZE_PX }), { when: "notEditing" });
  }
  bind("mod+alt+0", workbenchKey({ kind: "equalise" }), { when: "notEditing" });
}
