/**
 * Compacting a turn's loop (ADR 0068). Every hop sends the turn's whole loop again — each tool call
 * and result so far — and nothing used to trim it, so a long turn grew until the endpoint refused
 * the prompt (or a local server cut it) and the turn failed with its work lost (ADR 0009, 0067).
 * Now, when a hop is refused as over the model's context, or the next one would come near a window
 * the model's entry names, the older part of the loop is summarized by the turn's own model on the
 * built-in prompt `call.compact` (editable, ADR 0064) and replaced by that summary; the newest hops
 * stay word for word. The pure parts live here: how much fits, where the loop splits, how the old
 * part is written out for the summary, and the note the summary comes back in.
 */
import type { Locale } from "@real-bot/protocol";
import type { ChatMessage } from "./completions";
import { DEFAULT_BYTES_PER_TOKEN, promptBytes } from "./local-model";

/** A next hop estimated past this share of a known window compacts before it is sent. */
export const COMPACT_NEAR_WINDOW = 0.75;
/** After compacting, the rest of the prompt and the kept hops come to at most this share of what fits. */
export const COMPACT_TARGET = 0.5;
/** The newest hops kept word for word take at most this share of what fits. */
export const COMPACT_TAIL_SHARE = 0.2;
/** The written-out record the summary call reads takes at most this share of what fits; it sends no tools. */
export const COMPACT_INPUT_SHARE = 0.6;
/** An old part smaller than this is not worth a summary: it would free next to nothing. */
export const COMPACT_MIN_BYTES = 8_000;
/** What a summary is expected to come to, set aside when sizing the rest. */
export const COMPACT_SUMMARY_TOKENS = 4_000;
/** The summary call's answer cap, reasoning included where the model counts it. */
export const COMPACT_MAX_TOKENS = 16_000;
/** How long the summary call may take. */
export const COMPACT_TIMEOUT_MS = 300_000;
/** An earlier summary, written out for the next one, keeps at most this many code points. */
const EARLIER_SUMMARY_MAX = 24_000;
/** How much of the line that started the turn the summary call is shown. */
const TRIGGER_MAX = 2_000;

/**
 * Bytes a request may come to: the window at the bytes per token this turn's hops were read at, or
 * else the largest request that went through this turn — a floor, since the window is unknown.
 */
export function capacityBytes(window: number | undefined, bytesPerToken: number | undefined, fitBytes: number): number {
  return window && bytesPerToken ? Math.max(window * bytesPerToken, fitBytes) : fitBytes;
}

/** Whether a hop of `bytes` comes near a known window, by the bytes per token this turn was read at. */
export function nearWindow(bytes: number, window: number | undefined, bytesPerToken: number | undefined): boolean {
  if (!window || !bytesPerToken) return false;
  return bytes / bytesPerToken >= window * COMPACT_NEAR_WINDOW;
}

/**
 * Where a loop splits: `old` is summarized, `tail` stays word for word. The tail starts at one of
 * the Bot's own lines, so a tool call keeps its results and an Anthropic model's thinking stays with
 * its call, and comes to at most `tailBytes` — it may hold no hop at all. The notes and lines read
 * out after the last hop's results always stay: they are for the hop about to run.
 */
export function splitLoop(loop: readonly ChatMessage[], tailBytes: number): { old: ChatMessage[]; tail: ChatMessage[] } {
  let end = loop.length;
  while (end > 0 && loop[end - 1]!.role === "user") end -= 1;
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    if (loop[i]!.role !== "assistant") continue;
    if (promptBytes(loop.slice(i, end), []) > tailBytes) break;
    start = i;
  }
  return { old: loop.slice(0, start), tail: [...loop.slice(start, end), ...loop.slice(end)] };
}

export type CompactionPlan = {
  old: ChatMessage[];
  tail: ChatMessage[];
  /** Bytes the written-out record may come to in the summary call. */
  inputBytes: number;
};

