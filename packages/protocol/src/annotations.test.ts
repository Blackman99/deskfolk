import { describe, expect, test } from "bun:test";
import {
  ANNOTATION_QUOTE_MAX,
  annotationStale,
  clipQuote,
  describeAnchor,
  formatMediaTime,
  relocateTextRange,
  textRangeFromSelection,
  validateAnchor,
  type TextRangeAnchor,
} from "./annotations.ts";

const textRange: TextRangeAnchor = {
  start_line: 3,
  start_col: 1,
  end_line: 3,
  end_col: 12,
  quote: "second line",
  prefix: "first\n",
  suffix: "\nthird",
};

describe("validateAnchor", () => {
  test("text_range keeps only the known fields and needs a forward range", () => {
    const ok = validateAnchor("text_range", { ...textRange, extra: 1 });
    expect(ok).toEqual({ ok: true, anchor: textRange });
    expect(validateAnchor("text_range", { ...textRange, view: "rendered" })).toEqual({ ok: true, anchor: { ...textRange, view: "rendered" } });
    expect(validateAnchor("text_range", { ...textRange, end_line: 2 }).ok).toBe(false);
    expect(validateAnchor("text_range", { ...textRange, end_col: 0 }).ok).toBe(false);
    expect(validateAnchor("text_range", { ...textRange, quote: "x".repeat(2001) }).ok).toBe(false);
    expect(validateAnchor("text_range", { ...textRange, prefix: "x".repeat(61) }).ok).toBe(false);
    expect(validateAnchor("text_range", { ...textRange, view: "source" }).ok).toBe(false);
    expect(validateAnchor("text_range", "nope").ok).toBe(false);
  });

  test("image_region is a box inside the unit square with the natural size", () => {
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.4, natural_width: 2048, natural_height: 1365 };
    expect(validateAnchor("image_region", { ...box, junk: true })).toEqual({ ok: true, anchor: box });
    expect(validateAnchor("image_region", { ...box, x: 0.8 }).ok).toBe(false);
    expect(validateAnchor("image_region", { ...box, w: 0, h: 0 }).ok).toBe(false);
    expect(validateAnchor("image_region", { ...box, natural_width: 0 }).ok).toBe(false);
    expect(validateAnchor("image_region", { ...box, y: -0.1 }).ok).toBe(false);
  });

  test("pdf_region needs a page and keeps a non-empty quote", () => {
    const region = { page: 3, x: 0.1, y: 0.2, w: 0.5, h: 0.15 };
    expect(validateAnchor("pdf_region", { ...region, quote: "" })).toEqual({ ok: true, anchor: region });
    expect(validateAnchor("pdf_region", { ...region, quote: "hello" })).toEqual({ ok: true, anchor: { ...region, quote: "hello" } });
    expect(validateAnchor("pdf_region", { ...region, page: 0 }).ok).toBe(false);
  });

  test("html_element checks the selector, tag, text limits, and rect", () => {
    const element = { selector: ".hero > .cta:nth-of-type(2)", tag: "BUTTON", text: "立即开始", outer_html: "<button>立即开始</button>", rect: { x: 0.1, y: 0.2, w: 0.1, h: 0.05 } };
    expect(validateAnchor("html_element", element)).toEqual({ ok: true, anchor: { ...element, tag: "button" } });
    expect(validateAnchor("html_element", { ...element, text: "x".repeat(301) }).ok).toBe(false);
    expect(validateAnchor("html_element", { ...element, outer_html: "x".repeat(1001) }).ok).toBe(false);
    expect(validateAnchor("html_element", { ...element, tag: "not a tag" }).ok).toBe(false);
    expect(validateAnchor("html_element", { ...element, rect: { x: 2, y: 0, w: 0, h: 0 } }).ok).toBe(false);
  });

  test("media_time keeps a point or a forward span inside the duration", () => {
    expect(validateAnchor("media_time", { start_ms: 83_000, duration_ms: 120_000 })).toEqual({ ok: true, anchor: { start_ms: 83_000, duration_ms: 120_000 } });
    expect(validateAnchor("media_time", { start_ms: 83_000, end_ms: 101_000, duration_ms: 120_000 })).toEqual({ ok: true, anchor: { start_ms: 83_000, duration_ms: 120_000, end_ms: 101_000 } });
    expect(validateAnchor("media_time", { start_ms: 83_000, end_ms: 80_000, duration_ms: 120_000 }).ok).toBe(false);
    expect(validateAnchor("media_time", { start_ms: 130_000, duration_ms: 120_000 }).ok).toBe(false);
    expect(validateAnchor("media_time", { start_ms: 10_000, end_ms: 130_000, duration_ms: 120_000 }).ok).toBe(false);
    expect(validateAnchor("media_time", { start_ms: 1.5, duration_ms: 120_000 }).ok).toBe(false);
  });

  test("an unknown kind is refused", () => {
    expect(validateAnchor("sticker", {}).ok).toBe(false);
  });
});

