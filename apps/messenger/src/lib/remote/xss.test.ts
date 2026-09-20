import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderMarkdown } from "../markdown.ts";
import { HTML_PREVIEW_SANDBOX, htmlPreviewBlob, stripSvgActiveContent } from "../overlays/artifacts.ts";
import { productionCsp } from "../../../../../deploy/remote/csp.mjs";

test("markdown XSS negatives stay sanitized even when origin is trusted", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"><script>alert(1)</script>[go](javascript:alert(1)) <a href="data:text/html,hi">x</a>');
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("data:text/html");
});

test("HTML preview sandbox never gains allow-same-origin", () => {
  expect(HTML_PREVIEW_SANDBOX).not.toContain("allow-same-origin");
  expect(htmlPreviewBlob("<svg onload=alert(1)></svg>").type).toContain("text/html");
});

test("SVG attachments drop scripts and handlers", () => {
  const cleaned = stripSvgActiveContent(`<svg><script>alert(1)</script><g onclick="alert(1)"><text>ok</text></g></svg>`);
  expect(cleaned).not.toContain("<script>");
  expect(cleaned).not.toContain("onclick");
});

test("SVG sanitizer fails closed on bypass forms", () => {
  const cases = [
    "<svg/onload=alert(1)>",
    "<svg><script src=x>",
    "<svg><a href=javascript:alert(1)>x</a></svg>",
    `<svg><a href=data:text/html,alert(1)>x</a></svg>`,
    `<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>`,
    `<svg><g onload=alert(1) onclick='alert(1)'></g></svg>`,
  ];
  for (const input of cases) {
    const cleaned = stripSvgActiveContent(input).toLowerCase();
    expect(cleaned).not.toContain("onload");
    expect(cleaned).not.toContain("onclick");
    expect(cleaned).not.toContain("<script");
    expect(cleaned).not.toContain("foreignobject");
    expect(cleaned).not.toContain("javascript:");
  }
});

test("chat and markdown SVG thumbs use the same sanitizer as artifact preview", () => {
  const preview = readFileSync(new URL("../overlays/ArtifactPreview.svelte", import.meta.url), "utf8");
  const attachments = readFileSync(new URL("../chat/MessageAttachments.svelte", import.meta.url), "utf8");
  const markdown = readFileSync(new URL("../MarkdownBody.svelte", import.meta.url), "utf8");
  expect(preview).toContain("svgDisplayBlob");
  expect(attachments).toContain("svgDisplayBlob");
  expect(markdown).toContain("svgDisplayBlob");
});

test("production CSP has no script unsafe-inline or eval", () => {
  const csp = productionCsp('<script src="/_app/immutable/entry.js"></script>');
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).toContain("script-src-attr 'none'");
  expect(csp).toContain("frame-src blob:");
  expect(csp).toContain("manifest-src 'self'");
  expect(csp).toContain("connect-src 'self' wss: https:");
});
