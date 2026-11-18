import { expect, test } from "bun:test";
import { fileGlyph, fileIconFor } from "./file-icon.ts";

test("fileIconFor maps kinds and common code suffixes", () => {
  expect(fileIconFor("src", { isDir: true })).toEqual({
    glyph: "folder",
    tint: "#5f6d74",
    letter: null,
  });
  expect(fileIconFor("shot.png").glyph).toBe("image");
  expect(fileIconFor("icon.svg").glyph).toBe("image");
  expect(fileIconFor("clip.mp4").glyph).toBe("video");
  expect(fileIconFor("note.md").glyph).toBe("markdown");
  expect(fileIconFor("index.html").glyph).toBe("code");
  expect(fileIconFor("deck.pdf").glyph).toBe("file-text");
  expect(fileIconFor("src/app.ts")).toEqual({ glyph: "code", tint: "#3178c6", letter: "TS" });
  expect(fileIconFor("src/app.tsx").letter).toBe("TX");
  expect(fileIconFor("main.py").letter).toBe("PY");
  expect(fileIconFor("lib.rs").letter).toBe("RS");
  expect(fileIconFor("pkg.json").letter).toBe("{}");
  expect(fileIconFor("styles.css").letter).toBe("#");
  expect(fileIconFor("notes.txt")).toEqual({ glyph: "file-text", tint: "#5f6d74", letter: null });
  expect(fileIconFor("report.docx")).toEqual({ glyph: "file-text", tint: "#2563eb", letter: "W" });
  expect(fileIconFor("archive.zip").glyph).toBe("archive");
});

test("fileGlyph gives the common kinds of file an icon of their own", () => {
  expect(fileGlyph("voice_samples/ja/", { isDir: true })).toBe("folder");
  expect(fileGlyph("voice_samples/ja/少女.wav")).toBe("music");
  expect(fileGlyph("shots/shot_01.mp4")).toBe("video");
  expect(fileGlyph("cover.jpg")).toBe("image");
  expect(fileGlyph("logo.svg")).toBe("image");
  expect(fileGlyph("brief.pdf")).toBe("file-text");
  expect(fileGlyph("brief.docx")).toBe("file-text");
  expect(fileGlyph("budget.xlsx")).toBe("table");
  expect(fileGlyph("scores.csv")).toBe("table");
  expect(fileGlyph("pitch.pptx")).toBe("presentation");
  expect(fileGlyph("README.md")).toBe("markdown");
  expect(fileGlyph("run.log")).toBe("file-text");
  expect(fileGlyph("subs.srt")).toBe("file-text");
  expect(fileGlyph("tts.py")).toBe("code");
  expect(fileGlyph("page.html")).toBe("code");
  expect(fileGlyph("stems.tar.gz")).toBe("archive");
  expect(fileGlyph("model.bin")).toBe("file");
});
