import { expect, test } from "bun:test";
import { openExternalLink } from "./open-link.ts";
import type { TauriInternals } from "./tauri.ts";

test("openExternalLink rejects non-web/non-mailto schemes", async () => {
  expect(await openExternalLink("javascript:alert(1)")).toBe(false);
  expect(await openExternalLink("file:///etc/passwd")).toBe(false);
  expect(await openExternalLink("data:text/html,x")).toBe(false);
  expect(await openExternalLink("")).toBe(false);
});

test("openExternalLink in browser mode opens via window.open", async () => {
  const calls: Array<{ url: string; target: string; features: string }> = [];
  const original = window.open;
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    calls.push({ url: String(url), target: String(target), features: String(features) });
    return null;
  }) as typeof window.open;

  try {
    const ok = await openExternalLink("https://example.com/docs", undefined);
    expect(ok).toBe(true);
    expect(calls).toEqual([
      { url: "https://example.com/docs", target: "_blank", features: "noopener,noreferrer" },
    ]);
  } finally {
    window.open = original;
  }
});

test("openExternalLink in Tauri mode invokes open_external_url", async () => {
  const tauriCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const internals: TauriInternals = {
    invoke: async (cmd, args) => {
      tauriCalls.push({ cmd, args });
      return null;
    },
  };

  const ok = await openExternalLink("https://github.com/real-bot/real-bot", internals);
  expect(ok).toBe(true);
  expect(tauriCalls).toEqual([
    { cmd: "open_external_url", args: { url: "https://github.com/real-bot/real-bot" } },
  ]);
});

test("openExternalLink in Tauri mode falls back to window.open if invoke rejects", async () => {
  const windowCalls: string[] = [];
  const original = window.open;
  window.open = ((url?: string | URL) => {
    windowCalls.push(String(url));
    return null;
  }) as typeof window.open;

  const internals: TauriInternals = {
    invoke: async () => {
      throw new Error("tauri error");
    },
  };

  try {
    const ok = await openExternalLink("https://example.com/fallback", internals);
    expect(ok).toBe(true);
    expect(windowCalls).toEqual(["https://example.com/fallback"]);
  } finally {
    window.open = original;
  }
});
