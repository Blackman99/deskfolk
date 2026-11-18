import { expect, test } from "bun:test";
import { HTML_PREVIEW_SANDBOX, htmlPreviewBlob, stripSvgActiveContent } from "../overlays/artifacts.ts";

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
    `<svg><animate attributeName="href" values="javascript:alert(1)" /></svg>`,
    `<svg><set attributeName="href" to="javascript:alert(1)" /></svg>`,
    `<svg><animate attributeName="href" from="javascript:alert(1)" to="https://example.test" /></svg>`,
    `<svg><animate attributeName="href" values="data:text/html,alert(1)" /></svg>`,
    `<svg><set attributeName="href" to="vbscript:alert(1)" /></svg>`,
    `<svg><animate begin="javascript:alert(1)" /></svg>`,
    `<svg><animate end="javascript:alert(1)" /></svg>`,
    `<svg><set begin=javascript:alert(1) /></svg>`,
    `<svg><animate end="data:text/html,alert(1)" /></svg>`,
    `<svg><set begin="vbscript:alert(1)" /></svg>`,
  ];
  for (const input of cases) {
    const cleaned = stripSvgActiveContent(input).toLowerCase();
    expect(cleaned).not.toContain("onload");
    expect(cleaned).not.toContain("onclick");
    expect(cleaned).not.toContain("<script");
    expect(cleaned).not.toContain("foreignobject");
    expect(cleaned).not.toContain("javascript:");
    expect(cleaned).not.toContain("data:");
    expect(cleaned).not.toContain("vbscript:");
  }
});
