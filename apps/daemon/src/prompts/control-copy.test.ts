import { describe, expect, test } from "bun:test";
import { continueReceiptBody, controlStatusBody, readOnlyLine, resumeNote, stopReceiptBody } from "./control-copy";

const said = { at: "10:35", body: "你手头的生成停一下" };
const turn = { bot: null, plan: "EP01", where: "视频导演和审片员的私聊", lastStep: "shell ffmpeg -i a.mp4" };
const quiet = { suspended: 0, parked: [], beside: [], stillRunning: [], liftOnNextLine: false as const, global: false };

describe("stopReceiptBody", () => {
  test("says what was stopped, with your words, each turn's last step and what runs now", () => {
    const body = stopReceiptBody("zh", {
      ...quiet,
      scopes: ["视频导演的全部工作"],
      said,
      stopped: [turn],
      suspended: 1,
      beside: [{ bot: "编剧分镜师", plan: "回响纪元", ticket: "任务 03《分镜》" }],
    });
    expect(body.split("\n")).toEqual([
      "已停下视频导演的全部工作（你 10:35 说的「你手头的生成停一下」）。",
      "- 中止 1 段执行：EP01 · 在「视频导演和审片员的私聊」 · 最后一步：shell ffmpeg -i a.mp4",
      "- 挂起 1 个回看，继续时恢复。",
      "- 编剧分镜师 还在做回响纪元的任务 03《分镜》，这次叫停没有覆盖它，照常。",
      "- 此刻在跑：无。",
      "说「继续」就解除。",
    ]);
  });

  test("names the words that lift it: everything's, a next line about the job, in the group or to the Bot, anyone else's 「继续」", () => {
    expect(stopReceiptBody("zh", { ...quiet, scopes: ["所有 Bot 的工作"], said, stopped: [], global: true })).toContain("说「所有 Bot 继续」就解除");
    expect(stopReceiptBody("en", { ...quiet, scopes: ["every Bot's work"], said, stopped: [], global: true })).toContain(`Say "all bots continue"`);
    expect(stopReceiptBody("zh", { ...quiet, scopes: ["x"], said: null, stopped: [], liftOnNextLine: "job" })).toContain("你在这件事上再说话");
    expect(stopReceiptBody("zh", { ...quiet, scopes: ["x"], said: null, stopped: [], liftOnNextLine: "group" }).split("\n").at(-1)).toBe("你在这个群里再说话就解除，Bot 从你这句接着往下。");
    expect(stopReceiptBody("zh", { ...quiet, scopes: ["x"], said: null, stopped: [], liftOnNextLine: "bot" }).split("\n").at(-1)).toBe("你再对它说话就解除，它从你这句接着往下。");
  });

  test("with nothing running says so, and a button's stop quotes no words", () => {
    const body = stopReceiptBody("en", { ...quiet, scopes: ["all of Director's work"], said: null, stopped: [] });
    expect(body.split("\n")[0]).toBe("Stopped: all of Director's work.");
    expect(body).toContain("Nothing was running; nothing new starts.");
  });
});

describe("the other lines", () => {
  test("a go on's receipt lists what was lifted, what starts again and what still holds", () => {
    const body = continueReceiptBody("zh", {
      lifted: [{ scope: "视频导演的全部工作", said }],
      resumed: [turn],
      resumedCheckBacks: 1,
      restored: ["EP01"],
      stillHeld: [{ scope: "所有 Bot 的工作", said: null }],
    });
    expect(body).toContain("已解除叫停：视频导演的全部工作（你 10:35 说的「你手头的生成停一下」）。");
    expect(body).toContain("1 段被停下的工作带着一条说明重新开始");
    expect(body).toContain("仍在叫停中：所有 Bot 的工作。");
  });

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
      "用户已叫停这件工作（用户 10:45 说的「停下你所有的工作」），这一段只能回答：可以读文件、回复用户，改不了任何东西，也叫不动别人。用户要你接着做的话，直说这个叫停还在、要在它的回执上解除，别说你在接着做。",
    );
    expect(readOnlyLine("en", null)).toContain("This turn can only answer");
  });
});
