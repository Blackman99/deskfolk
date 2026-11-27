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
const CODE_SPAN = /(`+)[^`\n][\s\S]*?\1/g;
const JS_SPACE = /\s/;
const JS_LINE_TERM = /[\n\r\u2028\u2029]/;

type EscapedLink = { start: number; label: string; href: string; end: number };

function escapedLabelEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "]") return i;
    if (ch === "\\") {
      if (i + 1 >= s.length || JS_LINE_TERM.test(s[i + 1]!)) return -1;
      i += 2;
      continue;
    }
    i++;
  }
  return -1;
}

function escapedTargetEnds(s: string, from: number): number[] {
  const out: number[] = [];
  if (s.charCodeAt(from) === 60) {
    const gt = s.indexOf(">", from + 1);
    if (gt > from + 1 && s.charCodeAt(gt + 1) === 41) out.push(gt + 2);
  }
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!;
    if (JS_SPACE.test(ch)) break;
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) {
        if (i > from) out.push(i + 1);
        break;
      }
      depth--;
    }
  }
  return out;
}

function escapedLinkAt(s: string, p: number, accept: (end: number) => boolean): EscapedLink | null {
  const close = escapedLabelEnd(s, p + 1);
  if (close === -1 || s.charCodeAt(close + 1) !== 40) return null;
  const from = close + 2;
  for (const end of escapedTargetEnds(s, from)) {
    if (accept(end)) return { start: p, label: s.slice(p + 1, close), href: s.slice(from, end - 1), end };
  }
  return null;
}

function nextEscapedLink(s: string, from: number): EscapedLink | null {
  let p = from;
  while (p < s.length) {
    const idx = s.indexOf("[", p);
    if (idx === -1) return null;
    p = idx;
    if (p === 0 || s.charCodeAt(p - 1) !== 33) {
      const link = escapedLinkAt(s, p, () => true);
      if (link) return link;
    }
    p++;
  }
  return null;
}

function standaloneLink(line: string): EscapedLink | null {
  let at = 0;
  while (at < line.length && JS_SPACE.test(line[at]!)) at++;
  if (line.charCodeAt(at) !== 91) return null;
  return escapedLinkAt(line, at, (end) => {
    for (let i = end; i < line.length; i++) {
      if (!JS_SPACE.test(line[i]!)) return false;
    }
    return true;
  });
}

function extLinkTag(url: string): string {
  return `<extlink url="${attr(url)}"></extlink>`;
}

function isExternalHttpUrl(url: string): boolean {
  return (url.length > 8 && url.slice(0, 8).toLowerCase() === "https://")
    || (url.length > 7 && url.slice(0, 7).toLowerCase() === "http://");
}

function schemeLenAt(s: string, at: number): number {
  const rest = s.slice(at, at + 8).toLowerCase();
  if (rest === "https://") return 8;
  if (rest.startsWith("http://")) return 7;
  return 0;
}

function isCjkPunctuation(code: number): boolean {
  return code === 0x2018 || code === 0x2019 || code === 0x201c || code === 0x201d
    || (code >= 0x3000 && code <= 0x303f)
    || (code >= 0xfe10 && code <= 0xfe1f)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff01 && code <= 0xff0f)
    || (code >= 0xff1a && code <= 0xff20)
    || (code >= 0xff3b && code <= 0xff40)
    || (code >= 0xff5b && code <= 0xff65);
}

function isCjkChar(code: number): boolean {
  return (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af);
}

function escapeMdLabel(url: string): string {
  return url.replace(/[\\[\]]/g, "\\$&");
}

