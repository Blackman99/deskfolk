/** Side-effect imports that attach find, folding, and other editor contribs. */

export async function registerMonacoEditorFeatures(): Promise<void> {
  await Promise.all([
    import("monaco-editor/esm/vs/features/find/register.js"),
    import("monaco-editor/esm/vs/features/folding/register.js"),
    import("monaco-editor/esm/vs/features/bracketMatching/register.js"),
    import("monaco-editor/esm/vs/features/comment/register.js"),
    import("monaco-editor/esm/vs/features/clipboard/register.js"),
    import("monaco-editor/esm/vs/features/contextmenu/register.js"),
    import("monaco-editor/esm/vs/features/wordOperations/register.js"),
    import("monaco-editor/esm/vs/features/wordPartOperations/register.js"),
    import("monaco-editor/esm/vs/features/multicursor/register.js"),
    import("monaco-editor/esm/vs/features/linesOperations/register.js"),
    import("monaco-editor/esm/vs/features/indentation/register.js"),
    import("monaco-editor/esm/vs/features/smartSelect/register.js"),
    import("monaco-editor/esm/vs/features/gotoLine/register.js"),
    import("monaco-editor/esm/vs/features/codicon/register.js"),
    import("monaco-editor/esm/vs/features/wordHighlighter/register.js"),
    import("monaco-editor/esm/vs/features/lineSelection/register.js"),
    import("monaco-editor/esm/vs/features/fontZoom/register.js"),
    import("monaco-editor/esm/vs/features/cursorUndo/register.js"),
    import("monaco-editor/esm/vs/features/links/register.js"),
  ]);
}

/**
 * Standalone Monaco registers Cmd/Ctrl+F even when the editor is not focused.
 * Stop those shortcuts unless the event is inside the editor or the preview pane.
 */
export function installMonacoShortcutGuard(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __RB_MONACO_SHORTCUT_GUARD__?: boolean };
  if (w.__RB_MONACO_SHORTCUT_GUARD__) return;
  w.__RB_MONACO_SHORTCUT_GUARD__ = true;
  window.addEventListener(
    "keydown",
    (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "f" && key !== "h") return;
      const target = event.target;
      const el = target instanceof Element ? target : null;
      if (el?.closest(".monaco-editor, .editor-widget.find-widget, .artifact-pane")) return;
      event.stopImmediatePropagation();
    },
    true,
  );
}
