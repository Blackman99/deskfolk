import { expect, test } from "bun:test";
import { copyFor } from "../copy.ts";
import { anMcpServer, fakeRuntime } from "../test-fixtures.ts";
import { buttonByText, click, fill, render } from "../test-render.ts";
import McpSettings from "./McpSettings.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open() {
  const server = anMcpServer();
  const runtime = fakeRuntime({ mcpServers: [server] });
  const view = render(McpSettings, { runtime, t });
  return { ...view, runtime, server };
}

test("renaming an existing server saves itself a moment later, without a save button", async () => {
  const { host, runtime, close } = open();
  click(host.querySelector(".mcp-server-open"));
  fill(host.querySelector("#mcp-editor-name"), "files");
  expect(runtime.calls.filter((c) => c.name === "patchMcpServer")).toHaveLength(0);
  await sleep(750);
  const saves = runtime.calls.filter((c) => c.name === "patchMcpServer");
  expect(saves).toHaveLength(1);
  expect(saves[0]!.args).toEqual(["mcp-1", { name: "files" }]);
  const footLabels = [...host.querySelectorAll(".mcp-editor-modal .modal-foot button")].map((b) =>
    b.textContent?.trim(),
  );
  expect(footLabels).not.toContain("保存这台");
  expect(footLabels).not.toContain(t.settings.mcpAdd);
  close();
});

test("changing command does not PATCH until confirmed", async () => {
  const { host, runtime, close } = open();
  click(host.querySelector(".mcp-server-open"));
  fill(host.querySelector("#mcp-editor-command"), "bun");
  expect(runtime.calls.filter((c) => c.name === "patchMcpServer")).toHaveLength(0);
  expect(buttonByText(host, t.settings.mcpConfirmEdit)).toBeTruthy();
  close();
});

test("closing the editor before the debounce still sends the name", async () => {
  const { host, runtime, close } = open();
  click(host.querySelector(".mcp-server-open"));
  fill(host.querySelector("#mcp-editor-name"), "只打了一半");
  click(host.querySelector(".mcp-editor-modal .modal-close"));
  await sleep(50);
  const saves = runtime.calls.filter((c) => c.name === "patchMcpServer");
  expect(saves).toHaveLength(1);
  expect((saves[0]!.args[1] as { name: string }).name).toBe("只打了一半");
  close();
});