function isAsciiAlnum(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function canStartBareUrl(s: string, at: number): boolean {
  if (at > 0) {
    const prev = s.charCodeAt(at - 1);
    if (isAsciiAlnum(prev) || prev === 95 || prev === 61 || prev === 34 || prev === 39 || prev === 60 || prev === 0) {
      return false;
    }
  }
  let end = at;
  while (end > 0 && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  const written = s.slice(0, end);
  return !written.endsWith("](") && !written.endsWith("](<") && !written.endsWith("]:");
}

function trimUrlEnd(s: string, start: number, end: number, minEnd: number): number {
  while (end > minEnd) {
    const last = s.charCodeAt(end - 1);
    if (last === 46 || last === 44 || last === 59 || last === 58 || last === 33 || last === 63 || last === 42 || last === 95 || last === 126) {
      end--;
      continue;
    }
    if (last === 41) {
      let opens = 0;
      let closes = 0;
      for (let k = start; k < end; k++) {
        const ch = s.charCodeAt(k);
        if (ch === 40) opens++;
        else if (ch === 41) closes++;
      }
      if (closes > opens) {
        end--;
        continue;
      }
    }
    if (last === 93) {
      let opens = 0;
      let closes = 0;
      for (let k = start; k < end; k++) {
        const ch = s.charCodeAt(k);
        if (ch === 91) opens++;
        else if (ch === 93) closes++;
      }
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return end;
}

function linkifyExternalUrls(segment: string): string {
  let out = "";
  let i = 0;
  while (i < segment.length) {
    const code = segment.charCodeAt(i);
    if (code === 60) {
      const slen = schemeLenAt(segment, i + 1);
      if (slen > 0) {
        const urlStart = i + 1;
        let j = urlStart + slen;
        let closed = false;
        while (j < segment.length) {
          const ch = segment[j]!;
          if (ch === ">") {
            closed = true;
            break;
          }
          if (JS_SPACE.test(ch) || ch === "<" || ch === "\u0000") break;
          j++;
        }
        if (closed && j > urlStart + slen) {
          const url = segment.slice(urlStart, j);
          out += `[${escapeMdLabel(url)}](<${url}>)${extLinkTag(url)}`;
          i = j + 1;
          continue;
        }
      }
      if (i + 1 < segment.length) {
        const next = segment.charCodeAt(i + 1);
        if (isAsciiAlpha(next) || next === 47 || next === 33 || next === 63) {
          let gt = -1;
          for (let k = i + 1; k < segment.length; k++) {
            const b = segment.charCodeAt(k);
            if (b === 62) {
              gt = k;
              break;
            }
            if (b === 60 || b === 0) break;
          }
          if (gt !== -1) {
            out += segment.slice(i, gt + 1);
            i = gt + 1;
            continue;
          }
        }
      }
    }
    if (code === 104 || code === 72) {
      const slen = schemeLenAt(segment, i);
      if (slen > 0 && canStartBareUrl(segment, i)) {
        const bodyStart = i + slen;
        let end = segment.length;
        let inPath = false;
        for (let k = bodyStart; k < segment.length; k++) {
          const ch = segment[k]!;
          const c = segment.charCodeAt(k);
          if (
            JS_SPACE.test(ch)
            || c === 60 || c === 62 || c === 34 || c === 39 || c === 96 || c === 92 || c === 0
            || isCjkPunctuation(c)
            || (!inPath && isCjkChar(c))
          ) {
            end = k;
            break;
          }
          if (c === 47) inPath = true;
        }
        end = trimUrlEnd(segment, i, end, bodyStart);
        if (end > bodyStart) {
          const url = segment.slice(i, end);
          out += `[${escapeMdLabel(url)}](<${url}>)${extLinkTag(url)}`;
          i = end;
          continue;
        }
      }
    }
    out += segment[i]!;
    i++;
  }
  return out;
}

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
    const link = standaloneLink(line);
    if (!link) return true;
    const target = linkTarget(link.href);
    return !(target.kind === "artifact" && hidden.has(target.path) && unescapeLabel(link.label).trim() === target.path);
  });
  const body = lines.join("");
  let chipped = "";
  let from = 0;
  let link: EscapedLink | null;
  while ((link = nextEscapedLink(body, from)) !== null) {
    const full = body.slice(link.start, link.end);
    chipped += linkifyExternalUrls(body.slice(from, link.start));
    const target = linkTarget(link.href);
    const name = unescapeLabel(link.label);
    if (target.kind === "mention") chipped += `<mention id="${attr(target.id)}">${text(name)}</mention>`;
    else if (target.kind === "artifact") chipped += `<artifact path="${attr(target.path)}">${text(name)}</artifact>`;
    else if (isExternalHttpUrl(target.url) && !link.label.includes("![")) chipped += `${full}${extLinkTag(target.url)}`;
    else chipped += full;
    from = link.end;
  }
  chipped += linkifyExternalUrls(body.slice(from));
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
