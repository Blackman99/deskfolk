/**
 * The app headless against the running dev runtime (17990, its own data directory). Not part of
 * `nsh test`'s default run: `bun apps/desktop-nsh/scripts/e2e-live.ts` writes the dev runtime's
 * address and token into `.live-params.json`, runs this file, and removes it again. Pictures of
 * the real window come from the dev shell itself (`--snapshots`), not from here: a screenshot step
 * needs `--target macos`, which drives the window with the system's input.
 */
import { expect, open, test } from "nsh/test";
import params from "./.live-params.json";

test("the dev runtime's conversations list and open", async () => {
  const app = await open("../App.tsx", {
    platform: "macos",
    width: 1100,
    height: 760,
    locale: "zh-CN",
    colorScheme: "light",
    network: "live",
    host: {
      params: { origin: params.origin, token: params.token, windowId: 1, material: "glass" },
      handlers: { "tauri.local_api_endpoint": { origin: params.origin, token: params.token }, "tauri.app_version": "0.0.0" },
    },
  });
  await app.waitFor(`id:session-${params.session}`, { timeout: 10_000 });
  await app.press(`id:session-${params.session}`);
  await app.waitFor(`text:${params.expect}`, { timeout: 10_000 });
  expect(app.texts().join("\n")).toContain("粗体");

  // A line the runner writes elsewhere a moment later, while the conversation stays open, arrives
  // by the event stream alone.
  await app.waitFor(`text:${params.live}`, { timeout: 15_000 });
});
