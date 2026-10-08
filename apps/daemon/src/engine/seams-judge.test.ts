import { afterEach, expect, test } from "bun:test";
import type { CompletionsClient, JudgeRequest } from "../completions";
import { Store } from "../store";
import { createSeamsJudge } from "./seams-judge";
import { createSpend } from "./spend";

const closes: Array<() => void> = [];
afterEach(() => {
  while (closes.length) closes.pop()!();
});

/**
 * A continuity check's judge bills the plan's session as `acceptance_check`; only a call that
 * sends frames is a judgement of pictures, and carries the purpose the spend view splits out
 * (ADR 0042). A text seam or the whole-set digest reads words, whatever model answers it.
 */
test("a seams call that sends frames is billed with the vision purpose; a text or digest call is not", async () => {
  const store = new Store();
  closes.push(() => store.close());
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const session = writer.direct_session.id;
  const sent: JudgeRequest[] = [];
  const completions = {
    async judge(request: JudgeRequest) {
      sent.push(request);
      return { content: '{"seams":[]}', toolCalls: [], hadToolCalls: false, failKind: null, usage: { input_tokens: 40, output_tokens: 4 } };
    },
  } as unknown as CompletionsClient;
  const judge = createSeamsJudge({
    completions,
    routing: async () => ({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", apiFormat: "openai", providerId: "p", providerName: "P", model: "seer", thinkingLevel: null }),
    spend: createSpend({ store, publishSpend: () => {} }),
  });

  await judge([{ kind: "image", n: 1, dataUri: "data:image/png;base64,AA==" }], [], "前后连贯", "zh", session);
  await judge([{ kind: "text", n: 1, label: "第一章 → 第二章", before: "……", after: "……" }], [], "前后连贯", "zh", session);
  await judge([{ kind: "digest", text: "第一章：…" }], [], "前后连贯", "zh", session);

  expect(sent).toHaveLength(3);
  expect(store.listSpend({}).map((row) => [row.kind, row.purpose, row.bot_id])).toEqual([
    ["acceptance_check", "vision", null],
    ["acceptance_check", null, null],
    ["acceptance_check", null, null],
  ]);
});