describe("annotationStale", () => {
  const stored = { anchor_kind: "text_range" as const, anchor: textRange, content_sha256: "abc" };

  test("the same hash is fresh", () => {
    expect(annotationStale(stored, { exists: true, sha256: "abc", text: "anything" })).toBeNull();
  });

  test("moved lines relocate by the quote", () => {
    const text = "intro\n\nfirst\nsecond line\nthird\n";
    expect(annotationStale(stored, { exists: true, sha256: "def", text })).toEqual({
      kind: "moved",
      start_line: 4,
      start_col: 1,
      end_line: 4,
      end_col: 12,
    });
  });

  test("an edit elsewhere that leaves the quote where it was is not stale", () => {
    const anchor = textRangeFromSelection("abc def\nsecond line\n", { start_line: 1, start_col: 1, end_line: 1, end_col: 4 });
    const own = { anchor_kind: "text_range" as const, anchor, content_sha256: "abc" };
    expect(annotationStale(own, { exists: true, sha256: "def", text: "abc def\nsecond line\nappended\n" })).toBeNull();
    // Same line is not enough: a different column did move.
    expect(annotationStale(own, { exists: true, sha256: "def", text: "  abc def\nsecond line\n" })).toEqual({
      kind: "moved",
      start_line: 1,
      start_col: 3,
      end_line: 1,
      end_col: 6,
    });
    expect(annotationStale(stored, { exists: true, sha256: "def", text: "zero\nfirst\nsecond line\nthird, now longer\n" })).toBeNull();
  });

  test("a deleted quote is changed", () => {
    expect(annotationStale(stored, { exists: true, sha256: "def", text: "first\nthird\n" })).toEqual({ kind: "changed" });
  });

  test("a deleted file is missing", () => {
    expect(annotationStale(stored, { exists: false })).toEqual({ kind: "missing" });
  });

  test("other kinds with a changed hash are changed", () => {
    const image = { anchor_kind: "image_region" as const, anchor: { x: 0, y: 0, w: 0.5, h: 0.5, natural_width: 10, natural_height: 10 }, content_sha256: "abc" };
    expect(annotationStale(image, { exists: true, sha256: "def" })).toEqual({ kind: "changed" });
    expect(annotationStale(image, { exists: true, sha256: "abc" })).toBeNull();
  });

  test("a text range without the new content is changed, not guessed", () => {
    expect(annotationStale(stored, { exists: true, sha256: "def" })).toEqual({ kind: "changed" });
  });
});

describe("relocateTextRange", () => {
  test("picks the occurrence whose surroundings match when the quote repeats", () => {
    const anchor: TextRangeAnchor = { start_line: 1, start_col: 1, end_line: 1, end_col: 4, quote: "foo", prefix: "b: ", suffix: " end" };
    const text = "a: foo start\nc: foo middle\nb: foo end\n";
    expect(relocateTextRange(anchor, text)).toEqual({ start_line: 3, start_col: 4, end_line: 3, end_col: 7 });
  });

  test("falls back to the nearest line when nothing else tells them apart", () => {
    const anchor: TextRangeAnchor = { start_line: 9, start_col: 1, end_line: 9, end_col: 4, quote: "foo", prefix: "", suffix: "" };
    const text = "foo\n\n\n\n\n\n\n\nfoo\n\nfoo\n";
    expect(relocateTextRange(anchor, text)?.start_line).toBe(9);
  });

  test("spans lines and counts CRLF as one newline", () => {
    const anchor: TextRangeAnchor = { start_line: 1, start_col: 1, end_line: 2, end_col: 2, quote: "one\nt", prefix: "", suffix: "" };
    expect(relocateTextRange(anchor, "zero\r\none\r\ntwo\r\n")).toEqual({ start_line: 2, start_col: 1, end_line: 3, end_col: 2 });
  });

  test("an empty quote cannot be found", () => {
    expect(relocateTextRange({ ...textRange, quote: "" }, "second line")).toBeNull();
  });
});

