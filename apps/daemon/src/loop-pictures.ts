/**
 * Pictures a Bot looks at mid-turn. `read_file` on a PNG / JPEG / GIF / WebP answers with a tool
 * result that names the file, and the picture itself rides one user line after that hop's tool
 * results: the chat format carries images on user lines, never on tool results. Before this a
 * reviewer handed eighteen keyframe paths could only compare their prompts, converted the frames
 * four ways looking for a format `read_file` would take, and closed with "conclusion to follow".
 *
 * The loop is resent on every hop, so its pictures spend the transcript window's budget first
 * (see `VISION_WINDOW_IMAGES` in context.ts). One hop attaches at most `LOOP_PICTURES_MAX`; when a
 * new hop's pictures do not fit, earlier hops' give way oldest first and keep their path line, so
 * the Bot can read one again. Only these lines put pictures in the loop, which is what lets the
 * budget count every image part there as one of them.
 */
import { extname } from "node:path";
import type { Locale } from "@real-bot/protocol";
import type { ChatContentPart, ChatMessage } from "./completions";

/** Pictures the loop carries at once; the transcript window keeps the rest of its budget. */
export const LOOP_PICTURES_MAX = 12;
/** Their bytes as sent, after `visionImage` has shrunk them. */
export const LOOP_PICTURE_BYTES_MAX = 8_000_000;

export type LoopPicture = { path: string; mime: string; bytes: Buffer };

const PICTURE_MIMES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** The picture type `read_file` shows as an image, or null for anything it reads as text. */
export function pictureMime(path: string): string | null {
  return PICTURE_MIMES[extname(path).toLowerCase()] ?? null;
}

function sentBytes(part: ChatContentPart): number {
  if (part.type !== "image_url") return 0;
  const url = part.image_url.url;
  const comma = url.indexOf(",");
  if (comma < 0) return url.length;
  const padding = url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0;
  return ((url.length - comma - 1) * 3) / 4 - padding;
}

/** What the loop's pictures spend of a request's picture budget. */
export function loopPictureSpend(loop: readonly ChatMessage[]): { images: number; bytes: number } {
  let images = 0;
  let bytes = 0;
  for (const message of loop) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "image_url") continue;
      images += 1;
      bytes += sentBytes(part);
    }
  }
  return { images, bytes };
}

/** Whether `next` still fits the pictures this hop is attaching. */
export function fitsHop(hop: readonly LoopPicture[], next: LoopPicture): boolean {
  if (hop.length >= LOOP_PICTURES_MAX) return false;
  const used = hop.reduce((sum, picture) => sum + picture.bytes.byteLength, 0);
  return used + next.bytes.byteLength <= LOOP_PICTURE_BYTES_MAX;
}

/** What the tool result says about the picture, so the model knows where to look or what to do. */
export function pictureResultNote(locale: Locale, attached: boolean): string {
  if (locale === "en") {
    return attached
      ? "Shown as an image in the user line after this batch of tool results."
      : `Not shown: this hop already attaches ${LOOP_PICTURES_MAX} images or ${LOOP_PICTURE_BYTES_MAX / 1_000_000} MB. Look at those first, then read_file this one again.`;
  }
  return attached
    ? "已作为图像附在这批工具结果之后的那条消息里。"
    : `没附上：这一跳已经附了 ${LOOP_PICTURES_MAX} 张或 ${LOOP_PICTURE_BYTES_MAX / 1_000_000} MB 图。先看完那些，再 read_file 这一张。`;
}

function evictedNote(locale: Locale): string {
  return locale === "en"
    ? "(This image has left the context to make room; read_file it again to look.)"
    : "（这张图已移出上下文，给新读的图腾出位置；要再看就重新 read_file。）";
}

/**
 * Puts this hop's pictures in the loop: earlier hops' give way oldest first until the budget holds
 * them all, then one user line carries each path followed by its image. A line that loses a
 * picture is replaced, not edited, since requests already sent hold the same objects.
 */
export function attachPictures(loop: ChatMessage[], hop: readonly LoopPicture[], locale: Locale): void {
  if (hop.length === 0) return;
  const incomingBytes = hop.reduce((sum, picture) => sum + picture.bytes.byteLength, 0);
  let { images, bytes } = loopPictureSpend(loop);
  const fits = () => images + hop.length <= LOOP_PICTURES_MAX && bytes + incomingBytes <= LOOP_PICTURE_BYTES_MAX;
  for (let i = 0; i < loop.length && !fits(); i += 1) {
    const message = loop[i]!;
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const content = message.content.map((part): ChatContentPart => {
      if (part.type !== "image_url" || fits()) return part;
      images -= 1;
      bytes -= sentBytes(part);
      return { type: "text", text: evictedNote(locale) };
    });
    loop[i] = { ...message, content };
  }
  const parts: ChatContentPart[] = [
    { type: "text", text: locale === "en" ? "Images read with read_file, in call order:" : "read_file 读到的图片，按调用顺序：" },
  ];
  for (const picture of hop) {
    parts.push({ type: "text", text: picture.path });
    parts.push({ type: "image_url", image_url: { url: `data:${picture.mime};base64,${picture.bytes.toString("base64")}` } });
  }
  loop.push({ role: "user", content: parts });
}
