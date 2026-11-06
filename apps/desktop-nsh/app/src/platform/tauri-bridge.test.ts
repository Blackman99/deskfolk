import { expect, test } from "nsh/test";
import { APP_COMMANDS, hostName } from "./tauri-bridge";

test("a Tauri command goes to the shell under a name the host channel takes", () => {
  expect(hostName("pick_workspace_folder")).toBe("tauri.pick_workspace_folder");
  expect(hostName("plugin:window|set_theme")).toBe("tauri.plugin:window.set_theme");
});

test("the app answers links, the clipboard and the theme itself, on every target", async () => {
  expect(Object.keys(APP_COMMANDS).sort()).toEqual(["open_external_url", "plugin:window|set_theme", "read_clipboard_text"]);
  let refused = "";
  await APP_COMMANDS.open_external_url!({ url: "file:///etc/passwd" }).catch((e: Error) => (refused = e.message));
  expect(refused).toContain("only http(s) and mailto");
});
