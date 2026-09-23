import { Marked } from "marked";
import remend, { isWithinCodeBlock } from "remend";
import createDOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import {
  ARTIFACT_HREF_SCHEME,
  artifactHref,
  linkifyWorkspacePaths,
  looksLikeWorkspaceHref,
  parseArtifactHref,
} from "./overlays/artifacts.ts";
import {
  BOT_HREF_SCHEME,
  decorateMentionChips,
  linkifyRosterMentions,
  mentionHref,
  parseMentionHref,
  type MentionableBot,
} from "./chat/mention-chips.ts";

const marked = new Marked({ gfm: true, breaks: true });

/**
 * Same allowlist sanitize-html used to enforce, now applied through DOMPurify plus a manual pass
 * over the result (`enforceTagPolicy`). In a browser both enforce it; under happy-dom, where
 * `bun test` runs, DOMPurify's own tag walk does not work (see `enforceTagPolicy`) and the manual
 * pass is what decides. DOMPurify has no per-tag attribute allowlist (its ALLOWED_ATTR is global),
 * so the per-tag rules below are a `uponSanitizeAttribute` hook keyed on the tag names below.
 * `bun test` cannot see what a browser does with this — tests/visual/markdown.spec.ts renders it
 * in Chromium and WebKit.
 */
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "strong",
  "em",
  "del",
  "s",
  "code",
  "pre",
  "a",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);

/** Per-tag attribute allowlist. A tag missing here keeps no attributes at all. */
const TAG_ATTRIBUTES: Record<string, readonly string[]> = {
  a: ["href", "target", "rel", "class", "title"],
  code: ["class"],
  pre: ["class"],
  ol: ["start"],
  th: ["align"],
  td: ["align"],
};

/** Union of every attribute name any tag above is allowed to keep. */
const GLOBAL_ALLOWED_ATTR = Array.from(new Set(Object.values(TAG_ATTRIBUTES).flat()));

/**
 * sanitize-html's default `nonTextTags`: disallowed tags normally keep their (sanitized) text
 * content, but these discard it entirely. DOMPurify's own default FORBID_CONTENTS list is
 * different (e.g. it includes `iframe`/`svg`/`thead` but not `option`), so this is enforced by
 * hand in `enforceTagPolicy` rather than reused.
 */
const CONTENT_DISCARDING_TAGS = new Set(["script", "style", "textarea", "option", "xmp"]);

function tagNameOf(node: Node): string {
  return node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : "";
}

/**
 * The tag allowlist again, by hand, over the tree DOMPurify returned. In a browser DOMPurify has
 * already enforced it and this changes nothing. Under happy-dom it is the only enforcement:
 * DOMPurify's tag-name reads (reflected getters on `Node.prototype`) come back `""` there, and
 * happy-dom's NodeIterator stops once a node in its path is detached — together its walk would
 * filter the first element or two and return the rest unfiltered (a `<p>` then a `<script>` came
 * back with the script intact). The `""` entry in ATTRIBUTE_PASS_CONFIG keeps that walk from
 * removing anything there, and this plain recursive walk reads `.tagName`/`.attributes`, which
 * happy-dom does answer. The same code runs in both, so tests exercise this pass.
 *
 * `<a>` gets special treatment inline (`handleAnchor`) rather than going through the generic
 * disallow/keep-content branch, since a valid link needs its attributes rewritten, not just
 * kept, and an invalid one needs unwrapping despite `a` otherwise being an allowed tag.
 */
function enforceTagPolicy(root: Element): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") {
      handleAnchor(el);
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      if (CONTENT_DISCARDING_TAGS.has(tag)) {
        el.remove();
      } else {
        enforceTagPolicy(el);
        const parent = el.parentNode;
        if (parent) {
          while (el.firstChild) parent.insertBefore(el.firstChild, el);
          parent.removeChild(el);
        }
      }
      continue;
    }
    enforceTagPolicy(el);
  }
}

/**
 * Mirrors the old sanitize-html `transformTags.a` function: an invalid href drops the tag but
 * keeps its (recursively policed) children, same as sanitize-html turning it into a disallowed
 * `<span>` did; a valid one gets exactly the attributes its link kind needs, nothing carried over
 * from the original tag. `title` is only set when non-empty — sanitize-html's default
 * `allowedEmptyAttributes` (just `alt`) drops an empty `title` rather than rendering `title=""`.
 */
