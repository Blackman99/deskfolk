import type { Bot } from "@real-bot/protocol";
import { avatarSrc } from "../avatar.ts";
import { botAvatarColor } from "./chat-view.ts";
import { rosterLetter } from "../sidebar/roster-letter.ts";

export type ActiveMentionChip = {
  id: string;
  name: string;
  isEveryone: boolean;
  avatarSrc: string | null;
  botId?: string;
};

export type InlineMentionChipData = {
  id: string;
  name: string;
  isEveryone: boolean;
  avatarSrc?: string | null;
  palette?: { bg: string; text: string; border: string } | null;
  letter?: string;
};

export function isBotMentionedInDraft(botName: string, text: string): boolean {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(^|\\s)@${escaped}(?=\\s|$)`);
  return regex.test(text);
}

export function extractActiveMentionChips(
  draft: string,
  groupPresentBotIds: string[],
  botsById: ReadonlyMap<string, Bot>,
): ActiveMentionChip[] {
  const chips: ActiveMentionChip[] = [];
  if (/(^|\s)@everyone(?=\s|$)/.test(draft)) {
    chips.push({
      id: "everyone",
      name: "everyone",
      isEveryone: true,
      avatarSrc: null,
    });
  }
  for (const botId of groupPresentBotIds) {
    const b = botsById.get(botId);
    if (!b) continue;
    if (isBotMentionedInDraft(b.name, draft)) {
      chips.push({
        id: b.id,
        name: b.name,
        isEveryone: false,
        avatarSrc: avatarSrc(b.avatar),
        botId: b.id,
      });
    }
  }
  return chips;
}

export function removeMentionFromDraft(draft: string, memberName: string): string {
  const escaped = memberName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(^|\\s)@${escaped}(?=\\s|$)`, "g");
  return draft.replace(regex, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Deletes the mention immediately preceding the cursor as a single atomic unit.
 * If the cursor is immediately after "@name " or "@name", removes the entire mention.
 * Otherwise falls back to deleting a single character.
 */
export function deleteLastMentionOrChar(
  text: string,
  cursor: number,
  knownNames: string[] = [],
): { nextText: string; nextCursor: number; deletedMention: boolean } {
  if (cursor <= 0) return { nextText: text, nextCursor: 0, deletedMention: false };
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);

  const names = [...new Set([...knownNames, "everyone"])].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patternWithSpace = new RegExp(`(^|\\s)@${escaped}\\s$`);
    const matchWithSpace = before.match(patternWithSpace);
    if (matchWithSpace) {
      const matchPrefix = matchWithSpace[1] ?? "";
      const startIdx = matchWithSpace.index! + matchPrefix.length;
      const newBefore = before.slice(0, startIdx);
      return {
        nextText: `${newBefore}${after}`,
        nextCursor: newBefore.length,
        deletedMention: true,
      };
    }
    const patternWithoutSpace = new RegExp(`(^|\\s)@${escaped}$`);
    const matchWithoutSpace = before.match(patternWithoutSpace);
    if (matchWithoutSpace) {
      const matchPrefix = matchWithoutSpace[1] ?? "";
      const startIdx = matchWithoutSpace.index! + matchPrefix.length;
      const newBefore = before.slice(0, startIdx);
      return {
        nextText: `${newBefore}${after}`,
        nextCursor: newBefore.length,
        deletedMention: true,
      };
    }
  }

  const newBefore = before.slice(0, -1);
  return {
    nextText: `${newBefore}${after}`,
    nextCursor: newBefore.length,
    deletedMention: false,
  };
}

/**
 * Creates an inline non-editable mention chip DOM element.
 */
