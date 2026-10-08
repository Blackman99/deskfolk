/** The transcript window a turn sees, with the pictures it may look at. */
import type { Attachment, Locale, Message } from "@real-bot/protocol";
import { existsSync, statSync } from "node:fs";
import { annotationContext } from "../annotation-context";
import { askTranscriptText } from "../ask";
import type { ChatContentPart, ChatMessage } from "../completions";
import { pictureMime } from "../loop-pictures";
import type { Store } from "../store";
import { takeCodePoints } from "../text";
import { visionImage } from "../vision-image";
import { botDisplayName, oneLineClip, PLAN_TAG_TITLE_MAX } from "./common";

const MAIN_LIMIT = 40;
const BODY_LIMIT = 4000;

/** Marks the message that opened this turn. Chinese in every locale, like transcript prefixes. */
export const TRIGGER_FLAG = "（本轮触发）";
/** On a line of yours you changed after sending it (ADR 0063); Chinese in every locale, like TRIGGER_FLAG. */
export const EDITED_FLAG = "（发出后改过）";

/** The plan and ticket a line or a turn belongs to, as `task_id` / `ticket_id` carry them. */
export type PlanRef = { taskId: string | null; ticketId: string | null };

/**
 * Names the plan and ticket a line belongs to, as seen from the turn reading it: another plan reads
 * `〔规划「title」· 任务 03〕`, another ticket of the same plan `〔任务 03〕`, and the turn's own
 * ticket — or a line nobody filed — nothing. The title is the plan's opening words, which never
 * change once it is open, so a plan keeps one name across turns and matches the messenger. The
 * lookups are cached for the one assembly that owns the tagger.
 */
export function planTagger(store: Store, relativeTo: PlanRef, locale: Locale): (ref: PlanRef) => string {
  const en = locale === "en";
  const titles = new Map<string, string | null>();
  const seqs = new Map<string, number | null>();
  const title = (id: string): string | null => {
    if (!titles.has(id)) {
      try {
        titles.set(id, oneLineClip(store.getTask(id).title, PLAN_TAG_TITLE_MAX));
      } catch {
        titles.set(id, null);
      }
    }
    return titles.get(id)!;
  };
  const seq = (id: string): number | null => {
    if (!seqs.has(id)) {
      try {
        seqs.set(id, store.getTicket(id).seq);
      } catch {
        seqs.set(id, null);
      }
    }
    return seqs.get(id)!;
  };
  return (ref) => {
    if (!ref.taskId) return "";
    const number = ref.ticketId ? seq(ref.ticketId) : null;
    const ticket = number === null ? null : `${en ? "ticket" : "任务"} ${String(number).padStart(2, "0")}`;
    if (ref.taskId !== relativeTo.taskId) {
      const name = title(ref.taskId);
      if (name === null) return "";
      const plan = en ? `plan "${name}"` : `规划「${name}」`;
      return `〔${ticket ? `${plan} · ${ticket}` : plan}〕`;
    }
    if (!ticket || ref.ticketId === relativeTo.ticketId) return "";
    return `〔${ticket}〕`;
  };
}