/**
 * How to compact a loop, given `capacity` (see {@link capacityBytes}) and `fixed`, the bytes of all
 * a hop sends besides the loop: instructions, transcript, tool definitions. Null when compacting
 * cannot make room — the rest alone already comes near what fits, or the old part is too small
 * for a summary to free anything.
 */
export function planCompaction(
  loop: readonly ChatMessage[],
  size: { capacity: number; fixed: number; bytesPerToken?: number },
): CompactionPlan | null {
  const summary = COMPACT_SUMMARY_TOKENS * (size.bytesPerToken ?? DEFAULT_BYTES_PER_TOKEN);
  if (size.fixed + summary >= size.capacity * COMPACT_NEAR_WINDOW) return null;
  const tailBytes = Math.max(0, Math.min(size.capacity * COMPACT_TAIL_SHARE, size.capacity * COMPACT_TARGET - size.fixed - summary));
  const { old, tail } = splitLoop(loop, tailBytes);
  if (promptBytes(old, []) < COMPACT_MIN_BYTES) return null;
  return { old, tail, inputBytes: Math.floor(size.capacity * COMPACT_INPUT_SHARE) };
}

type EntryKind = "said" | "call" | "result" | "note" | "earlier";
type Entry = { kind: EntryKind; label: string; text: string };

/**
 * Code points each kind keeps, loosest first; the record is written at the first that fits. The
 * loosest keeps a tool result whole: the loop never holds one longer (tool-results.ts).
 */
const CLIP_TIERS: ReadonlyArray<Record<Exclude<EntryKind, "earlier">, number>> = [
  { said: 6_000, call: 2_000, result: 8_000, note: 3_000 },
  { said: 3_000, call: 800, result: 2_000, note: 1_500 },
  { said: 1_500, call: 300, result: 600, note: 800 },
  { said: 600, call: 120, result: 200, note: 400 },
];

const LABELS: Record<Locale, { said: string; call: (name: string) => string; result: (name: string) => string; note: string; earlier: string; picture: string }> = {
  zh: {
    said: "Bot 说",
    call: (name) => `调用 ${name}`,
    result: (name) => `${name} 的结果`,
    note: "应用提示或收到的消息",
    earlier: "之前压缩的摘要",
    picture: "（一张图片）",
  },
  en: {
    said: "The Bot said",
    call: (name) => `Call ${name}`,
    result: (name) => `Result of ${name}`,
    note: "App note or message received",
    earlier: "Earlier summary",
    picture: "(a picture)",
  },
};

function textOf(message: ChatMessage, picture: string): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : picture)).join("\n");
}

function entriesOf(old: readonly ChatMessage[], locale: Locale, earlier: ChatMessage | null): Entry[] {
  const l = LABELS[locale];
  const names = new Map<string, string>();
  const out: Entry[] = [];
  for (const message of old) {
    if (message === earlier) {
      out.push({ kind: "earlier", label: l.earlier, text: textOf(message, l.picture) });
    } else if (message.role === "assistant") {
      const said = textOf(message, l.picture);
      if (said.trim()) out.push({ kind: "said", label: l.said, text: said });
      for (const call of message.tool_calls ?? []) {
        names.set(call.id, call.name);
        out.push({ kind: "call", label: l.call(call.name), text: call.arguments });
      }
    } else if (message.role === "tool") {
      const name = (message.tool_call_id && names.get(message.tool_call_id)) || "tool";
      out.push({ kind: "result", label: l.result(name), text: textOf(message, l.picture) });
    } else {
      out.push({ kind: "note", label: l.note, text: textOf(message, l.picture) });
    }
  }
  return out;
}

/**
 * A text cut to `limit` code points, its start and its end kept: a result's last lines (a closing
 * line, a total, the error a command ended on) matter as much as its first. On 2026-10-08 a real
 * run cut each file it had read from the end, and the summary lost the closing line it was after.
 */
