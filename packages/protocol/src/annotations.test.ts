import { describe, expect, test } from "bun:test";
import {
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
