/**
 * 批注在上下文窗里的样子：带批注的那条用户消息，在正文后面把每条批注按固定格式展开——交给哪个 Bot、
 * 路径、种类、位置、引文或裁图、意见——让 Bot 不用猜「这一段」是哪一段、这条归不归自己。裁图按栅格附件的
 * 同一套规则作为像素发给模型。
 *
 * 这些行在用户那条消息里，里面的字段却有一半来自文件或页面（路径、选择器、元素文字、HTML、引文），
 * 所以任何字段都不能自己起一行、冒充一条批注：单行字段把换行折成空格，多行字段的续行缩进到字段之下。
 */
import {
  anchorKindLabel,
  clipQuote,
  describeAnchor,
  type Annotation,
  type AnnotationLocale,
  type HtmlElementAnchor,
  type Locale,
  type PdfRegionAnchor,
  type TextRangeAnchor,
} from "@real-bot/protocol";
import type { ChatContentPart } from "./completions";
import type { Store } from "./store";

const COPY = {
  zh: {
    tag: "批注",
    where: "位置",
    quote: "引文",
    element: "元素文字",
    html: "HTML 片段",
    note: "意见",
    crop: "（附区域裁图）",
    cropLeftOut: "（区域裁图没附上：这一轮能带的图片已经用完了）",
    movedTo: (lines: string) => `（原文已变，重新定位到${lines}）`,
    changed: "（原文已变）",
    missing: "（文件不在了）",
    resolved: (by: string, note: string | null) => `已处理（${by}${note ? `：${note}` : ""}）`,
    user: "用户",
    forBot: (name: string | null) => (name === null ? "给已删除的 Bot" : `给 ${name}`),
  },
  en: {
    tag: "Annotation",
    where: "Where",
    quote: "Quote",
    element: "Element text",
    html: "HTML",
    note: "Note",
    crop: "(region crop attached)",
    cropLeftOut: "(region crop left out: this turn has no room for more pictures)",
    movedTo: (lines: string) => `(the text moved; now at ${lines})`,
    changed: "(the text changed)",
    missing: "(the file is gone)",
    resolved: (by: string, note: string | null) => `resolved (${by}${note ? `: ${note}` : ""})`,
    user: "the user",
    forBot: (name: string | null) => (name === null ? "for a deleted Bot" : `for ${name}`),
  },
} as const;

/** Every break a model may read as a new line, not just `\n`. */
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
const LINE_BREAKS = new RegExp(LINE_BREAK.source, "g");

/** A field that must stay on its line (path, selector, element text, markup, names): breaks fold into one space. */
export function oneLine(value: string): string {
  return value
    .split(LINE_BREAK)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" ");
}

/** A field that may run over several lines (quote, remark): each continuation sits under the field, never at a line's start. */
export function indented(value: string): string {
  return value.replace(LINE_BREAKS, "\n    ");
}

function oneLineElement(element: HtmlElementAnchor): HtmlElementAnchor {
  return { ...element, selector: oneLine(element.selector), text: oneLine(element.text), outer_html: oneLine(element.outer_html) };
}

/**
 * The lines one annotation contributes, plus whether its crop should follow as an image.
 * @param index - 1-based position in the batch, for `[批注 2/3 · id=… · 给 Beta]`.
 * @param botName - A Bot's name, or null once it is deleted; names the Bot it was handed to and who resolved it.
 */
