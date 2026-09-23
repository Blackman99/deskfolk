import { Marked, Renderer, type Tokens } from "marked";
import remend, { isWithinCodeBlock } from "remend";
import sanitizeHtml from "sanitize-html";
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
import {
  SRC_END_ATTR,
  SRC_START_ATTR,
  lexWithSourceLines,
  normalizeSource,
  sourceLinesOf,
  splitFrontMatter,
  type SourceLines,
} from "./annotations/markdown-lines.ts";

const marked = new Marked({ gfm: true, breaks: true });

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
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
  ],
  allowedAttributes: {
    a: ["href", "target", "rel", "class", "title"],
    code: ["class"],
    pre: ["class"],
    ol: ["start"],
    th: ["align"],
    td: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto", "artifact", "bot"],
  allowedSchemesByTag: {
    a: ["http", "https", "mailto", "artifact", "bot"],
  },
  transformTags: {
    a: (_tagName, attribs): sanitizeHtml.Tag => {
      const href = safeHref(attribs.href);
      if (!href) return { tagName: "span", attribs: {} };
      if (href.startsWith(BOT_HREF_SCHEME)) {
        return {
          tagName: "a",
          attribs: {
            href,
            class: "md-mention-chip",
            title: attribs.title ?? "",
          },
        };
      }
      if (href.startsWith(ARTIFACT_HREF_SCHEME)) {
        return {
          tagName: "a",
          attribs: {
            href,
            class: "md-artifact-link",
            title: attribs.title ?? "",
          },
        };
      }
      return {
        tagName: "a",
        attribs: {
          href,
          class: "md-external-link",
          target: "_blank",
          rel: "noopener noreferrer",
          title: attribs.title ?? href,
        },
      };
    },
  },
};

export type RenderMarkdownOptions = {
  streaming?: boolean;
  extraPaths?: string[];
  mentionBots?: readonly MentionableBot[];
  /** Present members eligible for lenient prefix/suffix resolution of misspelt @tokens. */
  mentionMembers?: readonly MentionableBot[];
  /** Title attribute for an unresolved @token marker. */
  unresolvedMentionTitle?: string;
  /**
   * Mark every block with the source lines it came from (`data-src-start` / `data-src-end`), for the
   * artifact preview's annotations to map a selection back to lines. Leading YAML front matter shows
   * as a yaml block. Chat bubbles leave it off and render exactly as before.
   */
  sourceLines?: boolean;
};

/**
 * Rendering one bubble is marked + sanitize-html + two mention passes: fine once, expensive when
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
    options.sourceLines ? "lines" : "",
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
  const lines = options.sourceLines === true;
  // Front matter is split off before the path and mention passes, so it shows as it was written.
  const text = lines ? normalizeSource(source) : source;
  const front = lines ? frontMatterOf(text) : "";
  const linked = linkifyWorkspacePaths(text.slice(front.length), options.extraPaths ?? []);
  const prepared = options.streaming ? healStreaming(linked) : linked;
  const mentioned = linkifyRosterMentions(prepared, options.mentionBots ?? [], {
    members: options.mentionMembers,
  });
  const html = lines
    ? lineMarked.parser(lexWithSourceLines(front + mentioned, (src) => lineMarked.lexer(src)))
    : marked.parse(mentioned, { async: false });
  const sanitized = sanitizeHtml(html, lines ? SANITIZE_WITH_LINES : SANITIZE);
  const withMentions = decorateMentionChips(sanitized, options.mentionBots ?? [], {
    unresolvedTitle: options.unresolvedMentionTitle,
  });
  return decorateExternalLinks(withMentions);
}

function frontMatterOf(text: string): string {
  return splitFrontMatter(text)?.raw ?? "";
}

/*
 * The `sourceLines` renderer: marked's own output, with each block's opening tag carrying the
 * lines `assignSourceLines` gave its token. Table rows get their own line, so a selection inside
 * one cell maps to that row. Raw HTML loses any `data-src-*` it brought along — only the
 * renderer may say where a block is. The name is defused wherever it could be an attribute,
 * whatever comes before it: an HTML parser also reads `title="x"data-src-start=…` (no space
 * after the quote) as an attribute.
 *
 * A raw HTML block that opens and closes everything it opens is wrapped in a `div` so it has
 * lines too. One that does not — `<div align="center">` here, `</div>` three blocks later — is
 * left unwrapped: a wrapper would take the other's closing tag and swallow what follows. Raw
 * `div`s are renamed to a tag the sanitizer drops (keeping their text, as chat bubbles do), so
 * the wrapper is the only `div` there is.
 */
