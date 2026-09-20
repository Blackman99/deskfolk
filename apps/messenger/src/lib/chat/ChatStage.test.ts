import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import { copyFor } from "../copy.ts";
import { aBot, aGroup, aMessage, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { render } from "../test-render.ts";
import ChatStage from "./ChatStage.svelte";

const t = copyFor("zh");

test("left clicking a message does not add is-selected class, right clicking selects it", async () => {
  const bot = aBot({ id: "bot-1", name: "Alpha" });
  const session = aGroup({ id: "sess-1" });
  const userMsg = aMessage({
    id: "msg-user-1",
    session_id: "sess-1",
    kind: "user",
    body: "Hello bot",
  });
  const botMsg = aMessage({
    id: "msg-bot-1",
    session_id: "sess-1",
    kind: "bot",
    author: "bot-1",
    body: "Hello user",
  });

  const runtime = reactive(
    fakeRuntime(
      {
        bots: [bot],
        sessions: [session],
        messages: [userMsg, botMsg],
        turns: [],
      },
      { selectedId: "sess-1" },
    ),
  );

  const { host, close } = render(ChatStage, {
    runtime,
    t,
    selected: session,
    onOpenProfile: () => {},
    onOpenArtifact: () => {},
    onCreateBot: () => {},
  });

  const userSegment = host.querySelector('[data-message-id="msg-user-1"]') as HTMLElement;
  const botSegment = host.querySelector('[data-message-id="msg-bot-1"]') as HTMLElement;
  expect(userSegment).not.toBeNull();
  expect(botSegment).not.toBeNull();

  // Left click on user message does not select
  userSegment.click();
  flushSync();
  expect(userSegment.classList.contains("is-selected")).toBe(false);

  // Left click on bot message does not select
  botSegment.click();
  flushSync();
  expect(botSegment.classList.contains("is-selected")).toBe(false);

  // Right click on bot message should select it and open context menu
  botSegment.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  flushSync();
  expect(botSegment.classList.contains("is-selected")).toBe(true);
  expect(host.querySelector(".msg-context-menu")).not.toBeNull();

  // Wait for context menu event listeners to attach
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Press Escape to close context menu and deselect
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(botSegment.classList.contains("is-selected")).toBe(false);
  expect(host.querySelector(".msg-context-menu")).toBeNull();

  close();
});
