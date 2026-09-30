import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_OUTPUT,
  MIN_STREAM_WALL_MS,
  RepeatWatch,
  hopLimits,
  isDeclined,
  repeatsItself,
  replyFailure,
} from "./hop-limits";

describe("hop limits", () => {
  test("a model with nothing measured gets the 32K cap and ten minutes", () => {
    expect(hopLimits(undefined)).toEqual({ maxTokens: DEFAULT_MAX_OUTPUT, wallMs: MIN_STREAM_WALL_MS });
    expect(hopLimits({})).toEqual({ maxTokens: 32_768, wallMs: 10 * 60_000 });
  });

  test("the model's own cap is sent, and its measured speed sizes the time limit", () => {
    // 60,000 tokens at 40 a second is 25 minutes; half again is 37.5.
    expect(hopLimits({ max_output: 60_000, stream_tps_p10: 40 })).toEqual({ maxTokens: 60_000, wallMs: 2_250_000 });
    // A fast model's cap takes under ten minutes, so ten minutes it is.
    expect(hopLimits({ stream_tps_p10: 200 })).toEqual({ maxTokens: 32_768, wallMs: 10 * 60_000 });
  });
});

describe("repetition", () => {
  const LINE = "停工已对齐，本轮不再发消息。";

  test("the same sentence a fifth time is a loop, and not before", () => {
    expect(repeatsItself(LINE.repeat(4))).toBe(false);
    expect(repeatsItself(LINE.repeat(5))).toBe(true);
  });

  test("it trips while streaming, a few characters at a time, and stays tripped", () => {
    const watch = new RepeatWatch();
    const text = `先说明一下现状。\n${LINE.repeat(40)}`;
    let trippedAt = -1;
    for (let i = 0; i < text.length; i += 3) {
      if (watch.feed(text.slice(i, i + 3)) && trippedAt < 0) trippedAt = i;
    }
    expect(trippedAt).toBeGreaterThan(0);
    // Tripped on the fifth copy, long before the end of the stream.
    expect(trippedAt).toBeLessThan(`先说明一下现状。\n`.length + LINE.length * 5);
    expect(watch.feed("接下来换个话题说。")).toBe(true);
  });

  test("copies differing only in punctuation, spacing or case are the same sentence", () => {
    const copies = ["C02B 出片了。", "c02b出片了！", "C02B  出片了……", "**C02B 出片了**。", "- C02B 出片了?"];
    expect(repeatsItself(copies.join("\n").replace(/出片了/g, "出片了，我先下载抽帧"))).toBe(true);
  });

  test("numbers tell sentences apart, so a numbered list is not a loop", () => {
    const shots = Array.from({ length: 30 }, (_, i) => `镜头 ${i + 1} 已提交，等待审片员复检。`).join("\n");
    expect(repeatsItself(shots)).toBe(false);
  });

  test("a verdict list repeating one comment per item is not a loop: each item's name comes between", () => {
    const verdicts = Array.from({ length: 12 }, (_, i) => `Shot ${String(i + 1).padStart(2, "0")}：通过。画面稳定，无需返工。`);
    expect(repeatsItself(verdicts.join("\n"))).toBe(false);
    // The same with each item's name on a line of its own, and a two-sentence comment.
    const labelled = Array.from({ length: 12 }, (_, i) => `镜头 ${i + 1}\n测试已经全部通过。画面稳定，无需返工。`);
    expect(repeatsItself(labelled.join("\n"))).toBe(false);
  });

  test("a loop of two sentences taking turns is a loop", () => {
    expect(repeatsItself("我再检查一遍这个文件。结果和上次完全一样。".repeat(6))).toBe(true);
  });

  test("the share rule counts lines with no item named on them, so a bare checklist of twenty trips it", () => {
    // Twenty identical short lines say nothing a loop would not; a checklist names each item.
    expect(repeatsItself("- [x] 完成\n".repeat(22))).toBe(true);
    expect(repeatsItself(Array.from({ length: 22 }, (_, i) => `- [x] 镜头 ${i + 1} 完成`).join("\n"))).toBe(false);
  });

  test("a short sentence recurring among others is not a loop", () => {
    const lines = Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? "已完成。" : `第 ${i} 镜的画面说明写好了。`));
    expect(repeatsItself(lines.join("\n"))).toBe(false);
  });

  test("a loop of short lines trips on the share of distinct sentences, once there are twenty", () => {
    expect(repeatsItself("好的。".repeat(19))).toBe(false);
    expect(repeatsItself("好的。".repeat(20))).toBe(true);
    expect(repeatsItself("好。\n嗯。\n".repeat(10))).toBe(true);
  });

  test("English sentences split at a full stop followed by a space; decimals do not split", () => {
    expect(repeatsItself("I will call the tool now. ".repeat(5))).toBe(true);
    expect(repeatsItself("The clip runs 3.5 seconds and then cuts to black at 4.2 seconds.")).toBe(false);
  });

  test("code blocks do not count", () => {
    const code = ["看这段：", "```ts", ...Array.from({ length: 20 }, () => "console.log(\"retrying the request now\");"), "```", "就这样。"];
    expect(repeatsItself(code.join("\n"))).toBe(false);
    const tildes = ["~~~", ...Array.from({ length: 20 }, () => "echo 'render the same shot again'"), "~~~"];
    expect(repeatsItself(tildes.join("\n"))).toBe(false);
  });

  test("the prose after a closed code block counts again", () => {
    const text = ["```", "x = 1", "```", ...Array.from({ length: 5 }, () => "这一镜我重新渲染一遍。")];
    expect(repeatsItself(text.join("\n"))).toBe(true);
  });

  test("table rows do not count", () => {
    const rows = ["| 镜头 | 状态 |", "|---|---|", ...Array.from({ length: 20 }, () => "| 同一个镜头名字 | 等待审片员复检中 |")];
    expect(repeatsItself(rows.join("\n"))).toBe(false);
  });

  test("inline code at the start of a line is still prose", () => {
    expect(repeatsItself("`render.sh` 已经重新跑过一遍了。\n".repeat(5))).toBe(true);
  });

  test("the window forgets: copies spread far apart are not a loop", () => {
    const filler = (i: number) => Array.from({ length: 100 }, (_, j) => `第 ${i} 段第 ${j} 句正常叙述的内容。`).join("");
    const text = Array.from({ length: 6 }, (_, i) => `${filler(i)}这一句会隔很远重复出现。`).join("\n");
    // About 1,700 characters between copies: five of them never fit in the 6,000-character window.
    expect(text.length).toBeGreaterThan(5 * 1500);
    expect(repeatsItself(text)).toBe(false);
  });
});

