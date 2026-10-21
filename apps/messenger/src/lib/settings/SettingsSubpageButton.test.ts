import { expect, test } from "bun:test";
import { render } from "../test-render.ts";
import SettingsSubpageButton from "./SettingsSubpageButton.svelte";

function names(props: { kind: "back" | "close"; label?: string; title?: string }): { label: string | null; title: string | null } {
  const { host, close } = render(SettingsSubpageButton, { ...props, onclick: () => {} });
  const button = host.querySelector("button");
  const out = { label: button?.getAttribute("aria-label") ?? null, title: button?.getAttribute("title") ?? null };
  close();
  return out;
}

test("Back and ✕ show a tooltip from whichever name the caller gave", () => {
  expect(names({ kind: "back", label: "返回 MCP 扩展" })).toEqual({ label: "返回 MCP 扩展", title: "返回 MCP 扩展" });
  expect(names({ kind: "close", label: "关闭" })).toEqual({ label: "关闭", title: "关闭" });
  expect(names({ kind: "close", title: "关闭" })).toEqual({ label: "关闭", title: "关闭" });
  expect(names({ kind: "back", label: "返回", title: "返回模型服务" })).toEqual({ label: "返回", title: "返回模型服务" });
});
