/**
 * 批注（Annotation）：你对某个产物某一处写的一句意见，挂在一个工作区相对路径、一个锚点和交出这个产物
 * 的那条消息上。这里是守护进程和信使共用的纯函数：锚点的形状、上限、陈旧判定与文本重新定位、位置摘要。
 * 没有 I/O——哈希由两侧各自算好再传进来。
 */

export const ANNOTATION_BATCH_MAX = 50;
export const ANNOTATION_BODY_MAX = 2000;
export const ANNOTATION_CROP_MAX_BYTES = 1024 * 1024;
/** `text_range.quote` 最多 2000 字，`prefix` / `suffix` 各 60 字，用于重新定位。 */
export const ANNOTATION_QUOTE_MAX = 2000;
export const ANNOTATION_AFFIX_MAX = 60;
/** Bot 上下文里引文超过这个长度就截断并标出。 */
export const ANNOTATION_CONTEXT_QUOTE_MAX = 300;
export const ANNOTATION_HTML_TEXT_MAX = 300;
export const ANNOTATION_HTML_OUTER_MAX = 1000;
export const ANNOTATION_CROP_MIMES = ["image/png", "image/jpeg"] as const;

export type AnnotationStatus = "draft" | "open" | "resolved";
export type AnnotationAnchorKind = "text_range" | "image_region" | "pdf_region" | "html_element" | "media_time";
export const ANNOTATION_ANCHOR_KINDS: readonly AnnotationAnchorKind[] = [
  "text_range",
  "image_region",
  "pdf_region",
  "html_element",
  "media_time",
];

/** 文本 / 代码行区间。行号和列号都从 1 起（Monaco 的约定）；`end_col` 是选区结束后的那一列（不含）。 */
export type TextRangeAnchor = {
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  quote: string;
  prefix: string;
  suffix: string;
  /** 在 Markdown 渲染态下加的：信使据此决定定位时切到哪个视图。 */
  view?: "rendered";
  /**
   * 选区长于引文上限时（引文只留了开头），整段选区的长度（UTF-16 单元，换行按 `\n`）和指纹
   * （{@link spanHash}）：据此判断文件改动后这一段还在不在、有没有变，而不是只看开头。
   */
  span_length?: number;
  span_hash?: string;
};

/** 图片框选：按原图尺寸归一化到 0–1。 */
export type ImageRegionAnchor = {
  x: number;
  y: number;
  w: number;
  h: number;
  natural_width: number;
  natural_height: number;
};

/** PDF 页内区域：按该页尺寸归一化；选区落在文字层上时带引文。 */
export type PdfRegionAnchor = {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  quote?: string;
};

/** HTML 元素：注入脚本回传的那些字段；`rect` 按文档尺寸归一化。 */
export type HtmlElementAnchor = {
  selector: string;
  tag: string;
  text: string;
  outer_html: string;
  rect: { x: number; y: number; w: number; h: number };
};

/** 音视频时间点或时间段。 */
export type MediaTimeAnchor = {
  start_ms: number;
  end_ms?: number;
  duration_ms: number;
};

export type AnnotationAnchor =
  | TextRangeAnchor
  | ImageRegionAnchor
  | PdfRegionAnchor
  | HtmlElementAnchor
  | MediaTimeAnchor;

export type AnchorOf<K extends AnnotationAnchorKind> = K extends "text_range"
  ? TextRangeAnchor
  : K extends "image_region"
    ? ImageRegionAnchor
    : K extends "pdf_region"
      ? PdfRegionAnchor
      : K extends "html_element"
        ? HtmlElementAnchor
        : MediaTimeAnchor;

/**
 * 现算的陈旧状态：`null` 不陈旧（文件没变，或者变的是别处、引文还在原位）；`missing` 文件不在了；
 * `changed` 文件已变、位置可能不准；`moved` 文件变了但按引文重新定位到了新的行区间（只用于显示，
 * 不改库里存的锚点）。
 */
export type AnnotationStale =
  | null
  | { kind: "missing" }
  | { kind: "changed" }
  | { kind: "moved"; start_line: number; start_col: number; end_line: number; end_col: number };

export type AnnotationCrop = { mime: (typeof ANNOTATION_CROP_MIMES)[number]; base64: string };