export function transcriptWindow(
  store: Store,
  input: {
    sessionId: string;
    turnId: string;
    triggerMessageId: string;
    selfBotId: string;
    /** What the pictures this turn has read already spend; the window gets what is left. */
    loopPictures: { images: number; bytes: number };
    locale: Locale;
  },
): ChatMessage[] {
  const trigger = store.getMessage(input.triggerMessageId);
  // A session carries more than one job, and a line from another plan or ticket says which.
  const tag = planTagger(
    store,
    { taskId: store.taskOfTurn(input.turnId), ticketId: store.ticketOfTurn(input.turnId) },
    input.locale,
  );
  const main = store
    .listMainMessages(input.sessionId, MAIN_LIMIT)
    .filter((m) => m.turn_id !== input.turnId)
    .reverse();
  const byId = new Map<string, Message>();
  for (const m of main) byId.set(m.id, m);
  const ordered: Message[] = [...main];
  // A trigger the window leaves out, older than it or a check-back's line nobody else is shown,
  // still reads where it happened.
  if (!trigger.parent_id && !byId.has(trigger.id) && trigger.turn_id !== input.turnId) {
    const at = ordered.findIndex((m) => m.created_at > trigger.created_at);
    ordered.splice(at < 0 ? ordered.length : at, 0, trigger);
  }
  if (trigger.parent_id) {
    for (const m of store.listThreadMessages(trigger.parent_id)) {
      if (m.turn_id === input.turnId) continue;
      if (byId.has(m.id) || ordered.some((x) => x.id === m.id)) continue;
      ordered.push(m);
    }
  }
  const seen = new Set<string>();
  const unique: Message[] = [];
  for (const m of ordered) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    unique.push(m);
  }
  // A batch of annotations is spelled out under the user's message that carries it, crops as pixels.
  const locale = store.settingsCached().locale;
  const annotated = new Map<string, ReturnType<typeof annotationContext>>();
  for (const m of unique) {
    if (m.kind === "user") annotated.set(m.id, annotationContext(store, m.id, locale));
  }
  const { images, cropsSent } = windowImages(store, unique, input.selfBotId, input.triggerMessageId, annotated, input.loopPictures);
  return unique.map((m) =>
    serializeTranscript(
      store,
      m,
      input.selfBotId,
      input.triggerMessageId,
      annotated.get(m.id)?.textFor(cropsSent.get(m.id) ?? 0) ?? "",
      images.get(m.id) ?? [],
      tag({ taskId: m.task_id ?? null, ticketId: m.ticket_id ?? null }),
    ),
  );
}

/** One image over this is skipped on its own; it never counts against the window. */
const VISION_BYTES_MAX = 10_000_000;
/**
 * What the whole window may carry as pictures. Every raster in the last forty lines used to ride
 * on every request, and a storyboard group grew one turn to 54 images and 85 MB of base64: the
 * endpoint never answered, and the turn read as "couldn't reach the endpoint" however often it
 * was continued. Spent newest first with the trigger ahead of everything, and the first picture
 * that does not fit closes it, so what drops out is always the oldest. Those keep their path line.
 * Bytes are counted as sent, after `visionImage` has shrunk them. An annotation batch's crops
 * (up to 50, a megabyte each) spend the same budget, after the attachments of their message.
 * Pictures the Bot read this turn with `read_file` ride the loop and come off the top of it.
 */
export const VISION_WINDOW_IMAGES = 20;
export const VISION_WINDOW_BYTES = 20_000_000;

type VisionBudget = { images: number; bytes: number; closed: boolean };

function windowImages(
  store: Store,
  messages: Message[],
  selfBotId: string,
  triggerMessageId: string,
  annotated: Map<string, { images: ChatContentPart[] }>,
  loopPictures: { images: number; bytes: number },
): { images: Map<string, ChatContentPart[]>; cropsSent: Map<string, number> } {
  const budget: VisionBudget = {
    images: Math.max(0, VISION_WINDOW_IMAGES - loopPictures.images),
    bytes: Math.max(0, VISION_WINDOW_BYTES - loopPictures.bytes),
    closed: false,
  };
  const trigger = messages.find((m) => m.id === triggerMessageId);
  const newestFirst = [...(trigger ? [trigger] : []), ...messages.filter((m) => m !== trigger).reverse()];
  const out = new Map<string, ChatContentPart[]>();
  const cropsSent = new Map<string, number>();
  for (const message of newestFirst) {
    if (budget.closed) break;
    // The Bot's own lines go out as assistant text, which carries no pictures.
    if (message.kind === "bot" && message.author === selfBotId) continue;
    const attached = visionImageParts(store, message.attachments, budget);
    const crops = cropParts(annotated.get(message.id)?.images ?? [], budget);
    cropsSent.set(message.id, crops.length);
    const parts = [...attached, ...crops];
    if (parts.length > 0) out.set(message.id, parts);
  }
  return { images: out, cropsSent };
}