function handleAnchor(el: Element): void {
  const originalTitle = el.getAttribute("title");
  const href = safeHref(el.getAttribute("href") ?? undefined);
  for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
  if (!href) {
    enforceTagPolicy(el);
    const parent = el.parentNode;
    if (parent) {
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
    return;
  }
  const setTitle = (value: string) => {
    if (value) el.setAttribute("title", value);
  };
  if (href.startsWith(BOT_HREF_SCHEME)) {
    el.setAttribute("href", href);
    el.setAttribute("class", "md-mention-chip");
    setTitle(originalTitle ?? "");
  } else if (href.startsWith(ARTIFACT_HREF_SCHEME)) {
    el.setAttribute("href", href);
    el.setAttribute("class", "md-artifact-link");
    setTitle(originalTitle ?? "");
  } else {
    el.setAttribute("href", href);
    el.setAttribute("class", "md-external-link");
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
    setTitle(originalTitle ?? href);
  }
  enforceTagPolicy(el);
}

function createSanitizer() {
  const purifier = createDOMPurify(window);

  purifier.addHook("uponSanitizeAttribute", (node, data) => {
    const allowed = TAG_ATTRIBUTES[tagNameOf(node)];
    data.keepAttr = allowed !== undefined && allowed.includes(data.attrName);
  });

  return purifier;
}

const purifier = createSanitizer();

const ATTRIBUTE_PASS_CONFIG: DOMPurifyConfig = {
  // In a browser DOMPurify reads real tag names and enforces this allowlist itself, with its own
  // namespace and mutation-XSS hardening; enforceTagPolicy then checks the same list again. Under
  // happy-dom (`bun test`) its tag-name reads come back "" — the "" entry waves every element
  // through there, so its walk never detaches a node, and enforceTagPolicy is what decides. An
  // earlier version listed only "": in a real browser that matched no tag at all and stripped
  // every message to plain text. Attribute *values* — the href scheme above all — are
  // re-validated from scratch by `safeHref` in the second pass.
  ALLOWED_TAGS: [...ALLOWED_TAGS, ""],
  ALLOWED_ATTR: GLOBAL_ALLOWED_ATTR,
  ADD_URI_SAFE_ATTR: GLOBAL_ALLOWED_ATTR,
};

function sanitizeHtmlDom(html: string): string {
  const attributesSanitized = purifier.sanitize(html, ATTRIBUTE_PASS_CONFIG);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = attributesSanitized;
  enforceTagPolicy(wrapper);
  return wrapper.innerHTML;
}

export type RenderMarkdownOptions = {
  streaming?: boolean;
  extraPaths?: string[];
  mentionBots?: readonly MentionableBot[];
  /** Present members eligible for lenient prefix/suffix resolution of misspelt @tokens. */
  mentionMembers?: readonly MentionableBot[];
  /** Title attribute for an unresolved @token marker. */
  unresolvedMentionTitle?: string;
};

/**
 * Rendering one bubble is marked + DOMPurify + two mention passes: fine once, expensive when
 * a long transcript re-renders on every streamed token or re-mounts bubbles while scrolling. The
 * same text under the same options is the same HTML, so the last few hundred results are kept.
 *
 * The key is what actually reaches the renderer, not the options object's identity — a caller
 * that rebuilds its options every render would otherwise never hit. Building that key walks the
 * roster, so it is remembered per options object for the callers that do keep one.
 */
const RENDER_CACHE_LIMIT = 240;
const renderCache = new Map<string, string>();
const optionSignatures = new WeakMap<RenderMarkdownOptions, string>();

function rosterSignature(bots: readonly MentionableBot[] | undefined): string {
  return (bots ?? []).map((bot) => `${bot.id}:${bot.name}`).join(",");
}

function optionsSignature(options: RenderMarkdownOptions): string {
  const remembered = optionSignatures.get(options);
  if (remembered !== undefined) return remembered;
  const signature = [
    (options.extraPaths ?? []).join("|"),
    rosterSignature(options.mentionBots),
    rosterSignature(options.mentionMembers),
    options.unresolvedMentionTitle ?? "",
  ].join("\u0001");
  optionSignatures.set(options, signature);
  return signature;
}

/** Chat markdown to sanitized HTML. Streaming heals unclosed emphasis and fences so the bubble does not flash raw markers. */
export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): string {
  if (!source && !(options.extraPaths && options.extraPaths.length > 0)) return "";
  // A partial line is different text on every token; caching it would only evict the settled ones.
  if (options.streaming) return renderUncached(source, options);
  const key = `${optionsSignature(options)}\u0000${source}`;
  const hit = renderCache.get(key);
  if (hit !== undefined) {
    // Re-insert so the entries a scrolling transcript keeps asking for are the ones that survive.
    renderCache.delete(key);
    renderCache.set(key, hit);
    return hit;
  }
  const html = renderUncached(source, options);
  renderCache.set(key, html);
  if (renderCache.size > RENDER_CACHE_LIMIT) {
    const oldest = renderCache.keys().next();
    if (!oldest.done) renderCache.delete(oldest.value);
  }
  return html;
}

export const EXTERNAL_LINK_ICON_SVG = `<span class="md-external-icon" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></span>`;

export function decorateExternalLinks(html: string): string {
  if (!html.includes("md-external-link")) return html;
  return html.replace(
    /(<a\b[^>]*class="[^"]*\bmd-external-link\b[^"]*"[^>]*>)([\s\S]*?)(<\/a>)/gi,
    (full, openTag, inner, closeTag) => {
      if (inner.includes("md-external-icon")) return full;
      return `${openTag}${inner}${EXTERNAL_LINK_ICON_SVG}${closeTag}`;
    },
  );
}

function renderUncached(source: string, options: RenderMarkdownOptions): string {
  const linked = linkifyWorkspacePaths(source, options.extraPaths ?? []);
  const prepared = options.streaming ? healStreaming(linked) : linked;
  const mentioned = linkifyRosterMentions(prepared, options.mentionBots ?? [], {
    members: options.mentionMembers,
  });
  const html = marked.parse(mentioned, { async: false });
  const sanitized = sanitizeHtmlDom(html);
  const withMentions = decorateMentionChips(sanitized, options.mentionBots ?? [], {
    unresolvedTitle: options.unresolvedMentionTitle,
  });
  return decorateExternalLinks(withMentions);
}

function healStreaming(source: string): string {
  const healed = remend(source, {
    katex: false,
    inlineKatex: false,
    linkMode: "text-only",
  });
  if (!isWithinCodeBlock(healed, healed.length)) return healed;
  return healed.endsWith("\n") ? `${healed}\`\`\`` : `${healed}\n\`\`\``;
}

function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (trimmed.startsWith(ARTIFACT_HREF_SCHEME)) {
    const rel = parseArtifactHref(trimmed);
    return rel ? artifactHref(rel) : null;
  }
  if (looksLikeWorkspaceHref(trimmed)) return artifactHref(trimmed);
  const botId = parseMentionHref(trimmed);
  if (botId) return mentionHref(botId);
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return trimmed;
    }
  } catch {
    return null;
  }
  return null;
}
