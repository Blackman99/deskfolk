import { describe, expect, test } from "bun:test";
import { isStatusQuestion, type StatusQuestionCandidate } from "./status-question";

function candidate(body: string, overrides: Partial<StatusQuestionCandidate> = {}): StatusQuestionCandidate {
  return {
    kind: "user",
    body,
    parent_id: null,
    attachments: [],
    annotation_source_message_id: null,
    ...overrides,
  };
}

const POSITIVE_ZH = [
  "怎么样了",
  "怎么样了？",
  "如何了",
  "如何了?",
  "咋样了",
  "咋样了?",
  "好了吗",
  "做完了吗",
  "完成了吗",
  "到哪了",
  "到哪一步了",
  "进度呢",
  "进展呢",
  "成片呢",
  "结果呢",
  "还在做吗",
  "在做吗",
  "进度",
  "进展",
  "进度？",
  "进展啊",
  "进行的怎么样了",
  "进行得怎么样了",
  "现在怎么样了",
  "目前怎么样了",
  "这件事怎么样了",
];

const POSITIVE_EN = [
  "how's it going",
  "How's it going?",
  "how is it going",
  "any update",
  "any updates",
  "status",
  "status update",
  "progress",
  "done yet",
  "is it done",
  "Is it done?",
];

const NEGATIVE = [
  // Reads as an instruction, not a question — the whole line has to be one of the closed phrasings,
  // and none of these are.
  "各自继续做到出成片",
  "请继续",
  "重做一下",
  "删除该文件",
  "加快进度",
  "继续做",
  // A name in it is for that Bot, even though the rest reads like a status question.
  "@视频导演 怎么样了",
  // Too long to be a bare status ping.
  "这件事怎么样了，另外能不能把第二段的转场也换一下",
  // Not actually asking anything.
  "好的",
  "",
  "   ",
];

describe("isStatusQuestion", () => {
  for (const body of POSITIVE_ZH) {
    test(`zh matches: ${JSON.stringify(body)}`, () => {
      expect(isStatusQuestion(candidate(body))).toBe(true);
    });
  }
  for (const body of POSITIVE_EN) {
    test(`en matches: ${JSON.stringify(body)}`, () => {
      expect(isStatusQuestion(candidate(body))).toBe(true);
    });
  }
  for (const body of NEGATIVE) {
    test(`does not match: ${JSON.stringify(body)}`, () => {
      expect(isStatusQuestion(candidate(body))).toBe(false);
    });
  }

  test("a Bot's own line never counts, even with a matching body", () => {
    expect(isStatusQuestion(candidate("怎么样了", { kind: "bot" }))).toBe(false);
  });

  test("an attachment means the line is about that file", () => {
    expect(
      isStatusQuestion(
        candidate("怎么样了", {
          attachments: [
            {
              id: "a1",
              message_id: "m1",
              workspace_relpath: "draft.md",
              original_filename: "draft.md",
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  test("an annotation batch is not a status question", () => {
    expect(isStatusQuestion(candidate("怎么样了", { annotation_source_message_id: "m0" }))).toBe(false);
  });

  test("a quote-reply is not a status question", () => {
    expect(isStatusQuestion(candidate("怎么样了", { parent_id: "m0" }))).toBe(false);
  });

  test("trims surrounding whitespace before matching", () => {
    expect(isStatusQuestion(candidate("  怎么样了  "))).toBe(true);
  });
});
