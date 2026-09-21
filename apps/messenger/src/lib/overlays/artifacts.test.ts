import { expect, test } from "bun:test";
import {
  absWorkspacePath,
  artifactByteSource,
  artifactHref,
  artifactKind,
  bodyMentionsPath,
  htmlPreviewBlob,
  HTML_PREVIEW_SANDBOX,
  injectHtmlPreviewColorScheme,
  injectHtmlPreviewNonce,
  isInAppPreviewKind,
  previewLoadKey,
  pageCspNonce,
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
  expect(artifactKind("todo/index.html")).toBe("html");
  expect(artifactKind("src/app.ts")).toBe("text");
  expect(artifactKind("Main.kt")).toBe("text");
  expect(artifactKind("Dockerfile")).toBe("text");
  expect(artifactKind("Makefile")).toBe("text");
  expect(artifactKind("deck.pptx")).toBe("file");
  expect(artifactKind("src", { isDir: true })).toBe("directory");
  expect(isInAppPreviewKind("image")).toBe(true);
  expect(isInAppPreviewKind("pdf")).toBe(true);
  expect(isInAppPreviewKind("html")).toBe(true);
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
  expect(looksLikeWorkspaceHref("v1.2")).toBe(false);
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

test("artifactByteSource loads uncited chat links from the workspace", () => {
  expect(
    artifactByteSource({
      mode: "cited",
      relpath: "inbox/gen/clip.mp4",
      attachment: {
        id: "att-1",
        message_id: "m-1",
        workspace_relpath: "inbox/gen/clip.mp4",
        original_filename: "clip.mp4",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    }),
  ).toBe("attachment");
  expect(
    artifactByteSource({
      mode: "cited",
      relpath: "inbox/gen/clip.mp4",
      attachment: null,
    }),
  ).toBe("workspace");
  expect(
    artifactByteSource({
      mode: "cited",
      relpath: "inbox/gen/clip.mp4",
      attachment: {
        id: "att-1",
        message_id: "m-1",
        workspace_relpath: "inbox/gen/clip.mp4",
        original_filename: "clip.mp4",
        created_at: "2026-01-01T00:00:00.000Z",
        exists: false,
      },
    }),
  ).toBe("workspace");
  expect(
    artifactByteSource({
      mode: "cited",
      relpath: "inbox/gen",
      attachment: {
        id: "att-1",
        message_id: "m-1",
        workspace_relpath: "inbox/gen",
        original_filename: "gen",
        created_at: "2026-01-01T00:00:00.000Z",
        is_dir: true,
      },
    }),
  ).toBeNull();
  expect(artifactByteSource({ mode: "workspace", relpath: "inbox/gen/clip.mp4" })).toBe("workspace");
  expect(artifactByteSource({ mode: "workspace", relpath: "" })).toBeNull();
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

test("html preview sandbox runs scripts in an opaque origin", () => {
  expect(HTML_PREVIEW_SANDBOX.split(/\s+/)).toContain("allow-scripts");
  expect(HTML_PREVIEW_SANDBOX.split(/\s+/)).toContain("allow-modals");
  expect(HTML_PREVIEW_SANDBOX.split(/\s+/)).not.toContain("allow-same-origin");
  expect(htmlPreviewBlob("<h1>ok</h1>").type).toBe("text/html;charset=utf-8");
});

test("injectHtmlPreviewColorScheme stamps the messenger light or dark scheme", () => {
  const withHead = `<html><head><title>x</title></head><body></body></html>`;
  expect(injectHtmlPreviewColorScheme(withHead, "dark")).toContain(
    '<meta name="color-scheme" content="dark">',
  );
  const replaced = injectHtmlPreviewColorScheme(
    `<head><meta name="color-scheme" content="light"></head>`,
    "dark",
  );
  expect(replaced).toContain('content="dark"');
  expect(replaced).not.toContain('content="light"');
});

test("injectHtmlPreviewNonce stamps script and style tags for inherited CSP", () => {
  const html = `<style>.a{color:red}</style><script>1</script><script type="module">2</script><script nonce="keep">3</script>`;
  const out = injectHtmlPreviewNonce(html, "abc");
  expect(out).toContain('<style nonce="abc">');
  expect(out).toContain('<script nonce="abc">');
  expect(out).toContain('<script nonce="abc" type="module">');
  expect(out).toContain('<script nonce="keep">');
  expect(injectHtmlPreviewNonce(html, null)).toBe(html);
  expect(injectHtmlPreviewNonce(html, `ab"c`)).toBe(html);
});

test("pageCspNonce reads the IDL nonce", () => {
  const doc = {
    querySelectorAll() {
      return [{ nonce: "from-idl", getAttribute: () => null }];
    },
  } as unknown as Document;
  expect(pageCspNonce(doc)).toBe("from-idl");
  expect(pageCspNonce(null)).toBeNull();
});

/**
 * The bug: a playing video restarted whenever the citing message left the loaded transcript —
 * switching sessions, or continuing an interrupted turn. The file never changed; only the endpoint
 * that would serve it did.
 */
test("the preview load key ignores whether the citing message is still loaded", () => {
  const whileCited = previewLoadKey({
    path: "runs/clip.mp4",
    kind: "video",
    source: "attachment",
    attachmentId: "att-1",
  });
  const onceOrphaned = previewLoadKey({
    path: "runs/clip.mp4",
    kind: "video",
    source: "workspace",
    attachmentId: null,
  });
  expect(whileCited).toBe(onceOrphaned as string);
  // A second attachment citing the same file is still the same bytes.
  expect(
    previewLoadKey({ path: "runs/clip.mp4", kind: "video", source: "attachment", attachmentId: "att-2" }),
  ).toBe(whileCited as string);
});

test("another file, or another way of rendering it, is another load", () => {
  const clip = previewLoadKey({ path: "runs/clip.mp4", kind: "video", source: "workspace" });
  expect(previewLoadKey({ path: "runs/other.mp4", kind: "video", source: "workspace" })).not.toBe(clip);
  expect(previewLoadKey({ path: "runs/clip.mp4", kind: "text", source: "workspace" })).not.toBe(clip);
});

test("nothing to fetch has no key, and a pathless attachment keys on its id", () => {
  expect(previewLoadKey({ path: "runs/clip.mp4", kind: "video", source: null })).toBeNull();
  expect(previewLoadKey({ path: "  ", kind: "video", source: "attachment", attachmentId: null })).toBeNull();
  expect(previewLoadKey({ path: "", kind: "video", source: "attachment", attachmentId: "att-9" })).toBe(
    "video|att:att-9",
  );
});
