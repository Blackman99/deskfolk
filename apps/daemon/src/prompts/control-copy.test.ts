import { describe, expect, test } from "bun:test";
import { controlStatusBody, readOnlyLine, resumeNote } from "./control-copy";

const turn = { bot: null, plan: "EP01", where: "视频导演和审片员的私聊", lastStep: "shell ffmpeg -i a.mp4" };
describe("the other lines", () => {
  test("the status answer lists each stop, what was ended under it, and offers a stop only when asked for", () => {
    expect(controlStatusBody("zh", { about: "视频导演", holds: [], running: [turn], ended: [], offerStop: true }).split("\n")).toEqual([
      "视频导演：没有被叫停。",
      "此刻在跑：EP01 · 在「视频导演和审片员的私聊」 · 最后一步：shell ffmpeg -i a.mp4",
      "要停下视频导演，点「停下」。",
    ]);
    const held = controlStatusBody("en", { about: "Director", holds: [{ scope: "all of Director's work", said: null, since: "10:35" }], running: [], ended: [turn], offerStop: false });
    expect(held).toContain("Director: stopped (all of Director's work, since 10:35).");
    expect(held).toContain("Found still running under the stop, and ended now: EP01");
  });

  test("the status answer names work on what is said here that a stop here does not reach", () => {
    const reviewing = { bot: "审片员", plan: "EP01", where: "视频导演和审片员的私聊", lastStep: null };
    expect(controlStatusBody("zh", { about: "这里", holds: [], running: [], elsewhere: [reviewing], ended: [], offerStop: false }).split("\n")).toEqual([
      "这里：没有被叫停。",
      "此刻在跑：无。",
      "别处也在做这里的事（在这里叫停停不到）：审片员 · EP01 · 在「视频导演和审片员的私聊」",
    ]);
    expect(controlStatusBody("en", { about: "here", holds: [], running: [], elsewhere: [reviewing], ended: [], offerStop: false }))
      .toContain("Also working on this elsewhere, out of reach of a stop here: 审片员 · EP01 · in 视频导演和审片员的私聊");
    expect(controlStatusBody("zh", { about: "这里", holds: [], running: [], elsewhere: [], ended: [], offerStop: false })).not.toContain("别处");
  });

  test("the note stopped work goes on with states what happened and pushes nothing", () => {
    for (const locale of ["zh", "en"] as const) {
      const note = resumeNote(locale, { said: { at: "11:00", body: "继续" }, plan: "规划「EP01」", written: ["work/EP01/a.mp4"], recent: ["shell ffmpeg"] });
      expect(note).toContain("继续");
      expect(note).toContain("work/EP01/a.mp4");
      for (const push of ["接着干", "接着推进", "接着做", "carry on", "finish"]) expect(note.toLowerCase()).not.toContain(push);
    }
  });

  test("a read-only turn is told whose stop it is under and that it can only answer", () => {
    expect(readOnlyLine("zh", { at: "10:45", body: "停下你所有的工作" })).toBe(
      "用户已叫停这件工作（用户 10:45 说的「停下你所有的工作」），这一段只能回答：可以读文件、回复用户，改不了任何东西，也叫不动别人。用户要你接着做的话，直说它还停着：直接告诉你下一步，你就接着做；别说你在接着做。",
    );
    expect(readOnlyLine("en", null)).toContain("This turn can only answer");
  });
});
