/**
 * The window's own keys (`Shell.svelte`'s `<svelte:window onkeydown>`), as `keymap` bindings made
 * when the shell mounts: Escape steps out of the topmost layer, ⌘, opens settings, ⌘K / ⌘⇧K opens
 * search, ⌘O toggles the workspace, and ⌘B folds the sidebar. Workbench shortcuts (splits, focus,
 * resize, equalise, cycle tabs) are bound once by `Workbench` itself (`workbench-ops.ts`).
 *
 * The order the Svelte decided by listening on the window after every child, NSH decides by age:
 * the newest binding of a key wins, so a layer that binds Escape while it is open answers it first,
 * and this one is what is left. Typing keeps its keys (`when` default) except Escape, ⌘,, ⌘K, ⌘⇧K
 * and ⌘B. On macOS NSH's keymap swallows matched keys before AppKit's menu bar, so keeping these
 * bound alongside the native menu never double-triggers while keeping headless tests working; ⌘W is
 * the native menu's on the Mac, and Ctrl+W is bound here on Windows and Linux.
 */
import { keymap, platform, type KeyBindingOptions } from "nsh";
import { shouldSearchOnShiftK } from "../../m/search/shortcuts.ts";
import type { ShellState } from "./shell-state";

/** A keystroke the platform keeps or does not know is skipped, not fatal: the rest still bind. */
function bind(keys: string, run: () => void, options?: Pick<KeyBindingOptions, "when" | "passThrough">): void {
  try {
    keymap.bind(keys, () => run(), options);
  } catch (error) {
    console.warn(`shell: cannot bind ${keys}: ${String(error)}`);
  }
}

export function bindShellKeys(s: ShellState): void {
  bind("escape", () => void s.escape(), { when: "always" });
  bind("mod+,", () => s.runShellCommand("app-settings"), { when: "always" });
  bind("mod+k", () => s.runShellCommand("app-search"), { when: "always" });
  if (platform.os === "windows" || platform.os === "linux") {
    bind(
      "mod+shift+k",
      () => {
        if (shouldSearchOnShiftK(platform.os, s.wide() && s.workbench.terminalInFront())) s.runShellCommand("app-search");
      },
      { when: "always", passThrough: true },
    );
  } else {
    bind("mod+shift+k", () => s.runShellCommand("app-search"), { when: "always" });
  }
  bind("mod+o", () => s.runShellCommand("app-workspace"));
  bind("mod+b", () => s.runShellCommand("view-toggle-sidebar"), { when: "always" });

  // Workbench shortcuts (⌘\, ⇧⌘\, Ctrl+Tab, ⌘⌥arrows, ⌘⌥0) are bound once by `Workbench` itself
  // via `bindWorkbenchKeys` (`workbench-ops.ts`) while the workbench is mounted.
  // Ctrl+W closes the tab in front of you on Windows and Linux, and puts the window away once none
  // is left, as 0.4.0's menu did there (`matchesCloseTab`); the Mac's Window menu has ⌘W. A
  // terminal keeps Ctrl+W (readline's delete a word back): with one in front of the focused pane
  // the key goes on to it, so typing never puts the shell away. Ctrl+Shift+W closes the tab from
  // anywhere, as in Windows Terminal; the shell runs on under 接回. The keymap has no focus scope,
  // so "in front of the pane the keyboard is in" stands for "has the keyboard".
  if (platform.os === "windows" || platform.os === "linux") {
    bind("mod+w", () => {
      if (s.wide() && !s.workbench.terminalInFront()) s.workbench.runMenuCommand("pane-close-tab");
    }, { when: "always", passThrough: true });
    bind("mod+shift+w", () => {
      if (s.wide()) s.workbench.runMenuCommand("pane-close-tab");
    }, { when: "always" });
  }
}