const LINE_ATTR_RE = /data-src-(start|end)(?=[\s/>=]|$)/gi;
const RAW_DIV_RE = /<(\/?)div(?=[\s/>]|$)/gi;

function defuseLineAttrs(html: string): string {
  return html.replace(LINE_ATTR_RE, "data-src_$1").replace(RAW_DIV_RE, "<$1rb-raw-div");
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HTML_TAG_RE = /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*?)?(\/?)>/g;

/** Whether raw HTML closes, in order, every tag it opens and nothing it did not. */
function selfContainedHtml(html: string): boolean {
  const open: string[] = [];
  for (const match of html.matchAll(HTML_TAG_RE)) {
    const name = match[2]?.toLowerCase();
    if (!name) continue;
    if (match[1]) {
      if (open.pop() !== name) return false;
    } else if (!match[3] && !VOID_TAGS.has(name)) {
      open.push(name);
    }
  }
  return open.length === 0;
}

function lineAttrs(lines: SourceLines | undefined): string {
  return lines ? ` ${SRC_START_ATTR}="${lines.start}" ${SRC_END_ATTR}="${lines.end}"` : "";
}

function withLines(html: string, lines: SourceLines | undefined): string {
  if (!lines) return html;
  return html.replace(/^<([a-z][a-z0-9]*)/i, (open) => `${open}${lineAttrs(lines)}`);
}

const lineMarked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    paragraph(token) {
      return withLines(Renderer.prototype.paragraph.call(this, token), sourceLinesOf(token));
    },
    heading(token) {
      return withLines(Renderer.prototype.heading.call(this, token), sourceLinesOf(token));
    },
    blockquote(token) {
      return withLines(Renderer.prototype.blockquote.call(this, token), sourceLinesOf(token));
    },
    list(token) {
      return withLines(Renderer.prototype.list.call(this, token), sourceLinesOf(token));
    },
    listitem(token) {
      return withLines(Renderer.prototype.listitem.call(this, token), sourceLinesOf(token));
    },
    code(token) {
      return withLines(Renderer.prototype.code.call(this, token), sourceLinesOf(token));
    },
    hr(token) {
      return withLines(Renderer.prototype.hr.call(this, token), sourceLinesOf(token));
    },
    html(token) {
      const text = defuseLineAttrs(token.text);
      const lines = token.block && selfContainedHtml(text) ? sourceLinesOf(token) : undefined;
      return lines ? `<div class="md-html-block"${lineAttrs(lines)}>${text}</div>\n` : text;
    },
    table(token) {
      const lines = sourceLinesOf(token);
      const row = (cells: Tokens.TableCell[], line: number | null): string =>
        withLines(
          this.tablerow({ text: cells.map((cell) => this.tablecell(cell)).join("") }),
          line === null ? undefined : { start: line, end: line },
        );
      const head = row(token.header, lines ? lines.start : null);
      const rows = token.rows.map((cells, r) => row(cells, lines ? lines.start + 2 + r : null)).join("");
      const body = rows ? `<tbody>${rows}</tbody>` : "";
      return withLines(`<table>\n<thead>\n${head}</thead>\n${body}</table>\n`, lines);
    },
  },
});

const LINE_TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "table", "tr", "hr", "div"];

const SANITIZE_WITH_LINES: sanitizeHtml.IOptions = {
  ...SANITIZE,
  allowedTags: [...(SANITIZE.allowedTags as string[]), "div"],
  allowedAttributes: {
    ...(SANITIZE.allowedAttributes as Record<string, string[]>),
    ...Object.fromEntries(
      LINE_TAGS.map((tag) => [
        tag,
        [
          ...((SANITIZE.allowedAttributes as Record<string, string[]>)[tag] ?? []),
          ...(tag === "div" ? ["class"] : []),
          SRC_START_ATTR,
          SRC_END_ATTR,
        ],
      ]),
    ),
  },
  allowedClasses: { div: ["md-html-block"] },
};

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
