import { expect, test } from "bun:test";
import { fileIconFor } from "./file-icon.ts";

test("fileIconFor maps kinds and common code suffixes", () => {
  expect(fileIconFor("src", { isDir: true })).toEqual({
    shape: "folder",
    tint: "#64748b",
    letter: null,
  });
  expect(fileIconFor("shot.png").shape).toBe("image");
  expect(fileIconFor("icon.svg").shape).toBe("image");
  expect(fileIconFor("clip.mp4").shape).toBe("video");
  expect(fileIconFor("note.md").shape).toBe("markdown");
  expect(fileIconFor("index.html").shape).toBe("html");
  expect(fileIconFor("deck.pdf").shape).toBe("pdf");
  expect(fileIconFor("src/app.ts")).toEqual({ shape: "code", tint: "#3178c6", letter: "TS" });
  expect(fileIconFor("src/app.tsx").letter).toBe("TX");
  expect(fileIconFor("main.py").letter).toBe("PY");
  expect(fileIconFor("lib.rs").letter).toBe("RS");
  expect(fileIconFor("pkg.json").letter).toBe("{}");
  expect(fileIconFor("styles.css").letter).toBe("#");
  expect(fileIconFor("notes.txt")).toEqual({ shape: "code", tint: "#64748b", letter: null });
  expect(fileIconFor("archive.zip").shape).toBe("file");
});
