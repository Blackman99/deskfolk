import { expect, test } from "nsh/test";
import { APP_COMMANDS, UNTIMED_COMMANDS, allowedExternalUrl, hostName, tauriRejection } from "./tauri-bridge";

test("a Tauri command goes to the shell under a name the host channel takes", () => {
  expect(hostName("pick_workspace_folder")).toBe("tauri.pick_workspace_folder");
  expect(hostName("plugin:window|set_theme")).toBe("tauri.plugin:window.set_theme");
});

test("the app answers links itself, on every target", async () => {
  expect(Object.keys(APP_COMMANDS).sort()).toEqual(["open_external_url"]);
  let refused = "";
  await APP_COMMANDS.open_external_url!({ url: "file:///etc/passwd" }).catch((e: Error) => (refused = e.message));
  expect(refused).toContain("url not allowed");
});

test("the links that may open outside are the Tauri shell's", () => {
  expect(allowedExternalUrl("https://example.com")).toBe(true);
  expect(allowedExternalUrl("mailto:dev@real-bot.local")).toBe(true);
  expect(allowedExternalUrl("x-apple.systempreferences:com.apple.Sharing-Settings.extension")).toBe(true);
  expect(allowedExternalUrl("x-apple.systempreferences:com.apple.preference.security")).toBe(false);
  expect(allowedExternalUrl("file:///etc/passwd")).toBe(false);
  expect(allowedExternalUrl("javascript:alert(1)")).toBe(false);
  expect(allowedExternalUrl(" https://example.com")).toBe(false);
  expect(allowedExternalUrl("https://example.com\nevil")).toBe(false);
  expect(allowedExternalUrl("https://example.com evil")).toBe(false);
});

test("a command rejects with the shell's words, as the Tauri shell's did", () => {
  // `pairing-host.ts` compares the string, `updates.ts` reads it.
  expect(tauriRejection(new Error("desktop_channel_unavailable"))).toBe("desktop_channel_unavailable");
  expect(tauriRejection("not-installed")).toBe("not-installed");
});

test("a dialog, an owner check and pairing wait as long as they take", () => {
  expect([...UNTIMED_COMMANDS].sort()).toEqual(["pick_workspace_folder", "remote_local_setup", "remote_native_confirmation"]);
});