export function createInlineMentionChipElement(opts: InlineMentionChipData): HTMLElement {
  if (typeof document === "undefined") {
    return {} as HTMLElement;
  }

  const span = document.createElement("span");
  span.className = "inline-mention-chip";
  span.contentEditable = "false";
  span.setAttribute("data-mention-id", opts.id);
  span.setAttribute("data-mention-name", opts.name);
  span.setAttribute("data-mention-everyone", opts.isEveryone ? "true" : "false");

  if (opts.isEveryone) {
    const icon = document.createElement("span");
    icon.className = "chip-avatar-icon";
    icon.textContent = "👥";
    span.appendChild(icon);
  } else if (opts.avatarSrc) {
    const img = document.createElement("img");
    img.src = opts.avatarSrc;
    img.alt = "";
    img.className = "chip-avatar-img";
    span.appendChild(img);
  } else if (opts.palette) {
    const letterSpan = document.createElement("span");
    letterSpan.className = "chip-avatar-letter";
    letterSpan.style.background = opts.palette.bg;
    letterSpan.style.color = opts.palette.text;
    letterSpan.style.borderColor = opts.palette.border;
    letterSpan.textContent = opts.letter || opts.name.charAt(0) || "?";
    span.appendChild(letterSpan);
  }

  const nameSpan = document.createElement("span");
  nameSpan.className = "chip-name";
  nameSpan.textContent = `@${opts.name}`;
  span.appendChild(nameSpan);

  const delBtn = document.createElement("span");
  delBtn.className = "chip-close-btn";
  delBtn.setAttribute("role", "button");
  delBtn.setAttribute("aria-label", `Remove @${opts.name}`);
  delBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  span.appendChild(delBtn);

  return span;
}

/**
 * Serializes the text content of a contenteditable container into plain text,
 * transforming .inline-mention-chip elements into "@Name ".
 */
export function serializeEditorText(editorEl: HTMLElement): string {
  if (!editorEl) return "";
  let text = "";
  function walk(node: Node) {
    if (node.nodeType === 3 /* Node.TEXT_NODE */) {
      text += node.textContent || "";
    } else if (node.nodeType === 1 /* Node.ELEMENT_NODE */) {
      const el = node as HTMLElement;
      if (el.classList.contains("inline-mention-chip")) {
        const name = el.getAttribute("data-mention-name") || "";
        text += `@${name}`;
      } else if (el.tagName === "BR") {
        text += "\n";
      } else {
        for (let i = 0; i < node.childNodes.length; i++) {
          walk(node.childNodes[i]!);
        }
        if (el.tagName === "DIV" || el.tagName === "P") {
          text += "\n";
        }
      }
    }
  }
  for (let i = 0; i < editorEl.childNodes.length; i++) {
    walk(editorEl.childNodes[i]!);
  }
  return text.replace(/\n$/, "");
}

/**
 * Removes a mention chip and its trailing whitespace from DOM, and sets caret.
 */
