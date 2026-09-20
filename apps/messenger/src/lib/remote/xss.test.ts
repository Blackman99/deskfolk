import { expect, test } from "bun:test";
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

test("production CSP has no script unsafe-inline or eval", () => {
  const csp = productionCsp('<script src="/_app/immutable/entry.js"></script>');
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).toContain("script-src-attr 'none'");
  expect(csp).toContain("frame-src blob:");
  expect(csp).toContain("manifest-src 'self'");
  expect(csp).toContain("connect-src 'self' wss: https:");
});