function clipped(text: string, limit: number, locale: Locale): string {
  const points = Array.from(text);
  if (points.length <= limit) return text;
  const head = Math.ceil((limit * 2) / 3);
  const tail = limit - head;
  const dropped = points.length - limit;
  const gap = locale === "en" ? `… (${dropped} characters left out) …` : `…（中间略去 ${dropped} 字）…`;
  return `${points.slice(0, head).join("")}${gap}${tail > 0 ? points.slice(points.length - tail).join("") : ""}`;
}

function render(entries: readonly Entry[], tier: (typeof CLIP_TIERS)[number], locale: Locale): string[] {
  return entries.map((entry) => {
    const limit = entry.kind === "earlier" ? EARLIER_SUMMARY_MAX : tier[entry.kind];
    return `【${entry.label}】\n${clipped(entry.text, limit, locale)}`;
  });
}

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * The old part of a loop written out for the summary call, oldest first, within `budgetBytes`:
 * each tool result, call and line cut shorter tier by tier until the whole fits, and past the
 * tightest tier the oldest entries left out (an earlier summary is kept first).
 */
export function writeOutLoop(old: readonly ChatMessage[], budgetBytes: number, locale: Locale, earlier: ChatMessage | null = null): string {
  const entries = entriesOf(old, locale, earlier);
  for (const tier of CLIP_TIERS) {
    const text = render(entries, tier, locale).join("\n\n");
    if (bytesOf(text) <= budgetBytes) return text;
  }
  const tightest = render(entries, CLIP_TIERS.at(-1)!, locale);
  const keepFirst = entries[0]?.kind === "earlier" ? 1 : 0;
  let from = keepFirst;
  const joined = () => [...tightest.slice(0, keepFirst), ...(from > keepFirst ? [omittedLine(from - keepFirst, locale)] : []), ...tightest.slice(from)].join("\n\n");
  while (from < tightest.length - 1 && bytesOf(joined()) > budgetBytes) from += 1;
  return joined();
}

function omittedLine(count: number, locale: Locale): string {
  return locale === "en" ? `(${count} earlier entries did not fit and are left out)` : `（更早的 ${count} 条记录放不下，略去）`;
}

/** What the summary call reads: the line that started the turn, then the record to condense. */
export function compactPayload(locale: Locale, trigger: string, record: string): string {
  const said = clipped(trigger.trim(), TRIGGER_MAX, locale);
  return locale === "en"
    ? `What started this turn (the line the Bot received):\n${said}\n\nThe work record to condense, oldest first:\n\n${record}`
    : `这一轮的起因（Bot 收到的那句话）：\n${said}\n\n要压缩的工作记录（从早到晚）：\n\n${record}`;
}

/** The line the summary goes back to the Bot in, in place of the hops it condenses. */
export function compactNote(locale: Locale, summary: string): string {
  return locale === "en"
    ? `(App note) This turn's earlier work no longer fit in your context, so it was condensed into the summary below; the original tool calls and results are gone from your context. What the summary records is work you have done and facts you have found: count it in when you finish and reply, without doing it again. Read files again when you need details — tool results over 8,000 characters are saved in full under tool-results/ in your work dir. Carry on from where the summary leaves off; once the work is done, reply with the result as usual. Do not answer this note itself.\n\n${summary.trim()}`
    : `（应用提示）这一轮前面的工作在上下文里放不下了，已压缩成下面的摘要；之前工具调用和结果的原文已不在你的上下文里。摘要里记下的是你已经做完、已经查到的，收尾和回复时一并算上，不用重做。需要细节就重新读文件——超过 8000 字的工具结果完整存在工作目录的 tool-results/ 下。从摘要停下的地方接着做；要做的都做完了，就照常直接回复结果。这条提示本身不用回应。\n\n${summary.trim()}`;
}

/** How many of the loop's lines are hops the summary took the place of: the Bot's own lines in `old`. */
export function hopsIn(old: readonly ChatMessage[]): number {
  return old.filter((message) => message.role === "assistant").length;
}