export type Annotation = {
  id: string;
  status: AnnotationStatus;
  relpath: string;
  anchor_kind: AnnotationAnchorKind;
  anchor: AnnotationAnchor;
  content_sha256: string;
  /** 交付消息。 */
  target_message_id: string;
  target_session_id: string;
  target_turn_id: string | null;
  /** 交付的 Bot。 */
  bot_id: string;
  /** 发往哪个会话。 */
  session_id: string;
  /** 发出去的那条消息；草稿时为空。 */
  message_id: string | null;
  body: string;
  /** 裁图的类型；没有裁图时为空。字节另取。 */
  crop_mime: string | null;
  resolved_by: string | null;
  resolved_note: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  /** `GET /v1/annotations` 每条都带上现算的陈旧状态。 */
  stale?: AnnotationStale;
  /**
   * 批注所在的文件：相对工作区、解析掉符号链接和大小写。`relpath` 是引用时的写法，同一个文件
   * 换一种写法引用时靠它认出来。老数据可能没有。
   */
  file_key?: string | null;
};

export type CreateAnnotationRequest = {
  target_message_id: string;
  relpath: string;
  anchor_kind: AnnotationAnchorKind;
  anchor: AnnotationAnchor;
  content_sha256: string;
  body: string;
  crop?: AnnotationCrop | null;
};

export type PatchAnnotationRequest = {
  body?: string;
  anchor?: AnnotationAnchor;
  crop?: AnnotationCrop | null;
  status?: "open" | "resolved";
};

export type SendAnnotationsRequest = {
  session_id: string;
  body: string;
  annotation_ids: string[];
};

export type AnnotationFilter = {
  relpath?: string;
  session_id?: string;
  /** The session the deliveries were in — what a Bot↔Bot direct's view asks for. */
  target_session_id?: string;
  message_id?: string;
  target_message_id?: string;
  status?: AnnotationStatus;
};

export type AnchorCheck = { ok: true; anchor: AnnotationAnchor } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min;
const isUnit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && [...value].length <= max;

function checkBox(box: Record<string, unknown>): string | null {
  for (const key of ["x", "y", "w", "h"]) if (!isUnit(box[key])) return `${key} must be within 0–1`;
  const x = box.x as number;
  const y = box.y as number;
  const w = box.w as number;
  const h = box.h as number;
  if (w === 0 && h === 0) return "the region is empty";
  if (x + w > 1 + 1e-9 || y + h > 1 + 1e-9) return "the region runs off the image";
  return null;
}

/**
 * 按 `anchor_kind` 校验 `anchor` 的形状；通过时返回只含已知字段的锚点，多余的字段不入库。
 */
