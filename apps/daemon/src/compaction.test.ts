import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./completions";
import {
  COMPACT_MIN_BYTES,
  capacityBytes,
  compactNote,
  compactPayload,
  hopsIn,
  nearWindow,
  planCompaction,
  splitLoop,
  writeOutLoop,
} from "./compaction";
import { promptBytes } from "./local-model";

/** One hop of a loop: the Bot's call, then what the tool returned. */
function hop(n: number, result: string, said = ""): ChatMessage[] {
  return [
    { role: "assistant", content: said || null, tool_calls: [{ id: `c${n}`, name: "read_file", arguments: JSON.stringify({ path: `f${n}.md` }) }] },
    { role: "tool", tool_call_id: `c${n}`, content: result },
  ];
}

const big = (n: number) => "x".repeat(n);

describe("splitLoop", () => {
  test("the tail starts at one of the Bot's lines, so every call keeps its result", () => {
    const loop = [...hop(1, big(3000)), ...hop(2, big(3000)), ...hop(3, big(3000))];
    const { old, tail } = splitLoop(loop, 7000);
    expect(tail[0]!.role).toBe("assistant");
    expect(hopsIn(tail)).toBe(2);
    expect(old).toEqual(loop.slice(0, 2));
    // Every result in the tail has its call there too.
    const calls = new Set(tail.flatMap((m) => m.tool_calls ?? []).map((c) => c.id));
    expect(tail.filter((m) => m.role === "tool").every((m) => calls.has(m.tool_call_id!))).toBe(true);
  });

  test("notes and lines read out after the last results stay, even when no hop fits the tail", () => {
    const heard: ChatMessage = { role: "user", content: "（应用提示）你收到一句话：先别删" };
    const loop = [...hop(1, big(5000)), ...hop(2, big(5000)), heard];
    const { old, tail } = splitLoop(loop, 100);
    expect(tail).toEqual([heard]);
    expect(old).toEqual(loop.slice(0, 4));
  });
});

describe("planCompaction", () => {
  const loop = [...hop(1, big(9000)), ...hop(2, big(9000)), ...hop(3, big(2000))];

  test("keeps the newest hops that fit and summarizes the rest", () => {
    // Room for the tail: the lesser of a fifth of what fits (20,000) and half of it less the rest
    // and the summary's room (50,000 - 20,000 - 16,000): the last two hops, about 11,000 bytes.
    const plan = planCompaction(loop, { capacity: 100_000, fixed: 20_000, bytesPerToken: 4 })!;
    expect(hopsIn(plan.old)).toBe(1);
    expect(hopsIn(plan.tail)).toBe(2);
    expect(plan.inputBytes).toBe(60_000);
  });

  test("nothing to gain: the rest alone near what fits, or too little to summarize", () => {
    expect(planCompaction(loop, { capacity: 100_000, fixed: 70_000, bytesPerToken: 4 })).toBeNull();
    const small = [...hop(1, big(1000)), ...hop(2, big(1000))];
    expect(promptBytes(small, [])).toBeLessThan(COMPACT_MIN_BYTES);
    expect(planCompaction(small, { capacity: 100_000, fixed: 10_000, bytesPerToken: 4 })).toBeNull();
  });
});

describe("sizing", () => {
  test("what fits: the window at the bytes per token read, or else the largest request that went through", () => {
    expect(capacityBytes(200_000, 3, 50_000)).toBe(600_000);
    expect(capacityBytes(undefined, 3, 50_000)).toBe(50_000);
    expect(capacityBytes(200_000, undefined, 50_000)).toBe(50_000);
  });

  test("near the window only when both the window and this turn's bytes per token are known", () => {
    expect(nearWindow(300_000, 100_000, 4)).toBe(true);
    expect(nearWindow(280_000, 100_000, 4)).toBe(false);
    expect(nearWindow(300_000, undefined, 4)).toBe(false);
    expect(nearWindow(300_000, 100_000, undefined)).toBe(false);
  });
});

describe("writeOutLoop", () => {
  test("names each line, call and result, oldest first", () => {
    const text = writeOutLoop([...hop(1, '{"ok":true,"content":"# 标题"}', "先读一下"), { role: "user", content: "（应用提示）继续" }], 10_000, "zh");
    expect(text).toBe([
      "【Bot 说】\n先读一下",
      '【调用 read_file】\n{"path":"f1.md"}',
      '【read_file 的结果】\n{"ok":true,"content":"# 标题"}',
      "【应用提示或收到的消息】\n（应用提示）继续",
    ].join("\n\n"));
  });

  test("cuts results shorter tier by tier, then leaves the oldest out, and keeps an earlier summary first", () => {
    const earlier: ChatMessage = { role: "user", content: compactNote("en", "- Read f0.md: three sections.") };
    const old = [earlier, ...Array.from({ length: 20 }, (_, i) => hop(i + 1, big(5000))).flat()];
    expect(writeOutLoop(old, 200_000, "en", earlier)).not.toContain("left out");
    const roomy = writeOutLoop(old, 60_000, "en", earlier);
    expect(roomy).toContain("(3000 characters left out)");
    expect(roomy).not.toContain("earlier entries");
    const tight = writeOutLoop(old, 3_000, "en", earlier);
    expect(Buffer.byteLength(tight)).toBeLessThanOrEqual(3_000 + 1_000);
    expect(tight.startsWith("【Earlier summary】")).toBe(true);
    expect(tight).toContain("- Read f0.md: three sections.");
    expect(tight).toMatch(/\(\d+ earlier entries did not fit and are left out\)/);
    expect(tight).toContain("Result of read_file");
  });
});

test("the summary call reads the line that started the turn, and the note says the originals are gone", () => {
  expect(compactPayload("zh", "  把报告写完  ", "【Bot 说】\n好")).toBe("这一轮的起因（Bot 收到的那句话）：\n把报告写完\n\n要压缩的工作记录（从早到晚）：\n\n【Bot 说】\n好");
  const note = compactNote("zh", "\n- 已读 a.md\n");
  expect(note.startsWith("（应用提示）这一轮前面的工作在上下文里放不下了")).toBe(true);
  expect(note.endsWith("\n\n- 已读 a.md")).toBe(true);
});
