import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("service worker source caches immutable assets only", () => {
  const sw = readFileSync(new URL("../../../static/sw.js", import.meta.url), "utf8");
  expect(sw).toContain("/_app/immutable/");
  expect(sw).toContain('request.mode === "navigate"');
  expect(sw).toContain("if (request.method !== \"GET\") return");
  expect(sw).toContain("if (request.mode === \"navigate\" || !isImmutable(request.url)) return");
  expect(sw).toContain('addEventListener("push"');
  expect(sw).toContain('addEventListener("notificationclick"');
  expect(sw).toContain('postMessage({ type: "inbox" })');
  expect(sw).toContain('openWindow("/")');
  expect(sw).not.toContain("/approvals/");
  expect(sw).not.toContain("allow_once");
  expect(sw).not.toContain("resolveApproval");
  expect(sw).not.toContain("caches.open(\"chat");
});