export function validateAnchor(kind: string, anchor: unknown): AnchorCheck {
  if (!isRecord(anchor)) return { ok: false, reason: "anchor must be an object" };
  switch (kind) {
    case "text_range": {
      for (const key of ["start_line", "start_col", "end_line", "end_col"]) {
        if (!isInt(anchor[key], 1)) return { ok: false, reason: `${key} must be a positive integer` };
      }
      const a = anchor as Record<string, number>;
      if (a.end_line! < a.start_line! || (a.end_line === a.start_line && a.end_col! < a.start_col!)) {
        return { ok: false, reason: "the range ends before it starts" };
      }
      if (!isText(anchor.quote, ANNOTATION_QUOTE_MAX)) return { ok: false, reason: `quote must be text up to ${ANNOTATION_QUOTE_MAX} characters` };
      if (!isText(anchor.prefix ?? "", ANNOTATION_AFFIX_MAX)) return { ok: false, reason: `prefix must be text up to ${ANNOTATION_AFFIX_MAX} characters` };
      if (!isText(anchor.suffix ?? "", ANNOTATION_AFFIX_MAX)) return { ok: false, reason: `suffix must be text up to ${ANNOTATION_AFFIX_MAX} characters` };
      if (anchor.view !== undefined && anchor.view !== "rendered") return { ok: false, reason: "view must be \"rendered\" when present" };
      const hasSpan = anchor.span_length !== undefined || anchor.span_hash !== undefined;
      if (hasSpan && (!isInt(anchor.span_length, 0) || typeof anchor.span_hash !== "string" || !/^[0-9a-f]{14}$/.test(anchor.span_hash))) {
        return { ok: false, reason: "span_length and span_hash come together: a length and a 14-digit hex fingerprint" };
      }
      const out: TextRangeAnchor = {
        start_line: a.start_line!,
        start_col: a.start_col!,
        end_line: a.end_line!,
        end_col: a.end_col!,
        quote: anchor.quote as string,
        prefix: (anchor.prefix as string | undefined) ?? "",
        suffix: (anchor.suffix as string | undefined) ?? "",
        ...(anchor.view === "rendered" ? { view: "rendered" as const } : {}),
        ...(hasSpan ? { span_length: anchor.span_length as number, span_hash: anchor.span_hash as string } : {}),
      };
      return { ok: true, anchor: out };
    }
    case "image_region": {
      const box = checkBox(anchor);
      if (box) return { ok: false, reason: box };
      if (!isInt(anchor.natural_width, 1) || !isInt(anchor.natural_height, 1)) {
        return { ok: false, reason: "natural_width and natural_height must be positive integers" };
      }
      const a = anchor as Record<string, number>;
      return { ok: true, anchor: { x: a.x!, y: a.y!, w: a.w!, h: a.h!, natural_width: a.natural_width!, natural_height: a.natural_height! } };
    }
    case "pdf_region": {
      if (!isInt(anchor.page, 1)) return { ok: false, reason: "page must be a positive integer" };
      const box = checkBox(anchor);
      if (box) return { ok: false, reason: box };
      if (anchor.quote !== undefined && !isText(anchor.quote, ANNOTATION_QUOTE_MAX)) {
        return { ok: false, reason: `quote must be text up to ${ANNOTATION_QUOTE_MAX} characters` };
      }
      const a = anchor as Record<string, number>;
      const quote = typeof anchor.quote === "string" && anchor.quote.trim() ? { quote: anchor.quote } : {};
      return { ok: true, anchor: { page: a.page!, x: a.x!, y: a.y!, w: a.w!, h: a.h!, ...quote } };
    }
    case "html_element": {
      if (typeof anchor.selector !== "string" || !anchor.selector.trim() || anchor.selector.length > 2000) {
        return { ok: false, reason: "selector must be a CSS path" };
      }
      if (typeof anchor.tag !== "string" || !/^[a-z][a-z0-9-]*$/i.test(anchor.tag)) return { ok: false, reason: "tag must be an element name" };
      if (!isText(anchor.text, ANNOTATION_HTML_TEXT_MAX)) return { ok: false, reason: `text must be up to ${ANNOTATION_HTML_TEXT_MAX} characters` };
      if (!isText(anchor.outer_html, ANNOTATION_HTML_OUTER_MAX)) return { ok: false, reason: `outer_html must be up to ${ANNOTATION_HTML_OUTER_MAX} characters` };
      if (!isRecord(anchor.rect)) return { ok: false, reason: "rect must be a box" };
      const rect = anchor.rect;
      for (const key of ["x", "y", "w", "h"]) if (!isUnit(rect[key])) return { ok: false, reason: `rect.${key} must be within 0–1` };
      return {
        ok: true,
        anchor: {
          selector: anchor.selector,
          tag: anchor.tag.toLowerCase(),
          text: anchor.text,
          outer_html: anchor.outer_html,
          rect: { x: rect.x as number, y: rect.y as number, w: rect.w as number, h: rect.h as number },
        },
      };
    }
    case "media_time": {
      if (!isInt(anchor.start_ms)) return { ok: false, reason: "start_ms must be a non-negative integer" };
      if (!isInt(anchor.duration_ms, 1)) return { ok: false, reason: "duration_ms must be a positive integer" };
      if (anchor.start_ms > anchor.duration_ms) return { ok: false, reason: "start_ms is past the end" };
      if (anchor.end_ms !== undefined) {
        if (!isInt(anchor.end_ms)) return { ok: false, reason: "end_ms must be a non-negative integer" };
        if (anchor.end_ms <= anchor.start_ms) return { ok: false, reason: "end_ms must come after start_ms" };
        if (anchor.end_ms > anchor.duration_ms) return { ok: false, reason: "end_ms is past the end" };
      }
      return {
        ok: true,
        anchor: {
          start_ms: anchor.start_ms,
          duration_ms: anchor.duration_ms,
          ...(anchor.end_ms === undefined ? {} : { end_ms: anchor.end_ms }),
        },
      };
    }
    default:
      return { ok: false, reason: "unknown anchor_kind" };
  }
}

export function isAnnotationAnchorKind(value: unknown): value is AnnotationAnchorKind {
  return typeof value === "string" && (ANNOTATION_ANCHOR_KINDS as readonly string[]).includes(value);
}

