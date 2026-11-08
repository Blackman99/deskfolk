/**
 * What the messenger's `markdown.ts` does before its HTML, for `TextView`: the same passes over the
 * source (`linkifyWorkspacePaths`, `linkifyRosterMentions`), then the links that are a file or a
 * Bot become elements (`<artifact path>`, `<mention id>`) that `MarkdownBody` draws as chips through
 * `TextView`'s extensions. No HTML is built and nothing is sanitised here: `TextView` reads the
 * Markdown natively and runs nothing in it.
 *
 * `prepareMarkdown` is Rust (`app/native/src/markdown`, `deskfolk/native`'s `Markdown`): it runs on
 * every bubble render and every streamed token, and the regexes it is made of are 8 to 30 times
 * slower in QuickJS than in a browser's engine. The passes below stay as `prepareMarkdownJs`, the
 * reference `markdown-native.test.ts` holds the Rust to byte for byte, and what runs where the
 * native module is missing.
 */
import { Markdown } from "deskfolk/native";
import { linkifyWorkspacePaths, looksLikeWorkspaceHref, parseArtifactHref } from "../m/overlays/artifacts.ts";
import { linkifyRosterMentions, parseMentionHref, type MentionableBot } from "../m/chat/mention-chips.ts";

export type RenderMarkdownOptions = {
  streaming?: boolean;
  extraPaths?: string[];
  mentionBots?: readonly MentionableBot[];
  /** Present members eligible for lenient prefix/suffix resolution of misspelt @tokens. */
  mentionMembers?: readonly MentionableBot[];
  /** What an unresolved @token says when pointed at. */
  unresolvedMentionTitle?: string;
};

const UNRESOLVED = "unresolved:";
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LINK = /(?<!!)\[((?:\\.|[^\]\\])*)\]\((<[^>]+>|[^)\s]+)\)/g;
const CODE_SPAN = /(`+)[^`\n][\s\S]*?\1/g;

/** The source split into fenced code (left alone) and the rest. */
export function splitFences(source: string): Array<{ text: string; fence: boolean }> {
  const parts: Array<{ text: string; fence: boolean }> = [];
  let buf = "";
  let open: string | null = null;
  const flush = (fence: boolean) => {
    if (buf) parts.push({ text: buf, fence });
    buf = "";
  };
  for (const line of source.split(/(?<=\n)/)) {
    const m = FENCE.exec(line);
    if (open === null) {
      if (m) {
        flush(false);
        open = m[1]!;
      }
      buf += line;
    } else {
      buf += line;
      if (m && m[1]![0] === open[0] && m[1]!.length >= open.length && line.trim() === m[1]) {
        flush(true);
        open = null;
      }
    }
  }
  flush(open !== null);
  return parts;
}

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const text = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeLabel = (v: string) => v.replace(/\\(.)/g, "$1");

/** Where a link goes: a Bot, a file of the workspace, or anywhere else. */
export function linkTarget(href: string): { kind: "mention"; id: string } | { kind: "artifact"; path: string } | { kind: "url"; url: string } {
  const raw = href.trim().replace(/^<|>$/g, "");
  const bot = parseMentionHref(raw);
  if (bot) return { kind: "mention", id: bot };
  const artifact = parseArtifactHref(raw) ?? (looksLikeWorkspaceHref(raw) ? raw : null);
  if (artifact) return { kind: "artifact", path: artifact };
  return { kind: "url", url: raw };
}

function chipsIn(part: string, hidden: ReadonlySet<string>): string {
  const kept: string[] = [];
  const keep = (s: string) => `\u0000C${kept.push(s) - 1}\u0000`;
  const guarded = part.replace(CODE_SPAN, keep);
  const lines = guarded.split(/(?<=\n)/).filter((line) => {
    if (hidden.size === 0) return true;
    const m = /^\s*(?<!!)\[((?:\\.|[^\]\\])*)\]\((<[^>]+>|[^)\s]+)\)\s*$/.exec(line);
    if (!m) return true;
    const target = linkTarget(m[2]!);
    return !(target.kind === "artifact" && hidden.has(target.path) && unescapeLabel(m[1]!).trim() === target.path);
  });
  const chipped = lines.join("").replace(LINK, (full, label: string, href: string) => {
    const target = linkTarget(href);
    const name = unescapeLabel(label);
    if (target.kind === "mention") return `<mention id="${attr(target.id)}">${text(name)}</mention>`;
    if (target.kind === "artifact") return `<artifact path="${attr(target.path)}">${text(name)}</artifact>`;
    return full;
  });
  return chipped.replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? "");
}

/**
 * The source as `MarkdownBody` hands it to `TextView`: paths and roster names linked as the
 * messenger links them, those links as chip elements, and the standalone lines that only repeat a
 * file shown elsewhere (`hidden`, a message's attachment cards) dropped.
 */
export function prepareMarkdownJs(source: string, options: RenderMarkdownOptions = {}, hidden: readonly string[] = []): string {
  if (!source && !(options.extraPaths && options.extraPaths.length > 0)) return "";
  const linked = linkifyWorkspacePaths(source, options.extraPaths ?? []);
  const mentioned = linkifyRosterMentions(linked, options.mentionBots ?? [], { members: options.mentionMembers });
  const hiddenSet = new Set(hidden);
  return splitFences(mentioned)
    .map((part) => (part.fence ? part.text : chipsIn(part.text, hiddenSet)))
    .join("");
}

/**
 * The options as the Rust reads them: the extra paths and each roster's ids and names. Turning the
 * whole options into JSON on every call cost more than the Rust pass itself (each Bot carries its
 * whole record), so a bubble's options, and each roster, are turned into JSON once.
 */
const optionsJsonOf = new WeakMap<RenderMarkdownOptions, string>();
const rosterJsonOf = new WeakMap<readonly MentionableBot[], string>();
function rosterJson(roster: readonly MentionableBot[]): string {
  let json = rosterJsonOf.get(roster);
  if (json === undefined) {
    json = JSON.stringify(roster.map((bot) => ({ id: bot.id, name: bot.name })));
    rosterJsonOf.set(roster, json);
  }
  return json;
}
function optionsJson(options: RenderMarkdownOptions): string {
  let json = optionsJsonOf.get(options);
  if (json === undefined) {
    const parts: string[] = [];
    if (options.extraPaths) parts.push(`"extraPaths":${JSON.stringify(options.extraPaths)}`);
    if (options.mentionBots) parts.push(`"mentionBots":${rosterJson(options.mentionBots)}`);
    if (options.mentionMembers) parts.push(`"mentionMembers":${rosterJson(options.mentionMembers)}`);
    json = `{${parts.join(",")}}`;
    optionsJsonOf.set(options, json);
  }
  return json;
}

/** The same string as `prepareMarkdownJs`, made in Rust. */
export function prepareMarkdown(source: string, options: RenderMarkdownOptions = {}, hidden: readonly string[] = []): string {
  if (!source) return "";
  if (!Markdown) return prepareMarkdownJs(source, options, hidden);
  return Markdown.prepareMarkdown(source, optionsJson(options), [...hidden]);
}

/** A mention's id when it names nobody on the roster: the token as written. */
export function unresolvedToken(id: string): string | null {
  return id.startsWith(UNRESOLVED) ? id.slice(UNRESOLVED.length) : null;
}
