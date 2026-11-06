import { expect, test } from "nsh/test";
import { APP_COMMANDS, allowedExternalUrl, hostName } from "./tauri-bridge";

test("a Tauri command goes to the shell under a name the host channel takes", () => {
  expect(hostName("pick_workspace_folder")).toBe("tauri.pick_workspace_folder");
  expect(hostName("plugin:window|set_theme")).toBe("tauri.plugin:window.set_theme");
});

test("the app answers links, the clipboard and the theme itself, on every target", async () => {
  expect(Object.keys(APP_COMMANDS).sort()).toEqual(["open_external_url", "plugin:window|set_theme", "read_clipboard_text"]);
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