describe("textRangeFromSelection", () => {
  test("cuts the quote and the affixes out of the text", () => {
    const text = "first\nsecond line\nthird\n";
    expect(textRangeFromSelection(text, { start_line: 2, start_col: 1, end_line: 2, end_col: 12 })).toEqual({
      start_line: 2,
      start_col: 1,
      end_line: 2,
      end_col: 12,
      quote: "second line",
      prefix: "first\n",
      suffix: "\nthird\n",
    });
  });

  test("clips the affixes to their limits and round-trips through relocation", () => {
    const text = `${"p".repeat(100)}\nQUOTE HERE\n${"s".repeat(100)}`;
    const anchor = textRangeFromSelection(text, { start_line: 2, start_col: 1, end_line: 2, end_col: 11 });
    expect(anchor.quote).toBe("QUOTE HERE");
    expect([...anchor.prefix].length).toBe(60);
    expect([...anchor.suffix].length).toBe(60);
    expect(relocateTextRange(anchor, `intro\n${text}`)).toEqual({ start_line: 3, start_col: 1, end_line: 3, end_col: 11 });
  });
});

describe("describeAnchor", () => {
  test("names each kind's position the way the tickets write it", () => {
    expect(describeAnchor("text_range", textRange)).toBe("第 3 行");
    expect(describeAnchor("text_range", { ...textRange, end_line: 5 }, "en")).toBe("lines 3–5");
    expect(describeAnchor("image_region", { x: 0.12, y: 0.3, w: 0.2, h: 0.15, natural_width: 2048, natural_height: 1365 })).toBe(
      "x 12%–32%，y 30%–45%（原图 2048×1365，像素 246,410 → 655,614）",
    );
    expect(describeAnchor("pdf_region", { page: 3, x: 0.1, y: 0.2, w: 0.5, h: 0.15 })).toBe("第 3 页，x 10%–60%，y 20%–35%");
    expect(describeAnchor("html_element", { selector: ".hero > .cta:nth-of-type(2)", tag: "button", text: "立即开始", outer_html: "", rect: { x: 0, y: 0, w: 0, h: 0 } })).toBe(
      "<button> .hero > .cta:nth-of-type(2)「立即开始」",
    );
    expect(describeAnchor("media_time", { start_ms: 83_000, duration_ms: 120_000 })).toBe("01:23");
    expect(describeAnchor("media_time", { start_ms: 83_000, end_ms: 101_000, duration_ms: 120_000 })).toBe("01:23–01:41");
  });
});

describe("formatMediaTime and clipQuote", () => {
  test("formats minutes and hours", () => {
    expect(formatMediaTime(0)).toBe("00:00");
    expect(formatMediaTime(83_400)).toBe("01:23");
    expect(formatMediaTime(3_723_000)).toBe("1:02:03");
  });

  test("clips a long quote and says so", () => {
    expect(clipQuote("short")).toBe("short");
    const clipped = clipQuote("x".repeat(301));
    expect(clipped.startsWith("x".repeat(300))).toBe(true);
    expect(clipped.endsWith("…（已截断）")).toBe(true);
  });
});