describe("refusals", () => {
  test("canned refusals are recognised", () => {
    for (const body of [
      "I'm sorry, but I can't help with that.",
      "I can't assist with that request.",
      "Sorry, I cannot help you with that",
      "I'm a language model and don't have the capacity to help with that.",
      "I'm not able to help with that, as I'm only a language model.",
      "I'm a text-based AI and can't help with that.",
      "抱歉，我无法协助处理这个请求。",
      "我只是一个语言模型，所以没法在这方面帮到你。",
      "作为一个AI语言模型，我不能回答这个问题。",
      "我的设计用途只是处理和生成文本，所以没法在这方面帮到你。",
    ]) {
      expect({ body, declined: isDeclined(body, false) }).toEqual({ body, declined: true });
    }
  });

  test("a Bot saying what it cannot do, introducing itself, or working is not a refusal", () => {
    for (const body of [
      "抱歉，我无法访问你的邮箱：这台机器上没有配邮件相关的工具。要我先把草稿写进 work/ 下吗？",
      "我是一个 AI 助手，负责写分镜。",
      "I can't reach the render server right now, so I booked a check-back in 10 minutes.",
      "The clip is 107 seconds, not about 2 minutes; I can't approve it yet.",
      "",
    ]) {
      expect({ body, declined: isDeclined(body, false) }).toEqual({ body, declined: false });
    }
  });

  test("a refusal that also calls a tool, or runs long, is not a canned one", () => {
    expect(isDeclined("I can't help with that.", true)).toBe(false);
    expect(isDeclined(`I'm only a language model and can't help with that. ${"More detail. ".repeat(30)}`, false)).toBe(false);
  });
});

describe("replyFailure", () => {
  const reply = (content: string, finishReason: string | null = "stop", toolCalls: unknown[] = []) => ({ content, toolCalls, finishReason });

  test("a plain reply, a long one cut at the cap and a tool hop are replies", () => {
    expect(replyFailure(reply("做完了，文件在 work/EP01/master.mp4。"))).toBeNull();
    expect(replyFailure(reply("第一段正常的长文。", "length"))).toBeNull();
    expect(replyFailure(reply("", "tool_calls", [{ id: "c1" }]))).toBeNull();
  });

  test("a loop, a refusal and an endpoint's own refusal are failures", () => {
    expect(replyFailure(reply("停工已对齐，本轮不再发消息。".repeat(5), "length"))).toBe("repeat");
    expect(replyFailure(reply("I'm sorry, but I can't help with that."))).toBe("declined");
    expect(replyFailure(reply("", "content_filter"))).toBe("declined");
    expect(replyFailure(reply("partial", "SAFETY"))).toBe("declined");
  });
});
