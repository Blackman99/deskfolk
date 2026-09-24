import { expect, test } from "bun:test";
import { FILE_DROP_SESSION_ID, USER_MEMBER } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { aBot, aDirect, aGroup, aTurn, fakeRuntime } from "../test-fixtures.ts";
import { reactive } from "../test-reactive.svelte.ts";
import { render } from "../test-render.ts";
import ChatTabLabel from "./ChatTabLabel.svelte";

const t = copyFor("zh");
const bots = [aBot({ id: "bot-1", name: "导演" }), aBot({ id: "bot-2", name: "分镜", model: "gpt-5" })];

function mount(session: ReturnType<typeof aGroup>, turns = [] as ReturnType<typeof aTurn>[]) {
  const runtime = reactive(fakeRuntime({ bots, sessions: [session], turns }));
  return render(ChatTabLabel, { runtime, t, session, title: "视频组" });
}

test("a group's tab carries its faces, a dot while something runs, and the header's presence line as its tooltip", () => {
  const { host, close } = mount(aGroup(), [aTurn({ session_id: "sess-1", status: "running" })]);
  try {
    const picture = host.querySelector(".wb-tab-icon");
    // Marked for the strip, which shows it only once the pane is narrow.
    expect(picture?.getAttribute("aria-hidden")).toBe("true");
    expect(picture?.querySelector(".row-avatar.size-tab")).not.toBeNull();
    expect(picture?.querySelector(":scope > .avatar-status-dot.is-busy")).not.toBeNull();
    expect(host.querySelector(".chat-tab-name")?.textContent).toBe("视频组");
    const tooltip = host.querySelector(".chat-tab")?.getAttribute("title") ?? "";
    expect(tooltip.split("\n")[0]).toBe("视频组");
    expect(tooltip).toContain(t.top.members);
    expect(tooltip).toContain("导演");
  } finally {
    close();
  }
  const idle = mount(aGroup());
  try {
    expect(idle.host.querySelector(".avatar-status-dot")).toBeNull();
  } finally {
    idle.close();
  }
});

test("a direct tab shows its Bot's own status dot, and its model in the tooltip", () => {
  const session = aDirect({
    participants: [
      { member: USER_MEMBER, joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
      { member: "bot-2", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
    ],
  });
  const { host, close } = mount(session);
  try {
    // One dot, the Bot's: not a second one for the conversation on top of it.
    expect(host.querySelectorAll(".avatar-status-dot")).toHaveLength(1);
    expect(host.querySelector(".row-avatar .avatar-status-dot.is-idle")).not.toBeNull();
    expect(host.querySelector(".chat-tab")?.getAttribute("title")).toBe(`视频组\n${t.chat.online} · gpt-5`);
  } finally {
    close();
  }
});

test("the file conversation's tab is its file mark and hint", () => {
  const session = aDirect({
    id: FILE_DROP_SESSION_ID,
    participants: [{ member: USER_MEMBER, joined_at: "2026-09-19T00:00:00.000Z", left_at: null }],
  });
  const { host, close } = mount(session);
  try {
    expect(host.querySelector(".wb-tab-icon.is-file svg")).not.toBeNull();
    expect(host.querySelector(".row-avatar")).toBeNull();
    expect(host.querySelector(".chat-tab")?.getAttribute("title")).toBe(`视频组\n${t.sidebar.fileDropHint}`);
  } finally {
    close();
  }
});