/** 文件当下的样子，由调用方读好：不存在、或者哈希（文本类再带上内容）。 */
export type CurrentContent = { exists: false } | { exists: true; sha256: string; text?: string | null };

/**
 * 现算陈旧状态。文件不存在 → `missing`；哈希一样 → 不陈旧；哈希变了、是 `text_range` 且给了内容
 * → 按「引文 + 前后缀」重新定位：落回原来的行列区间还是不陈旧（改的是文件别处），落到别处是 `moved`，
 * 找不到是 `changed`；其它种类哈希变了就是 `changed`。
 */
export function annotationStale(
  annotation: { anchor_kind: AnnotationAnchorKind; anchor: AnnotationAnchor; content_sha256: string },
  current: CurrentContent,
): AnnotationStale {
  if (!current.exists) return { kind: "missing" };
  if (current.sha256 === annotation.content_sha256) return null;
  if (annotation.anchor_kind === "text_range" && typeof current.text === "string") {
    const anchor = annotation.anchor as TextRangeAnchor;
    const moved = relocateTextRange(anchor, current.text);
    if (!moved) return { kind: "changed" };
    const unmoved =
      moved.start_line === anchor.start_line &&
      moved.start_col === anchor.start_col &&
      moved.end_line === anchor.end_line &&
      moved.end_col === anchor.end_col;
    return unmoved ? null : { kind: "moved", ...moved };
  }
  return { kind: "changed" };
}

type LineCol = { line: number; col: number };

/** 字符偏移 → 1 起的行列。`\r\n` 算一个换行，列按 UTF-16 单元数（Monaco 的列）。 */
function lineColAt(text: string, offset: number): LineCol {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, col: offset - lineStart + 1 };
}

function occurrences(haystack: string, needle: string, cap = 200): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    found.push(at);
    if (found.length > cap) break;
    at = haystack.indexOf(needle, at + 1);
  }
  return found;
}

/** 找长选区时最多看引文开头的这么多处，最多对排在前面的这么多处算整段指纹。 */
const SPAN_HEADS_MAX = 5000;
const SPAN_HASHES_MAX = 50;

/** 1 起的行列 → 字符偏移；落在文本外时为 null。 */
function offsetOf(text: string, line: number, col: number): number | null {
  let offset = 0;
  for (let l = 1; l < line; l += 1) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return null;
    offset = next + 1;
  }
  const end = text.indexOf("\n", offset);
  if (col < 1 || col - 1 > (end < 0 ? text.length : end) - offset) return null;
  return offset + col - 1;
}

/** 升序的偏移 → 各自所在的行号（1 起），一趟数完换行。 */
function linesAt(text: string, offsets: readonly number[]): number[] {
  const lines: number[] = [];
  let line = 1;
  let from = 0;
  for (const at of offsets) {
    for (let i = from; i < at; i += 1) if (text.charCodeAt(i) === 10) line += 1;
    from = at;
    lines.push(line);
  }
  return lines;
}

function affixScore(text: string, at: number, quoteLength: number, prefix: string, suffix: string): number {
  let score = 0;
  if (prefix) {
    const before = text.slice(Math.max(0, at - prefix.length), at);
    let match = 0;
    for (let i = 1; i <= Math.min(before.length, prefix.length); i += 1) {
      if (before[before.length - i] === prefix[prefix.length - i]) match += 1;
      else break;
    }
    score += match;
  }
  if (suffix) {
    const after = text.slice(at + quoteLength, at + quoteLength + suffix.length);
    let match = 0;
    for (let i = 0; i < Math.min(after.length, suffix.length); i += 1) {
      if (after[i] === suffix[i]) match += 1;
      else break;
    }
    score += match;
  }
  return score;
}

/**
 * 在新内容里按引文重新定位：先找「前缀 + 引文 + 后缀」的整段；不止一处或没有整段时，在引文的各个
 * 出现位置里挑前后缀吻合最多的；仍打平就取离原行号最近的。引文为空或找不到时返回 null。
 */
