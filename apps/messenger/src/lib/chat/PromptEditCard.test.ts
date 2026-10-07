import { expect, test } from "bun:test";
import { flushSync } from "svelte";
import type { Approval } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { buttonByText, click, render } from "../test-render.ts";
import PromptEditCard from "./PromptEditCard.svelte";

const t = copyFor("zh");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const body = ["改内置提示词：系统指令 · 中文", "理由：交付没有附命令输出", "@@ 第 1 处 · 在「说做过的必须真做过：」之后加", "+ 附上你依据的命令输出。"].join("\n");

function approval(status: Approval["status"]): Approval {
  return { id: "a1", turn_id: "t1", message_id: "m1", status, kind_key: "prompt-edit", summary: body, target: "turn.system:zh", created_at: "", resolved_at: null, requires_api_key: false };
}

test("the card shows the change: which prompt, why, and the lines it adds", () => {
  const { host, close } = render(PromptEditCard, { body, t, approval: approval("pending"), api: null, onOpenSettings: () => {} });
  expect(host.querySelector(".prompt-card-head")?.textContent).toBe("改内置提示词：系统指令 · 中文");
  expect(host.querySelector(".prompt-card-reason")?.textContent).toBe("理由：交付没有附命令输出");
  expect(host.querySelector(".prompt-card-lines .is-add")?.textContent).toContain("附上你依据的命令输出。");
  // Nothing to undo before you allow it.
  expect(host.textContent).not.toContain(t.prompts.card.undo);
  close();
});

test("once allowed, the card can take the change back while it is still the latest", async () => {
  const undone: string[] = [];
  const api = {
    promptRevisionForApproval: async () => ({ id: "r1", prompt_id: "turn.system", locale: "zh", undoable: true }),
    undoPromptRevision: async (id: string) => {
      undone.push(id);
      return {};
    },
  };
  let opened = 0;
  const { host, close } = render(PromptEditCard, { body, t, approval: approval("allowed_once"), api: api as never, onOpenSettings: () => (opened += 1) });
  await sleep(10);
  flushSync();
  click(buttonByText(host, t.prompts.card.undo));
  await sleep(10);
  flushSync();
  expect(undone).toEqual(["r1"]);
  expect(host.textContent).toContain(t.prompts.card.undone);
  click(buttonByText(host, t.prompts.card.openSettings));
  expect(opened).toBe(1);
  close();
});

test("the card says how far the change reaches, under its title; an older card without the line shows none", () => {
  const reaching = ["改内置提示词：系统指令 · 中文", "理由：交付没有附命令输出", "影响：所有 Bot 每一步都读", "@@ 第 1 处 · 末尾追加", "+ 附上命令。"].join("\n");
  const withReach = render(PromptEditCard, { body: reaching, t, approval: approval("pending"), api: null, onOpenSettings: () => {} });
  expect(withReach.host.querySelector(".prompt-card-reach")?.textContent).toBe("影响：所有 Bot 每一步都读");
  expect(withReach.host.querySelector(".prompt-card-reason")?.textContent).toBe("理由：交付没有附命令输出");
  withReach.close();
  const older = render(PromptEditCard, { body, t, approval: approval("pending"), api: null, onOpenSettings: () => {} });
  expect(older.host.querySelector(".prompt-card-reach")).toBeNull();
  older.close();
});
