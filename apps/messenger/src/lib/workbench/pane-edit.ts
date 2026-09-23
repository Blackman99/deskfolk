/**
 * Copy and Paste for pane content that has no text field to hand the webview's own menu.
 *
 * A terminal is that content: what you select there is xterm's, not the page's, and a paste has
 * to reach the shell as bytes. So the content registers its host here, and the pane menu asks
 * whether whatever was right-clicked sits inside one — Copy and Paste then lead the menu, the way
 * they lead Terminal.app's.
 */
export type PaneEdit = {
  canCopy: () => boolean;
  copy: () => void;
  paste: () => void;
};

const ATTR = "data-pane-edit";
const registry = new WeakMap<Element, PaneEdit>();

export function registerPaneEdit(host: HTMLElement, edit: PaneEdit): () => void {
  registry.set(host, edit);
  host.setAttribute(ATTR, "");
  return () => {
    registry.delete(host);
    host.removeAttribute(ATTR);
  };
}

export function paneEditAt(target: Element | null): PaneEdit | null {
  const host = target?.closest?.(`[${ATTR}]`);
  return host ? (registry.get(host) ?? null) : null;
}