test("a selection longer than the quote is judged by its whole span: edits outside leave it be, edits inside change it", () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
  const text = `head\n${long}\ntail\n`;
  const lines = text.split("\n");
  const range = { start_line: 2, start_col: 1, end_line: 51, end_col: lines[50]!.length + 1 };
  const anchor = textRangeFromSelection(text, range);
  expect([...anchor.quote].length).toBe(ANNOTATION_QUOTE_MAX);
  expect(anchor.span_length).toBeGreaterThan(ANNOTATION_QUOTE_MAX);
  expect(validateAnchor("text_range", anchor)).toMatchObject({ ok: true });
  const annotation = { anchor_kind: "text_range" as const, anchor, content_sha256: "0".repeat(64) };
  const now = (next: string) => annotationStale(annotation, { exists: true, sha256: "1".repeat(64), text: next });
  // Edits after the range, even on the very next line, leave it where it was.
  expect(now(`${text}more\n`)).toBeNull();
  expect(now(text.replace("line 50 ", "line fifty "))).toBeNull();
  // A line inside the unquoted tail rewritten to the same width, or the end cut off: changed.
  expect(now(text.replace("line 45 xxxx", "line 45 yyyy"))).toEqual({ kind: "changed" });
  expect(now(text.split("\n").slice(0, 40).join("\n"))).toEqual({ kind: "changed" });
  // Two lines added above: moved by two lines, the same span.
  expect(now(`a\nb\n${text}`)).toEqual({ kind: "moved", start_line: 4, start_col: 1, end_line: 53, end_col: range.end_col });
  // Tampered fingerprints are refused.
  expect(validateAnchor("text_range", { ...anchor, span_hash: "zz" })).toMatchObject({ ok: false });
  expect(validateAnchor("text_range", { ...anchor, span_length: undefined })).toMatchObject({ ok: false });
});

test("a long selection is found past two hundred earlier copies of its head, and on the right one of two copies", () => {
  const head = "trace ".repeat(400);
  const entries = Array.from({ length: 260 }, (_, i) => `${head}\nentry ${i}\n`).join("");
  const text = `start\n${entries}end\n`;
  const lines = text.split("\n");
  // The 250th entry's head and the line after it.
  const startLine = 2 + 250 * 2;
  const range = { start_line: startLine, start_col: 1, end_line: startLine + 1, end_col: lines[startLine]!.length + 1 };
  const anchor = textRangeFromSelection(text, range);
  expect(anchor.span_length).toBeDefined();
  const annotation = { anchor_kind: "text_range" as const, anchor, content_sha256: "0".repeat(64) };
  expect(annotationStale(annotation, { exists: true, sha256: "1".repeat(64), text: `${text}more\n` })).toBeNull();

  // Two identical long sections: the note on the second stays on the second when lines move.
  const block = Array.from({ length: 40 }, (_, i) => `row ${i} ${"y".repeat(60)}`).join("\n");
  const doc = `# A\n${block}\n# B\n${block}\n# C\nend\n`;
  const docLines = doc.split("\n");
  const second = { start_line: 43, start_col: 1, end_line: 82, end_col: docLines[81]!.length + 1 };
  const onSecond = textRangeFromSelection(doc, second);
  expect(onSecond.span_length).toBeDefined();
  const note = { anchor_kind: "text_range" as const, anchor: onSecond, content_sha256: "0".repeat(64) };
  const pad = Array.from({ length: 50 }, (_, i) => `pad ${i}`).join("\n");
  expect(annotationStale(note, { exists: true, sha256: "1".repeat(64), text: `${pad}\n${doc}` })).toMatchObject({ kind: "moved", start_line: 93 });
  const between = doc.replace("# B\n", `${pad}\n# B\n`);
  expect(annotationStale(note, { exists: true, sha256: "1".repeat(64), text: between })).toMatchObject({ kind: "moved", start_line: 93 });
});

test("a long selection in a file of one short thing repeated is judged quickly", () => {
  const text = `values\n${"0\n".repeat(500_000)}0.5\n0.25\n`;
  const lines = text.split("\n");
  const last = lines.length - 1;
  // The last 1600 lines: the head is two thousand characters of "0\n", found half a million times.
  const range = { start_line: last - 1600, start_col: 1, end_line: last, end_col: lines[last - 1]!.length + 1 };
  const anchor = textRangeFromSelection(text, range);
  expect(anchor.span_length).toBeDefined();
  const annotation = { anchor_kind: "text_range" as const, anchor, content_sha256: "0".repeat(64) };
  const timed = (next: string) => {
    const t0 = performance.now();
    const result = annotationStale(annotation, { exists: true, sha256: "1".repeat(64), text: next });
    return { result, ms: performance.now() - t0 };
  };
  const header = timed(text.replace("values", "numbers"));
  expect(header.result).toBeNull();
  const tail = timed(text.replace("0.25", "0.75"));
  expect(tail.result).toEqual({ kind: "changed" });
  expect(header.ms).toBeLessThan(1000);
  expect(tail.ms).toBeLessThan(1000);
});