export function deleteChipElement(chip: HTMLElement): void {
  const next = chip.nextSibling;
  const prev = chip.previousSibling;
  const parent = chip.parentNode;
  if (!parent) return;

  if (next && next.nodeType === 3 /* TEXT_NODE */) {
    const t = next.textContent || "";
    if (t.startsWith(" ")) {
      if (t === " ") {
        parent.removeChild(next);
      } else {
        next.textContent = t.slice(1);
      }
    }
  }
  parent.removeChild(chip);

  if (typeof window !== "undefined") {
    const sel = window.getSelection();
    if (sel && typeof document !== "undefined") {
      const range = document.createRange();
      if (next && parent.contains(next)) {
        range.setStart(next, 0);
        range.setEnd(next, 0);
      } else if (prev && prev.nodeType === 3 /* TEXT_NODE */) {
        const len = prev.textContent?.length || 0;
        range.setStart(prev, len);
        range.setEnd(prev, len);
      } else {
        range.selectNodeContents(parent);
        range.collapse(false);
      }
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
}

/**
 * Handles Backspace key press inside the contenteditable editor:
 * If cursor is directly following an inline mention chip (or its trailing space),
 * removes the entire chip as an atomic unit.
 */
export function handleEditorBackspace(editorEl: HTMLElement): boolean {
  if (typeof window === "undefined") return false;
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
  const node = sel.anchorNode;
  const offset = sel.anchorOffset;
  if (!node || !editorEl.contains(node)) return false;

  // Case 1: node is a text node
  if (node.nodeType === 3 /* TEXT_NODE */) {
    const prev = node.previousSibling;
    // Case 1a: caret at offset 0, and previousSibling is a chip
    if (offset === 0 && prev && prev.nodeType === 1 && (prev as HTMLElement).classList.contains("inline-mention-chip")) {
      deleteChipElement(prev as HTMLElement);
      return true;
    }
    // Case 1b: caret at offset 1, text starts with space, and previousSibling is a chip
    const text = node.textContent || "";
    if (offset === 1 && (text[0] === " " || text[0] === "\u00A0") && prev && prev.nodeType === 1 && (prev as HTMLElement).classList.contains("inline-mention-chip")) {
      deleteChipElement(prev as HTMLElement);
      return true;
    }
    // Case 1c: text is only whitespace and caret is at end
    if (offset === text.length && /^\s+$/.test(text) && prev && prev.nodeType === 1 && (prev as HTMLElement).classList.contains("inline-mention-chip")) {
      deleteChipElement(prev as HTMLElement);
      return true;
    }
  }

  // Case 2: node is the editor container (or child block element)
  if (node.nodeType === 1 /* ELEMENT_NODE */) {
    if (offset > 0) {
      const prevChild = node.childNodes[offset - 1];
      if (prevChild && prevChild.nodeType === 1 && (prevChild as HTMLElement).classList.contains("inline-mention-chip")) {
        deleteChipElement(prevChild as HTMLElement);
        return true;
      }
      if (prevChild && prevChild.nodeType === 3 && /^\s*$/.test(prevChild.textContent || "")) {
        const chipBefore = prevChild.previousSibling;
        if (chipBefore && chipBefore.nodeType === 1 && (chipBefore as HTMLElement).classList.contains("inline-mention-chip")) {
          deleteChipElement(chipBefore as HTMLElement);
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Handles Delete (forward-delete) key press inside the contenteditable editor.
 */
export function handleEditorDelete(editorEl: HTMLElement): boolean {
  if (typeof window === "undefined") return false;
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false;
  const node = sel.anchorNode;
  const offset = sel.anchorOffset;
  if (!node || !editorEl.contains(node)) return false;

  if (node.nodeType === 3 /* TEXT_NODE */) {
    const text = node.textContent || "";
    if (offset === text.length) {
      const next = node.nextSibling;
      if (next && next.nodeType === 1 && (next as HTMLElement).classList.contains("inline-mention-chip")) {
        deleteChipElement(next as HTMLElement);
        return true;
      }
    }
  }

  if (node.nodeType === 1 /* ELEMENT_NODE */) {
    if (offset < node.childNodes.length) {
      const nextChild = node.childNodes[offset];
      if (nextChild && nextChild.nodeType === 1 && (nextChild as HTMLElement).classList.contains("inline-mention-chip")) {
        deleteChipElement(nextChild as HTMLElement);
        return true;
      }
    }
  }

  return false;
}

/**
 * Returns text up to the caret in the editor, serializing chips into "@Name ".
 */
export function getTextBeforeCaret(editorEl: HTMLElement): string {
  if (typeof window === "undefined") return "";
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return "";
  const range = sel.getRangeAt(0);
  let text = "";

  function walk(node: Node): boolean {
    if (node === range.startContainer) {
      if (node.nodeType === 3 /* TEXT_NODE */) {
        text += (node.textContent || "").slice(0, range.startOffset);
      }
      return true;
    }
    if (node.nodeType === 3 /* TEXT_NODE */) {
      text += node.textContent || "";
    } else if (node.nodeType === 1 /* ELEMENT_NODE */) {
      const el = node as HTMLElement;
      if (el.classList.contains("inline-mention-chip")) {
        const name = el.getAttribute("data-mention-name") || "";
        text += `@${name} `;
      } else if (el.tagName === "BR") {
        text += "\n";
      } else {
        for (let i = 0; i < node.childNodes.length; i++) {
          if (walk(node.childNodes[i]!)) return true;
        }
        if (el.tagName === "DIV" || el.tagName === "P") {
          text += "\n";
        }
      }
    }
    return false;
  }

  for (let i = 0; i < editorEl.childNodes.length; i++) {
    if (walk(editorEl.childNodes[i]!)) break;
  }
  return text;
}

/**
 * Replaces "@query" at caret with an inline mention chip followed by a space.
 */
export function insertMentionChipAtCaret(
  editorEl: HTMLElement,
  candidate: { id: string; name: string; isEveryone: boolean; avatar?: string | null },
  botsById: ReadonlyMap<string, Bot>,
): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const sel = window.getSelection();
  if (!sel) return;

  if (sel.rangeCount === 0 || !editorEl.contains(sel.anchorNode)) {
    editorEl.focus();
    const range = document.createRange();
    range.selectNodeContents(editorEl);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const range = sel.getRangeAt(0);
  const textNode = range.startContainer;
  const offset = range.startOffset;

  let insertBeforeNode: Node | null = null;
  let insertParent: Node = editorEl;

  if (textNode.nodeType === 3 /* TEXT_NODE */) {
    const text = textNode.textContent || "";
    const atIndex = text.lastIndexOf("@", Math.max(0, offset - 1));
    if (atIndex >= 0) {
      const beforeText = text.slice(0, atIndex);
      const afterText = text.slice(offset);

      textNode.textContent = beforeText;
      insertParent = textNode.parentNode || editorEl;
      insertBeforeNode = textNode.nextSibling;

      if (afterText.length > 0) {
        const afterNode = document.createTextNode(afterText);
        insertParent.insertBefore(afterNode, insertBeforeNode);
        insertBeforeNode = afterNode;
      }
    } else {
      insertParent = textNode.parentNode || editorEl;
      insertBeforeNode = textNode.nextSibling;
    }
  } else {
    insertParent = textNode;
    insertBeforeNode = textNode.childNodes[offset] ?? null;
  }

  const bot = !candidate.isEveryone ? botsById.get(candidate.id) : null;
  const pal = !candidate.isEveryone ? botAvatarColor(candidate.id) : null;
  const chipEl = createInlineMentionChipElement({
    id: candidate.id,
    name: candidate.name,
    isEveryone: candidate.isEveryone,
    avatarSrc: candidate.avatar ? avatarSrc(candidate.avatar) : null,
    palette: pal,
    letter: candidate.name ? rosterLetter(candidate.name) : "?",
  });

  const spaceNode = document.createTextNode(" ");
  insertParent.insertBefore(chipEl, insertBeforeNode);
  insertParent.insertBefore(spaceNode, insertBeforeNode);

  const newRange = document.createRange();
  newRange.setStart(spaceNode, 1);
  newRange.setEnd(spaceNode, 1);
  sel.removeAllRanges();
  sel.addRange(newRange);
}

/**
 * Initializes/updates editor DOM from a plain text draft, rendering mention chips.
 */
export function setEditorContentFromText(
  editorEl: HTMLElement,
  text: string,
  botsById: ReadonlyMap<string, Bot>,
): void {
  if (typeof document === "undefined" || !editorEl) return;
  editorEl.innerHTML = "";
  if (!text) return;

  const mentionRegex = /(^|\s)@([^\s@]+)(?=\s|$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(text)) !== null) {
    const matchStart = match.index;
    const leadingSpace = match[1] || "";
    const memberName = match[2] || "";
    const atStart = matchStart + leadingSpace.length;
    const matchEnd = atStart + 1 + memberName.length;

    const isEveryone = memberName === "everyone";
    const bot = !isEveryone ? Array.from(botsById.values()).find((b) => b.name === memberName) : null;

    if (isEveryone || bot) {
      const beforeText = text.slice(lastIndex, atStart);
      if (beforeText) {
        editorEl.appendChild(document.createTextNode(beforeText));
      }

      const chip = createInlineMentionChipElement({
        id: isEveryone ? "everyone" : bot!.id,
        name: memberName,
        isEveryone,
        avatarSrc: bot?.avatar ? avatarSrc(bot.avatar) : null,
        palette: bot ? botAvatarColor(bot.id) : null,
        letter: memberName ? rosterLetter(memberName) : "?",
      });
      editorEl.appendChild(chip);

      editorEl.appendChild(document.createTextNode(" "));
      lastIndex = matchEnd + (text[matchEnd] === " " ? 1 : 0);
    }
  }

  const remainder = text.slice(lastIndex);
  if (remainder) {
    editorEl.appendChild(document.createTextNode(remainder));
  }
}

export const BOT_HREF_SCHEME = "bot:";

export type MentionableBot = {
  id: string;
  name: string;
  avatar?: string | null;
};

export function mentionHref(botId: string): string {
  return `${BOT_HREF_SCHEME}${encodeURIComponent(botId)}`;
}

export function parseMentionHref(href: string): string | null {
  const raw = href.trim();
  if (!raw.startsWith(BOT_HREF_SCHEME)) return null;
  try {
    const id = decodeURIComponent(raw.slice(BOT_HREF_SCHEME.length));
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Characters that end an `@token` besides whitespace. Covers ASCII and CJK punctuation. Mirrors the daemon's `TOKEN_DELIMITERS`. */
const TOKEN_DELIMITERS = new Set([
  ..."@,.;:!?()[]{}<>\"'`*/\\|",
  ..."，。、：；！？（）【】「」『』《》〈〉“”‘’…～／",
]);

/** The text after `@` up to whitespace or punctuation, so `@分镜，请出图` yields `分镜`. Mirrors the daemon's `mentionToken`. */
export function mentionToken(rest: string): string {
  let end = 0;
  for (const ch of rest) {
    if (/\s/.test(ch) || TOKEN_DELIMITERS.has(ch)) break;
    end += ch.length;
  }
  return rest.slice(0, end);
}

/**
 * The single lenient name the token is a prefix or suffix of, ignoring case.
 * Tokens shorter than two code points never match; ambiguity yields null.
 * Mirrors the daemon's `lenientMatch`.
 */
export function lenientMatch(token: string, names: readonly string[]): string | null {
  if ([...token].length < 2) return null;
  const needle = token.toLowerCase();
  const hits = names.filter((name) => {
    const hay = name.toLowerCase();
    return hay.startsWith(needle) || hay.endsWith(needle);
  });
  return hits.length === 1 ? hits[0] : null;
}

export type LinkifyRosterMentionsOptions = {
  /** Present members eligible for lenient prefix/suffix resolution of misspelt tokens. */
  members?: readonly MentionableBot[];
};

/** Turn roster `@Name` / `@everyone` into markdown links; skip fenced and inline code. */
export function linkifyRosterMentions(
  body: string,
  bots: readonly MentionableBot[] = [],
  options: LinkifyRosterMentionsOptions = {},
): string {
  if (!body || bots.length === 0) return body;
  return splitFences(body)
    .map((part) => (part.fence ? part.text : replaceMentionsOutsideCode(part.text, bots, options)))
    .join("");
}

function replaceMentionsOutsideCode(
  text: string,
  bots: readonly MentionableBot[],
  options: LinkifyRosterMentionsOptions,
): string {
  const protectedParts: string[] = [];
  let next = text.replace(/!?\[(?:[^\]]*)\]\((?:<[^>]+>|[^)\s]+)\)/g, (link) => {
    const token = `\u0000M${protectedParts.length}\u0000`;
    protectedParts.push(link);
    return token;
  });
  next = next.replace(/`([^`\n]+)`/g, (full) => {
    const token = `\u0000M${protectedParts.length}\u0000`;
    protectedParts.push(full);
    return token;
  });
  next = replaceMentionTokens(next, bots, options);
  return next.replace(/\u0000M(\d+)\u0000/g, (_, i: string) => protectedParts[Number(i)] ?? "");
}

function replaceMentionTokens(
  text: string,
  bots: readonly MentionableBot[],
  options: LinkifyRosterMentionsOptions = {},
): string {
  const byName = new Map<string, MentionableBot>();
  for (const bot of bots) {
    if (!byName.has(bot.name)) byName.set(bot.name, bot);
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const memberByName = new Map<string, MentionableBot>();
  for (const member of options.members ?? []) {
    if (!memberByName.has(member.name)) memberByName.set(member.name, member);
  }
  const memberNames = [...memberByName.keys()];
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "@") {
      out += text[i];
      i += 1;
      continue;
    }
    const rest = text.slice(i + 1);
    if (rest.startsWith("everyone") && !startsName("everyone", rest, names)) {
      out += `[@everyone](${BOT_HREF_SCHEME}everyone)`;
      i += 1 + "everyone".length;
      continue;
    }
    const hit = names.find((name) => rest.startsWith(name));
    if (hit) {
      const bot = byName.get(hit)!;
      out += `[@${escapeMdLinkLabel(hit)}](${mentionHref(bot.id)})`;
      i += 1 + hit.length;
      continue;
    }
    const token = mentionToken(rest);
    if (token && looksLikeMention(text, i, token)) {
      const matchedName = lenientMatch(token, memberNames);
      const member = matchedName ? memberByName.get(matchedName) : undefined;
      if (member) {
        out += `[@${escapeMdLinkLabel(member.name)}](${mentionHref(member.id)})`;
      } else if (hasDigit(token)) {
        out += `@${token}`;
      } else {
        out += `[@${escapeMdLinkLabel(token)}](${mentionHref(`unresolved:${token}`)})`;
      }
      i += 1 + token.length;
      continue;
    }
    out += "@";
    i += 1;
  }
  return out;
}

/** Mirrors the daemon: `user@host.com` and `@scope/pkg` are not mention attempts. */
export function looksLikeMention(body: string, at: number, token: string): boolean {
  const prev = at > 0 ? body[at - 1] : "";
  if (/[A-Za-z0-9_]/.test(prev)) return false;
  return body[at + 1 + token.length] !== "/";
}

/** Mirrors the daemon: a token with a digit in it (`@37.79s`, `@f96`, `@14:30`, `@2026-09-18`) reads as "at", never as a miss. */
export function hasDigit(token: string): boolean {
  return /\p{Nd}/u.test(token);
}

function startsName(literal: string, rest: string, names: string[]): boolean {
  return names.some((name) => name !== literal && name.startsWith(literal) && rest.startsWith(name));
}

function escapeMdLinkLabel(name: string): string {
  return name.replace(/[[\]\\]/g, "");
}

const UNRESOLVED_MENTION_PREFIX = "unresolved:";

export type DecorateMentionChipsOptions = {
  /** Title attribute for the unresolved-mention marker; the attribute is omitted when not given. */
  unresolvedTitle?: string;
};

/** After markdown + sanitize, turn `bot:` links into avatar chips (or unresolved markers). */
export function decorateMentionChips(
  html: string,
  bots: readonly MentionableBot[] = [],
  options: DecorateMentionChipsOptions = {},
): string {
  if (!html.includes(BOT_HREF_SCHEME)) return html;
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  return html.replace(
    /<a\b([^>]*?)href="(bot:[^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi,
    (full, _pre: string, href: string, _post: string, inner: string) => {
      const id = parseMentionHref(href.replace(/&amp;/g, "&"));
      if (!id) return full;
      if (id.startsWith(UNRESOLVED_MENTION_PREFIX)) {
        const token = id.slice(UNRESOLVED_MENTION_PREFIX.length);
        const titleAttr = options.unresolvedTitle ? ` title="${escapeHtml(options.unresolvedTitle)}"` : "";
        return `<span class="md-mention-unresolved"${titleAttr}>@${escapeHtml(token)}</span>`;
      }
      if (id === "everyone") {
        return renderTranscriptMentionChip({
          id: "everyone",
          name: "everyone",
          isEveryone: true,
        });
      }
      const bot = byId.get(id);
      const name = bot?.name || innerText(inner).replace(/^@/, "") || id;
      const pal = botAvatarColor(id);
      return renderTranscriptMentionChip({
        id,
        name,
        isEveryone: false,
        avatarSrc: bot?.avatar ? avatarSrc(bot.avatar) : null,
        palette: pal,
        letter: name ? rosterLetter(name) : "?",
      });
    },
  );
}

function innerText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

function renderTranscriptMentionChip(opts: InlineMentionChipData): string {
  const label = escapeHtml(`@${opts.name}`);
  if (opts.isEveryone) {
    return `<span class="md-mention-chip is-everyone" title="${label}"><span class="chip-avatar-icon">👥</span><span class="chip-name">${label}</span></span>`;
  }
  const href = escapeHtml(mentionHref(opts.id));
  let avatar = "";
  const src = safeChipAvatarSrc(opts.avatarSrc);
  if (src) {
    avatar = `<img src="${escapeHtml(src)}" alt="" class="chip-avatar-img">`;
  } else if (opts.palette) {
    const bg = escapeHtml(opts.palette.bg);
    const color = escapeHtml(opts.palette.text);
    const border = escapeHtml(opts.palette.border);
    const letter = escapeHtml(opts.letter || opts.name.charAt(0) || "?");
    avatar = `<span class="chip-avatar-letter" style="background:${bg};color:${color};border-color:${border}">${letter}</span>`;
  }
  return `<a class="md-mention-chip" href="${href}" title="${label}">${avatar}<span class="chip-name">${label}</span></a>`;
}

function safeChipAvatarSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  if (src.startsWith("data:image/") || src.startsWith("https://") || src.startsWith("http://")) {
    return src;
  }
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitFences(body: string): Array<{ text: string; fence: boolean }> {
  const parts: Array<{ text: string; fence: boolean }> = [];
  const re = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
  let last = 0;
  for (const match of body.matchAll(re)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: body.slice(last, start), fence: false });
    parts.push({ text: match[0]!, fence: true });
    last = start + match[0]!.length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), fence: false });
  if (parts.length === 0) parts.push({ text: body, fence: false });
  return parts;
}

