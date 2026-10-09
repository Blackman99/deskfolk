import { afterEach, expect, test } from "bun:test";
import type { CompletionsClient, JudgeRequest } from "../completions";
import type { EndpointTarget } from "./types";
import { Store } from "../store";
import type { OrganizerPurpose } from "./organizer-target";
import { createSeamsJudge, createStandardJudge } from "./seams-judge";
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
    routing: async () => ({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", apiFormat: "openai", workspaceId: null, providerId: "p", providerName: "P", model: "seer", thinkingLevel: null }),
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

/**
 * The organizing model (ADR 0075) takes the judges' calls, and tells each how hard to think; a call
 * that sends frames asks for a model that sees, one that reads words does not.
 */
test("the judges ask for a model by what they send, and a chosen model is told how hard to think", async () => {
  const store = new Store();
  closes.push(() => store.close());
  const writer = store.createBot({ name: "Writer", duties: "write", boundaries: "none" });
  const session = writer.direct_session.id;
  const sent: JudgeRequest[] = [];
  const completions = {
    async judge(request: JudgeRequest) {
      sent.push(request);
      return { content: '{"seams":[]}', toolCalls: [], hadToolCalls: false, failKind: null, usage: null };
    },
  } as unknown as CompletionsClient;
  const asked: OrganizerPurpose[] = [];
  let thinkingLevel: string | null = "high";
  const routing = async (purpose: OrganizerPurpose): Promise<EndpointTarget> => {
    asked.push(purpose);
    return { baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", apiFormat: "openai", workspaceId: null, providerId: "p", providerName: "P", model: "strong", thinkingLevel };
  };
  const deps = { completions, routing, spend: createSpend({ store, publishSpend: () => {} }) };
  const seams = createSeamsJudge(deps);
  const standard = createStandardJudge(deps);

  await seams([{ kind: "image", n: 1, dataUri: "data:image/png;base64,AA==" }], [], "前后连贯", "zh", session);
  await seams([{ kind: "text", n: 1, label: "第一章 → 第二章", before: "……", after: "……" }], [], "前后连贯", "zh", session);
  await seams([{ kind: "digest", text: "第一章：…" }], [], "前后连贯", "zh", session);
  await standard([{ kind: "image", label: "样片", dataUri: "data:image/png;base64,AA==" }, { kind: "text", text: "这次的交付" }], "对照样片", session);
  await standard([{ kind: "text", text: "样片的文字" }, { kind: "text", text: "这次的交付" }], "对照样片", session);
  expect(asked).toEqual(["vision", "organizer", "organizer", "vision", "organizer"]);
  expect(sent.map((request) => request.thinkingLevel)).toEqual(["high", "high", "high", "high", "high"]);

  // The default model, which names no level: nothing about thinking is sent, as before.
  thinkingLevel = null;
  await seams([{ kind: "digest", text: "第一章：…" }], [], "前后连贯", "zh", session);
  await standard([{ kind: "text", text: "样片的文字" }], "对照样片", session);
  expect(sent.slice(5).map((request) => "thinkingLevel" in request)).toEqual([false, false]);
});