export function relocateTextRange(
  anchor: TextRangeAnchor,
  text: string,
): { start_line: number; start_col: number; end_line: number; end_col: number } | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const quote = anchor.quote.replace(/\r\n/g, "\n");
  if (!quote) return null;
  const prefix = anchor.prefix.replace(/\r\n/g, "\n");
  const suffix = anchor.suffix.replace(/\r\n/g, "\n");
  if (anchor.span_length !== undefined && anchor.span_hash !== undefined) {
    // The quote is only the head of a longer selection: the whole span decides. Every place the
    // head occurs is a candidate, best first — the stored prefix and suffix (the suffix follows the
    // whole span), then the nearest line — and the first one followed by the same span is the
    // range (moved or not). None → it changed. Hashing stops at the first match, usually the first try.
    const length = anchor.span_length;
    const spanAt = (at: number): boolean => at + length <= normalized.length && spanHash(normalized.slice(at, at + length)) === anchor.span_hash;
    // Where it was is where it usually still is: one hash settles an edit elsewhere.
    const stored = offsetOf(normalized, anchor.start_line, anchor.start_col);
    let hitAt: number | null = stored !== null && normalized.startsWith(quote, stored) && spanAt(stored) ? stored : null;
    if (hitAt === null) {
      // Bounded, for files of one short thing repeated: a few thousand places the head occurs, and
      // the best-ranked few of them hashed.
      const heads = occurrences(normalized, quote, SPAN_HEADS_MAX).filter((at) => at + length <= normalized.length);
      const lines = linesAt(normalized, heads);
      const ranked = heads
        .map((at, i) => ({ at, score: affixScore(normalized, at, length, prefix, suffix), distance: Math.abs(lines[i]! - anchor.start_line) }))
        .sort((a, b) => b.score - a.score || a.distance - b.distance || a.at - b.at);
      hitAt = ranked.slice(0, SPAN_HASHES_MAX).find((candidate) => spanAt(candidate.at))?.at ?? null;
    }
    if (hitAt === null) return null;
    const hit = { at: hitAt };
    const from = lineColAt(normalized, hit.at);
    const to = lineColAt(normalized, hit.at + length);
    return { start_line: from.line, start_col: from.col, end_line: to.line, end_col: to.col };
  }
  let candidates = occurrences(normalized, prefix + quote + suffix).map((at) => at + prefix.length);
  if (candidates.length !== 1) {
    const all = occurrences(normalized, quote);
    if (all.length === 0) return null;
    if (all.length === 1) candidates = all;
    else {
      const scored = all.map((at) => ({ at, score: affixScore(normalized, at, quote.length, prefix, suffix) }));
      const best = Math.max(...scored.map((s) => s.score));
      candidates = scored.filter((s) => s.score === best).map((s) => s.at);
    }
  }
  let chosen = candidates[0]!;
  if (candidates.length > 1) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const at of candidates) {
      const distance = Math.abs(lineColAt(normalized, at).line - anchor.start_line);
      if (distance < bestDistance) {
        bestDistance = distance;
        chosen = at;
      }
    }
  }
  const start = lineColAt(normalized, chosen);
  if ([...anchor.quote].length >= ANNOTATION_QUOTE_MAX) {
    // Written before selections carried their span: all that is known is the head and the shape.
    const lines = anchor.end_line - anchor.start_line;
    return {
      start_line: start.line,
      start_col: start.col,
      end_line: start.line + lines,
      end_col: lines === 0 ? start.col + (anchor.end_col - anchor.start_col) : anchor.end_col,
    };
  }
  const end = lineColAt(normalized, chosen + quote.length);
  return { start_line: start.line, start_col: start.col, end_line: end.line, end_col: end.col };
}

/** 从整段文本里取出一个行列区间对应的引文和前后缀，是信使存锚点时用的那一半。 */
export function textRangeFromSelection(
  text: string,
  range: { start_line: number; start_col: number; end_line: number; end_col: number },
): TextRangeAnchor {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const offsetOf = (line: number, col: number): number => {
    let offset = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i += 1) offset += lines[i]!.length + 1;
    const lineText = lines[Math.min(line, lines.length) - 1] ?? "";
    return offset + Math.min(Math.max(col - 1, 0), lineText.length);
  };
  const joined = lines.join("\n");
  const from = offsetOf(range.start_line, range.start_col);
  const to = Math.max(from, offsetOf(range.end_line, range.end_col));
  const quoteFull = joined.slice(from, to);
  const cut = [...quoteFull];
  const quote = cut.slice(0, ANNOTATION_QUOTE_MAX).join("");
  const span = cut.length > ANNOTATION_QUOTE_MAX ? { span_length: quoteFull.length, span_hash: spanHash(quoteFull) } : {};
  const prefix = [...joined.slice(Math.max(0, from - ANNOTATION_AFFIX_MAX * 2), from)].slice(-ANNOTATION_AFFIX_MAX).join("");
  const suffix = [...joined.slice(to, to + ANNOTATION_AFFIX_MAX * 2)].slice(0, ANNOTATION_AFFIX_MAX).join("");
  return { ...range, quote, prefix, suffix, ...span };
}

