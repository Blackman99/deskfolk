import { Marked } from "marked";
import remend, { isWithinCodeBlock } from "remend";
import sanitizeHtml from "sanitize-html";
import { artifactHref, linkifyWorkspacePaths, looksLikeWorkspaceHref } from "./overlays/artifacts.ts";
import {
  BOT_HREF_SCHEME,
  decorateMentionChips,
  linkifyRosterMentions,
  mentionHref,
  parseMentionHref,
  type MentionableBot,
} from "./chat/mention-chips.ts";

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
      return {
        tagName: "a",
        attribs: {
          href,
          target: "_blank",
          rel: "noopener noreferrer",
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
};

/** Chat markdown to sanitized HTML. Streaming heals unclosed emphasis and fences so the bubble does not flash raw markers. */
export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): string {
  if (!source && !(options.extraPaths && options.extraPaths.length > 0)) return "";
  const linked = linkifyWorkspacePaths(source, options.extraPaths ?? []);
  const prepared = options.streaming ? healStreaming(linked) : linked;
  const mentioned = linkifyRosterMentions(prepared, options.mentionBots ?? [], {
    members: options.mentionMembers,
  });
  const html = marked.parse(mentioned, { async: false });
  return decorateMentionChips(sanitizeHtml(html, SANITIZE), options.mentionBots ?? [], {
    unresolvedTitle: options.unresolvedMentionTitle,
  });
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
