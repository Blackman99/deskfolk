/**
 * End-to-end desktop test for external links in conversation output:
 * - external http(s) links show an inline external-open icon;
 * - on desktop, clicking one opens the in-app WebView pane by default (with toolbar + open in browser);
 * - switching Settings › Behavior › External links to System browser opens subsequent links via `openUrl`.
 */
import { expect, test } from "nsh/test";
import { openApp, seeded } from "./fixture";

test("conversation external links carry the icon, open in WebView by default, and obey Settings › Behavior", async () => {
  const app = await openApp();

  await app.waitFor(`id:session-${seeded.writerDirect}`, { timeout: 15_000 });
  await app.press(`id:session-${seeded.writerDirect}`);
  await app.waitFor("id:composer-input", { timeout: 10_000 });

  const body = "请看 [示例文档](https://example.com/docs) 以及 https://example.org/guide";
  await app.type("id:composer-input", body);
  await app.keyboard.press("enter");

  // Both the Markdown link and the bare URL render the inline external-open icon.
  await app.waitUntil(() => app.count("id:md-external-link-icon") >= 2, { timeout: 15_000 });
  expect(app.shows("id:web-pane")).toBe(false);

  // Default desktop behavior: pressing the external link opens it inside a WebView workbench pane.
  await app.press("示例文档");
  await app.waitFor("id:web-pane", { timeout: 10_000 });
  expect(app.shows("id:web-pane-toolbar")).toBe(true);
  expect(app.shows("id:web-pane-open-browser")).toBe(true);
  expect(app.value("id:web-pane-address")).toContain("https://example.com/docs");
  expect(app.openedUrls()).toEqual([]);

  // The WebView toolbar's button still lets you pop the page out to the system default browser.
  await app.press("id:web-pane-open-browser");
  await app.waitUntil(() => app.openedUrls().includes("https://example.com/docs"), { timeout: 5_000 });

  // Switch Settings › Behavior › External links to System default browser.
  await app.press("设置");
  await app.waitFor("id:settings-tab-behavior", { timeout: 10_000 });
  await app.press("id:settings-tab-behavior");
  await app.waitFor("id:settings-card-external-link", { timeout: 10_000 });
  await app.press("id:external-link-open-browser");
  await app.press("id:settings-close");
  await app.waitFor("id:settings-card-external-link", { state: "gone", timeout: 10_000 });

  // Pressing the second external link (or its icon) now calls `openUrl` instead of opening another WebView pane.
  await app.press("label:https://example.org/guide");
  await app.waitUntil(() => app.openedUrls().includes("https://example.org/guide"), { timeout: 5_000 });
  expect(app.value("id:web-pane-address")).toContain("https://example.com/docs");

  // Restore the default WebView setting so subsequent runs start clean.
  await app.press("设置");
  await app.waitFor("id:settings-tab-behavior", { timeout: 10_000 });
  await app.press("id:settings-tab-behavior");
  await app.waitFor("id:external-link-open-webview", { timeout: 10_000 });
  await app.press("id:external-link-open-webview");
  await app.press("id:settings-close");
});