function serializeTranscript(
  store: Store,
  message: Message,
  selfBotId: string,
  triggerMessageId: string,
  annotationText: string,
  images: ChatContentPart[],
  /** The line's plan and ticket when they are not this turn's; empty otherwise. */
  tag: string,
): ChatMessage {
  const clipped = takeCodePoints(message.body, BODY_LIMIT);
  let body = clipped.text;
  if (clipped.truncated) body += `\n…（truncated，原 ${clipped.original} 字）`;
  if (message.kind === "ask") body = askTranscriptText(message, body);
  for (const att of message.attachments) {
    body += `\n附件：${att.workspace_relpath}`;
  }
  body += annotationText;
  const triggerLine = message.id === triggerMessageId ? `${TRIGGER_FLAG}\n` : "";
  // A line of yours reads as it now does; this says it is not what it first said (ADR 0063).
  const editedLine = message.kind === "user" && message.edited_at ? `${EDITED_FLAG}\n` : "";
  // The Bot's own lines stay bare: a tag in its own voice is one it would start writing itself.
  if (message.kind === "bot" && message.author === selfBotId) {
    return { role: "assistant", content: `${triggerLine}${body}` };
  }
  const text = `${prefix(store, message)}${tag}\n${triggerLine}${editedLine}${body}`;
  return {
    role: "user",
    content: images.length > 0 ? [{ type: "text", text }, ...images] : text,
  };
}

function visionImageParts(store: Store, attachments: Attachment[], budget: VisionBudget): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const att of attachments) {
    if (budget.closed) break;
    const mime = pictureMime(att.original_filename) ?? pictureMime(att.workspace_relpath);
    if (!mime) continue;
    try {
      const abs = store.getAttachmentFilePath(att);
      if (!existsSync(abs)) continue;
      const stat = statSync(abs);
      if (stat.size > VISION_BYTES_MAX) continue;
      if (budget.images === 0) {
        budget.closed = true;
        break;
      }
      const image = visionImage(abs, mime, stat);
      if (image.bytes.byteLength > VISION_BYTES_MAX) continue;
      if (image.bytes.byteLength > budget.bytes) {
        budget.closed = true;
        break;
      }
      budget.images -= 1;
      budget.bytes -= image.bytes.byteLength;
      parts.push({
        type: "image_url",
        image_url: { url: `data:${image.mime};base64,${image.bytes.toString("base64")}` },
      });
    } catch {
      // Missing or unreadable files stay as the path line only.
    }
  }
  return parts;
}

/**
 * An annotation batch's crops under the window budget. They are already small (1 MB at most, see
 * `ANNOTATION_CROP_MAX_BYTES`), so nothing is shrunk; a dropped crop leaves the annotation's text.
 */
function cropParts(crops: ChatContentPart[], budget: VisionBudget): ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  for (const crop of crops) {
    if (budget.closed) break;
    if (crop.type !== "image_url") continue;
    const { url } = crop.image_url;
    const bytes = Buffer.byteLength(url.slice(url.indexOf(",") + 1), "base64");
    if (budget.images === 0 || bytes > budget.bytes) {
      budget.closed = true;
      break;
    }
    budget.images -= 1;
    budget.bytes -= bytes;
    parts.push(crop);
  }
  return parts;
}

export function prefix(store: Store, message: Message): string {
  switch (message.kind) {
    case "user":
      return "【user】";
    case "ask":
      return "【提问】";
    case "approval":
      return "【批准】";
    case "profile_change":
      return "【人设】";
    case "system":
      return "【系统】";
    case "bot":
      return `【${botDisplayName(store, message.author)}】`;
    default:
      return "【user】";
  }
}
