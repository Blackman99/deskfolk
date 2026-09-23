/**
 * 批注在上下文窗里的样子：带批注的那条用户消息，在正文后面把每条批注按固定格式展开——路径、种类、
 * 位置、引文或裁图、意见——让 Bot 不用猜「这一段」是哪一段。裁图按栅格附件的同一套规则作为像素发给模型。
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
    movedTo: (lines: string) => `（原文已变，重新定位到${lines}）`,
    changed: "（原文已变）",
    missing: "（文件不在了）",
    resolved: (by: string, note: string | null) => `已处理（${by}${note ? `：${note}` : ""}）`,
    user: "用户",
  },
  en: {
    tag: "Annotation",
    where: "Where",
    quote: "Quote",
    element: "Element text",
    html: "HTML",
    note: "Note",
    crop: "(region crop attached)",
    movedTo: (lines: string) => `(the text moved; now at ${lines})`,
    changed: "(the text changed)",
    missing: "(the file is gone)",
    resolved: (by: string, note: string | null) => `resolved (${by}${note ? `: ${note}` : ""})`,
    user: "the user",
  },
} as const;

/**
 * The lines one annotation contributes, plus whether its crop should follow as an image.
 * @param index - 1-based position in the batch, for `[批注 2/3 · id=…]`.
 */
export function annotationLines(annotation: Annotation, index: number, total: number, locale: Locale, resolverName: (id: string) => string): string[] {
  const l = locale === "en" ? "en" : "zh";
  const c = COPY[l];
  const kind = anchorKindLabel(annotation.anchor_kind, l as AnnotationLocale);
  const status = annotation.status === "resolved"
    ? ` · ${c.resolved(annotation.resolved_by === "user" ? c.user : resolverName(annotation.resolved_by ?? ""), annotation.resolved_note)}`
    : "";
  const lines = [`[${c.tag} ${index}/${total} · id=${annotation.id}] ${annotation.relpath} · ${kind}${status}`];
  let where = describeAnchor(annotation.anchor_kind, annotation.anchor, l as AnnotationLocale);
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
  if (quote.trim()) lines.push(`  ${c.quote}：${clipQuote(quote, undefined, l as AnnotationLocale).replace(/\n/g, "\n    ")}`);
  if (annotation.anchor_kind === "html_element") {
    // No pixels cross the sandbox: the Bot gets the selector (in the position line), the text, and the markup.
    const element = annotation.anchor as HtmlElementAnchor;
    if (element.text.trim()) lines.push(`  ${c.element}：${element.text.trim()}`);
    if (element.outer_html.trim()) lines.push(`  ${c.html}：${element.outer_html.trim().replace(/\s*\n\s*/g, " ")}`);
  }
  lines.push(`  ${c.note}：${annotation.body}`);
  if (annotation.crop_mime) lines.push(`  ${c.crop}`);
  return lines;
}

/**
 * What a message's annotations add to the window: the text block appended after the body, and
 * the crops as image parts in the same order. Empty for a message that carries none.
 */
export function annotationContext(store: Store, messageId: string, locale: Locale): { text: string; images: ChatContentPart[] } {
  const annotations = store.annotationsOfMessage(messageId);
  if (annotations.length === 0) return { text: "", images: [] };
  const names = new Map<string, string>();
  const resolverName = (id: string): string => {
    if (!id) return "?";
    const known = names.get(id);
    if (known) return known;
    let name = id;
    try {
      name = store.getBot(id).name;
    } catch {
      // A deleted Bot keeps its id on the line.
    }
    names.set(id, name);
    return name;
  };
  const blocks: string[] = [];
  const images: ChatContentPart[] = [];
  annotations.forEach((annotation, i) => {
    blocks.push(annotationLines(annotation, i + 1, annotations.length, locale, resolverName).join("\n"));
    if (annotation.crop_mime) {
      const crop = store.annotationCrop(annotation.id);
      if (crop) images.push({ type: "image_url", image_url: { url: `data:${crop.mime};base64,${Buffer.from(crop.bytes).toString("base64")}` } });
    }
  });
  return { text: `\n\n${blocks.join("\n")}`, images };
}
