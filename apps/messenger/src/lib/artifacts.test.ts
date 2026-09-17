import { expect, test } from "bun:test";
import {
  absWorkspacePath,
  artifactHref,
  artifactKind,
  bodyMentionsPath,
  isInAppPreviewKind,
  linkifyWorkspacePaths,
  looksLikeWorkspaceHref,
  parseArtifactHref,
  stripSvgActiveContent,
} from "./artifacts.ts";

test("artifactKind maps extensions and directories", () => {
  expect(artifactKind("out/mock.png")).toBe("image");
  expect(artifactKind("icon.svg")).toBe("svg");
  expect(artifactKind("clip.mp4")).toBe("video");
  expect(artifactKind("note.md")).toBe("markdown");
  expect(artifactKind("src/app.ts")).toBe("text");
  expect(artifactKind("Main.kt")).toBe("text");
  expect(artifactKind("Dockerfile")).toBe("text");
  expect(artifactKind("Makefile")).toBe("text");
  expect(artifactKind("deck.pptx")).toBe("file");
  expect(artifactKind("src", { isDir: true })).toBe("directory");
  expect(isInAppPreviewKind("image")).toBe(true);
  expect(isInAppPreviewKind("pdf")).toBe(true);
  expect(isInAppPreviewKind("text")).toBe(true);
  expect(isInAppPreviewKind("file")).toBe(false);
  expect(isInAppPreviewKind("directory")).toBe(false);
});

test("looksLikeWorkspaceHref accepts relative files and rejects urls", () => {
  expect(looksLikeWorkspaceHref("out/mock.png")).toBe(true);
  expect(looksLikeWorkspaceHref("report.md")).toBe(true);
  expect(looksLikeWorkspaceHref("https://example.com/spec")).toBe(false);
  expect(looksLikeWorkspaceHref("/etc/passwd")).toBe(false);
  expect(looksLikeWorkspaceHref("#heading")).toBe(false);
});

test("artifact href round-trips a relative path", () => {
  const href = artifactHref("out/mock.png");
  expect(href.startsWith("artifact:")).toBe(true);
  expect(parseArtifactHref(href)).toBe("out/mock.png");
});

test("artifact href round-trips CJK paths and undoes marked double-encoding", () => {
  const path = "inbox/制片交接-转审片-v5.md";
  expect(parseArtifactHref(artifactHref(path))).toBe(path);
  expect(parseArtifactHref(artifactHref(encodeURI(path)))).toBe(path);
  const doubleEncoded = `artifact:${encodeURIComponent(encodeURI(path))}`;
  expect(parseArtifactHref(doubleEncoded)).toBe(path);
});

test("absWorkspacePath joins inside the root and rejects escapes", () => {
  expect(absWorkspacePath("/Users/me/ws", "out/mock.png")).toBe("/Users/me/ws/out/mock.png");
  expect(absWorkspacePath("/Users/me/ws", "../secret.txt")).toBeNull();
  expect(absWorkspacePath("/Users/me/ws", "a/../../secret.txt")).toBeNull();
  expect(absWorkspacePath("/Users/me/ws", "/etc/passwd")).toBeNull();
});

test("linkifyWorkspacePaths and bodyMentionsPath", () => {
  expect(linkifyWorkspacePaths("写了 report.md", ["report.md"])).toBe("写了 [report.md](report.md)");
  expect(bodyMentionsPath("写了 [report.md](report.md)", "report.md")).toBe(true);
  expect(bodyMentionsPath("hello", "report.md")).toBe(false);
});

test("stripSvgActiveContent removes scripts and handlers", () => {
  const svg = `<svg><script>alert(1)</script><g onclick="alert(1)"><text>ok</text></g></svg>`;
  const cleaned = stripSvgActiveContent(svg);
  expect(cleaned).not.toContain("<script>");
  expect(cleaned).not.toContain("onclick");
  expect(cleaned).toContain("ok");
});