/**
 * 一段文字的指纹：53 位的 cyrb53，十六进制 14 位。只用来认「这段还是不是原来那段」，不防伪造——
 * 信使和守护进程两边算得一样，不依赖任何加密库。
 */
export function spanHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export type AnnotationLocale = "zh" | "en";

export function formatMediaTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

const pct = (value: number): string => `${Math.round(value * 100)}%`;
const px = (value: number): string => Math.round(value).toLocaleString("en-US");

/** 一条批注在卡片和 Bot 上下文里的位置摘要（不含引文，引文由调用方按需接上）。 */
export function describeAnchor(kind: AnnotationAnchorKind, anchor: AnnotationAnchor, locale: AnnotationLocale = "zh"): string {
  const zh = locale === "zh";
  switch (kind) {
    case "text_range": {
      const a = anchor as TextRangeAnchor;
      const lines = a.start_line === a.end_line ? `${a.start_line}` : `${a.start_line}–${a.end_line}`;
      return zh ? `第 ${lines} 行` : a.start_line === a.end_line ? `line ${lines}` : `lines ${lines}`;
    }
    case "image_region": {
      const a = anchor as ImageRegionAnchor;
      const range = `x ${pct(a.x)}–${pct(a.x + a.w)}，y ${pct(a.y)}–${pct(a.y + a.h)}`;
      const pixels = `${px(a.x * a.natural_width)},${px(a.y * a.natural_height)} → ${px((a.x + a.w) * a.natural_width)},${px((a.y + a.h) * a.natural_height)}`;
      return zh
        ? `${range}（原图 ${a.natural_width}×${a.natural_height}，像素 ${pixels}）`
        : `${range.replace("，", ", ")} (image ${a.natural_width}×${a.natural_height}, pixels ${pixels})`;
    }
    case "pdf_region": {
      const a = anchor as PdfRegionAnchor;
      const range = `x ${pct(a.x)}–${pct(a.x + a.w)}，y ${pct(a.y)}–${pct(a.y + a.h)}`;
      return zh ? `第 ${a.page} 页，${range}` : `page ${a.page}, ${range.replace("，", ", ")}`;
    }
    case "html_element": {
      const a = anchor as HtmlElementAnchor;
      const text = a.text.trim();
      const short = [...text].length > 40 ? `${[...text].slice(0, 40).join("")}…` : text;
      return `<${a.tag}> ${a.selector}${short ? (zh ? `「${short}」` : ` “${short}”`) : ""}`;
    }
    case "media_time": {
      const a = anchor as MediaTimeAnchor;
      return a.end_ms === undefined ? formatMediaTime(a.start_ms) : `${formatMediaTime(a.start_ms)}–${formatMediaTime(a.end_ms)}`;
    }
  }
}

/** 中英文的锚点种类名，卡片和上下文都用。 */
export function anchorKindLabel(kind: AnnotationAnchorKind, locale: AnnotationLocale = "zh"): string {
  const zh: Record<AnnotationAnchorKind, string> = {
    text_range: "文本区间",
    image_region: "图片区域",
    pdf_region: "PDF 区域",
    html_element: "HTML 元素",
    media_time: "时间点",
  };
  const en: Record<AnnotationAnchorKind, string> = {
    text_range: "text range",
    image_region: "image region",
    pdf_region: "PDF region",
    html_element: "HTML element",
    media_time: "time point",
  };
  return (locale === "zh" ? zh : en)[kind];
}

/** 引文截到上下文能放下的长度，标出截断。 */
export function clipQuote(quote: string, max = ANNOTATION_CONTEXT_QUOTE_MAX, locale: AnnotationLocale = "zh"): string {
  const chars = [...quote];
  if (chars.length <= max) return quote;
  return `${chars.slice(0, max).join("")}${locale === "zh" ? "…（已截断）" : "… (truncated)"}`;
}