export function annotationLines(
  annotation: Annotation,
  index: number,
  total: number,
  locale: Locale,
  botName: (id: string) => string | null,
  /** Whether this annotation's crop rides along; the window's picture budget may have run out. */
  cropSent = true,
): string[] {
  const l = locale === "en" ? "en" : "zh";
  const c = COPY[l];
  const kind = anchorKindLabel(annotation.anchor_kind, l as AnnotationLocale);
  const resolver = annotation.resolved_by === "user" ? c.user : annotation.resolved_by ? botName(annotation.resolved_by) ?? annotation.resolved_by : "?";
  const status = annotation.status === "resolved"
    ? ` · ${c.resolved(oneLine(resolver), annotation.resolved_note === null ? null : oneLine(annotation.resolved_note))}`
    : "";
  // Which Bot the batch was handed to: in a group, one batch can carry annotations for several.
  const owner = botName(annotation.bot_id);
  const lines = [`[${c.tag} ${index}/${total} · id=${annotation.id} · ${c.forBot(owner === null ? null : oneLine(owner))}] ${oneLine(annotation.relpath)} · ${kind}${status}`];
  // The selector, the text and the markup are the page's; the position line quotes the first two.
  const element = annotation.anchor_kind === "html_element" ? oneLineElement(annotation.anchor as HtmlElementAnchor) : null;
  let where = describeAnchor(annotation.anchor_kind, element ?? annotation.anchor, l as AnnotationLocale);
  const stale = annotation.stale;
  if (stale?.kind === "moved") {
    const moved = describeAnchor("text_range", { ...(annotation.anchor as TextRangeAnchor), start_line: stale.start_line, end_line: stale.end_line }, l as AnnotationLocale);
    where += c.movedTo(moved);
  } else if (stale?.kind === "changed") {
    where += c.changed;
  } else if (stale?.kind === "missing") {
    where += c.missing;
  }
  lines.push(`  ${c.where}：${where}`);
  const quote = annotation.anchor_kind === "text_range"
    ? (annotation.anchor as TextRangeAnchor).quote
    : annotation.anchor_kind === "pdf_region"
      ? (annotation.anchor as PdfRegionAnchor).quote ?? ""
      : "";
  if (quote.trim()) lines.push(`  ${c.quote}：${indented(clipQuote(quote, undefined, l as AnnotationLocale))}`);
  if (element) {
    // No pixels cross the sandbox: the Bot gets the selector (in the position line), the text, and the markup.
    if (element.text) lines.push(`  ${c.element}：${element.text}`);
    if (element.outer_html) lines.push(`  ${c.html}：${element.outer_html}`);
  }
  lines.push(`  ${c.note}：${indented(annotation.body)}`);
  if (annotation.crop_mime) lines.push(`  ${cropSent ? c.crop : c.cropLeftOut}`);
  return lines;
}

/**
 * What a message's annotations add to the window: the text block appended after the body, and
 * the crops as image parts in the same order. The window may send only the first few crops (they
 * share its picture budget), so the text comes from `textFor(sent)`: the crops sent say so, the
 * rest say they were left out. `text` is the block with every crop sent. Empty for a message
 * that carries none.
 */
export function annotationContext(
  store: Store,
  messageId: string,
  locale: Locale,
): { text: string; images: ChatContentPart[]; textFor: (sent: number) => string } {
  const annotations = store.annotationsOfMessage(messageId);
  if (annotations.length === 0) return { text: "", images: [], textFor: () => "" };
  const names = new Map<string, string | null>();
  const botName = (id: string): string | null => {
    if (names.has(id)) return names.get(id) ?? null;
    let name: string | null = null;
    try {
      name = store.getBot(id).name;
    } catch {
      // Deleted: the line says so (or keeps the resolver's id).
    }
    names.set(id, name);
    return name;
  };
  const images: ChatContentPart[] = [];
  /** Which annotation each crop belongs to, in the order the crops are sent. */
  const cropOf: number[] = [];
  annotations.forEach((annotation, i) => {
    if (!annotation.crop_mime) return;
    const crop = store.annotationCrop(annotation.id);
    if (!crop) return;
    images.push({ type: "image_url", image_url: { url: `data:${crop.mime};base64,${Buffer.from(crop.bytes).toString("base64")}` } });
    cropOf.push(i);
  });
  const textFor = (sent: number): string => {
    const kept = new Set(cropOf.slice(0, sent));
    const blocks = annotations.map((annotation, i) =>
      annotationLines(annotation, i + 1, annotations.length, locale, botName, !annotation.crop_mime || kept.has(i)).join("\n"),
    );
    return `\n\n${blocks.join("\n")}`;
  };
  return { text: textFor(images.length), images, textFor };
}
