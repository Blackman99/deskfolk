import { highlightLangFromClass } from "../highlight-lang.ts";
import { bindCssHighlight } from "../highlight-mount.ts";
import type { CssHighlightHandle } from "../css-highlight.ts";
import { copyText } from "../clipboard.ts";

export type CodeBlockLabels = {
  copy: string;
  copied: string;
};

const COPY_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

function codeElement(pre: HTMLElement): HTMLElement | null {
  for (const child of pre.children) {
    if (child instanceof HTMLElement && child.tagName === "CODE") return child;
  }
  return null;
}

function enhanceHeader(pre: HTMLElement, labels: CodeBlockLabels): void {
  if (pre.querySelector(".code-header")) return;
  const code = pre.querySelector("code");
  const className = code?.className || "";
  const langMatch = className.match(/language-([a-zA-Z0-9_-]+)/);
  const lang = langMatch ? langMatch[1] : "";

  const header = document.createElement("div");
  header.className = "code-header";

  const langLabel = document.createElement("span");
  langLabel.className = "code-lang";
  langLabel.textContent = lang || "code";
  header.appendChild(langLabel);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "code-copy-btn";
  copyBtn.innerHTML = `${COPY_ICON} <span>${labels.copy}</span>`;
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const codeText = code?.textContent || pre.textContent || "";
    copyText(codeText);
    const span = copyBtn.querySelector("span");
    if (span) {
      const orig = span.textContent;
      span.textContent = labels.copied;
      setTimeout(() => {
        if (span) span.textContent = orig;
      }, 1800);
    }
  });
  header.appendChild(copyBtn);
  pre.insertBefore(header, pre.firstChild);
}

export type MarkdownCodeAction = {
  update: (next: CodeBlockLabels) => void;
  destroy: () => void;
};

/** Copy chrome + Shiki token spans on fenced blocks, including streaming updates. */
export function markdownCode(node: HTMLElement, labels: CodeBlockLabels): MarkdownCodeAction {
  const bound = new Map<HTMLElement, CssHighlightHandle>();
  let current = labels;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const run = (): void => {
    if (destroyed) return;
    for (const [el, handle] of bound) {
      if (!el.isConnected) {
        handle.dispose();
        bound.delete(el);
      } else {
        handle.update();
      }
    }
    for (const pre of node.querySelectorAll("pre")) {
      if (!(pre instanceof HTMLElement)) continue;
      enhanceHeader(pre, current);
      const code = codeElement(pre);
      if (!code || bound.has(code) || code.dataset.rbHl) continue;
      code.dataset.rbHl = "pending";
      const lang = highlightLangFromClass(code.className) ?? "plaintext";
      void bindCssHighlight(code, lang).then((handle) => {
        if (destroyed || !code.isConnected) {
          handle?.dispose();
          delete code.dataset.rbHl;
          return;
        }
        if (!handle) {
          delete code.dataset.rbHl;
          return;
        }
        code.dataset.rbHl = "on";
        bound.set(code, handle);
      });
    }
  };

  const schedule = (): void => {
    if (timer != null) return;
    timer = setTimeout(() => {
      timer = null;
      run();
    }, 80);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(node, { childList: true, subtree: true, characterData: true });
  run();

  return {
    update(next: CodeBlockLabels) {
      current = next;
    },
    destroy() {
      destroyed = true;
      if (timer != null) clearTimeout(timer);
      observer.disconnect();
      for (const handle of bound.values()) handle.dispose();
      bound.clear();
    },
  };
}
