import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AcceptanceCheck, Locale } from "@real-bot/protocol";
import { checkEnv } from "./acceptance-eval";
import {
  CONTINUITY_BATCH_MAX,
  continuityJudgePrompt,
  parseContinuityJudgeAnswer,
  resolveFfmpegBins,
  resolveNewestMatch,
  runContinuityCheck,
  type ContinuityImage,
  type JudgeContinuity,
} from "./continuity-check";

const ENV = checkEnv(process.env);
const FFMPEG = resolveFfmpegBins(ENV);
if (!FFMPEG) {
  console.error("[continuity-check.test] ffmpeg/ffprobe not found on PATH or /opt/homebrew/bin — skipping the real-video tests");
}

function ffmpeg(args: string[]): void {
  const result = spawnSync(FFMPEG!.ffmpeg, args, { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} exited ${result.status}`);
}

/** A minimal `AcceptanceCheck`; only the fields `continuity-check.ts` reads are ever filled in. */
function baseCheck(over: Partial<AcceptanceCheck> = {}): AcceptanceCheck {
  return {
    id: "chk01",
    task_id: "task01",
    ticket_id: null,
    item: "镜头连贯",
    kind: "continuity",
    path: null,
    pattern: null,
    negate: false,
    command: null,
    cwd: null,
    expect_exit: null,
    expect_stdout: null,
    timeout_sec: null,
    source: "user",
    created_at: "",
    updated_at: "",
    defined_at: "",
    first_passed_at: null,
    last_run: null,
    running: false,
    ...over,
  };
}

type JudgeCall = { images: readonly ContinuityImage[]; rules: readonly string[]; item: string; locale: Locale; sessionId: string | null };

/** A fake judge that records every call and answers from a caller-supplied function of the batch it saw. */
function fakeJudge(answer: (call: JudgeCall) => string): { judge: JudgeContinuity; calls: JudgeCall[] } {
  const calls: JudgeCall[] = [];
  const judge: JudgeContinuity = async (images, rules, item, locale, sessionId) => {
    const call = { images, rules, item, locale, sessionId };
    calls.push(call);
    return answer(call);
  };
  return { judge, calls };
}

/** `{"pairs":[...]}` marking every image in the batch `ok`, unless its 1-based `n` is in `notOk` (then `issues` explains why). */
function allOkExcept(notOk: Record<number, string>): (call: JudgeCall) => string {
  return (call) =>
    JSON.stringify({
      pairs: call.images.map((image) => ({
        n: image.n,
        ok: !(image.n in notOk),
        issues: image.n in notOk ? [notOk[image.n]!] : [],
      })),
    });
}

describe("parseContinuityJudgeAnswer", () => {
  test("plain JSON, fenced JSON, and unparsable text", () => {
    expect(parseContinuityJudgeAnswer('{"pairs":[{"n":1,"ok":true,"issues":[]}]}')).toEqual([{ n: 1, ok: true, issues: [] }]);
    expect(parseContinuityJudgeAnswer('```json\n{"pairs":[{"n":2,"ok":false,"issues":["变了"]}]}\n```')).toEqual([
      { n: 2, ok: false, issues: ["变了"] },
    ]);
    expect(parseContinuityJudgeAnswer("这是我的想法，不是 JSON")).toBeNull();
    expect(parseContinuityJudgeAnswer('{"pairs":[]}')).toBeNull();
    expect(parseContinuityJudgeAnswer('{"nope":true}')).toBeNull();
  });
});

describe("continuityJudgePrompt", () => {
  test("carries the acceptance line, the plan's rules, and the fixed checklist, in the app's locale", () => {
    const zh = continuityJudgePrompt("镜头连贯", ["义肢在左手"], "zh");
    expect(zh).toContain("镜头连贯");
    expect(zh).toContain("义肢在左手");
    expect(zh).toContain("义肢左右");
    expect(zh).toContain("pairs");
    const en = continuityJudgePrompt("shots hold together", [], "en");
    expect(en).toContain("shots hold together");
    expect(en).toContain("no extra rules");
    expect(en).toContain("prosthetic limb");
  });
});

describe("resolveFfmpegBins", () => {
  test("null when it is nowhere on PATH and the fallback dirs are told to be empty", () => {
    expect(resolveFfmpegBins({ PATH: "/definitely/not/a/real/dir" }, [])).toBeNull();
  });

  test("falls back to the given dirs (/opt/homebrew/bin by default) when PATH doesn't have it", () => {
    if (!FFMPEG) return; // nothing to compare against on a machine with no ffmpeg at all
    expect(resolveFfmpegBins({ PATH: "/definitely/not/a/real/dir" })).toEqual(FFMPEG);
  });

  test("finds it via PATH when that's where it lives, fallback dirs turned off", () => {
    if (!FFMPEG) return;
    const dir = FFMPEG.ffmpeg.slice(0, FFMPEG.ffmpeg.lastIndexOf("/"));
    expect(resolveFfmpegBins({ PATH: dir }, [])).toEqual(FFMPEG);
  });
});

describe("runContinuityCheck: missing ffmpeg", () => {
  test("resolveFfmpegBins returning null is what the check's own 'need ffmpeg' outcome reads", () => {
    // runContinuityCheck's very first move is `if (!resolveFfmpegBins(env)) return error("需要 ffmpeg")`
    // — proven directly above; a machine with ffmpeg installed under /opt/homebrew/bin (this one
    // included) can never actually reach that branch through the public API, since that is exactly
    // the fallback the real check is allowed to use.
    expect(resolveFfmpegBins({ PATH: "" }, [])).toBeNull();
  });
});

describe.skipIf(!FFMPEG)("resolveNewestMatch: real files on disk", () => {
  test("literal path, glob match, and the newest of several matches", () => {
    const root = mkdtempSync(join(tmpdir(), "continuity-glob-"));
    try {
      mkdirSync(join(root, "renders"), { recursive: true });
      writeFileSync(join(root, "renders", "ep01_MASTER_V1.mp4"), "v1");
      writeFileSync(join(root, "renders", "ep01_MASTER_V2.mp4"), "v2");
      writeFileSync(join(root, "renders", "unrelated.txt"), "nope");
      const old = new Date(Date.now() - 60_000);
      const newer = new Date();
      utimesSync(join(root, "renders", "ep01_MASTER_V1.mp4"), old, old);
      utimesSync(join(root, "renders", "ep01_MASTER_V2.mp4"), newer, newer);

      expect(resolveNewestMatch(root, "renders/ep01_MASTER_V1.mp4")).toMatchObject({ rel: "renders/ep01_MASTER_V1.mp4" });
      const newest = resolveNewestMatch(root, "renders/*_MASTER_V*.mp4");
      expect(newest).toMatchObject({ rel: "renders/ep01_MASTER_V2.mp4" });
      expect(resolveNewestMatch(root, "renders/*_REEDIT_MASTER.mp4")).toBeNull();
      expect(resolveNewestMatch(root, "../outside.mp4")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!FFMPEG)("runContinuityCheck: real ffmpeg, ordered shot list", () => {
  function shotListFixture() {
    const root = mkdtempSync(join(tmpdir(), "continuity-shots-"));
    const shots = join(root, "shots");
    mkdirSync(shots, { recursive: true });
    ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=160x90:d=1", "-pix_fmt", "yuv420p", join(shots, "a.mp4")]);
    ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=160x90:d=1", "-pix_fmt", "yuv420p", join(shots, "b.mp4")]);
    ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=1", "-pix_fmt", "yuv420p", join(shots, "c.mp4")]);
    return root;
  }

  const command = "printf '%s\\n' shots/a.mp4 shots/b.mp4 shots/c.mp4";

  test("every boundary ok: pass, one call, images and rules reach the judge, pair images land under checks/<id>/", async () => {
    const root = shotListFixture();
    try {
      const { judge, calls } = fakeJudge(allOkExcept({}));
      const check = baseCheck({ id: "chkPass", command, item: "镜头交界连贯" });
      const result = await runContinuityCheck(root, check, { judge, rules: ["义肢在左手"], planDir: "work/ep01", sessionId: "sess1" });
      expect(result.outcome).toBe("pass");
      expect(result.detail).toContain("2");
      expect(result.output).toContain("a→b");
      expect(result.output).toContain("b→c");
      expect(result.output).toContain("work/ep01/checks/chkPass/01_pair.jpg");
      expect(result.output).toContain("work/ep01/checks/chkPass/02_pair.jpg");
      expect(existsSync(join(root, "work/ep01/checks/chkPass/01_pair.jpg"))).toBe(true);
      expect(existsSync(join(root, "work/ep01/checks/chkPass/02_pair.jpg"))).toBe(true);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.images).toHaveLength(2);
      expect(calls[0]!.images[0]!.dataUri).toStartWith("data:image/jpeg;base64,");
      expect(calls[0]!.rules).toEqual(["义肢在左手"]);
      expect(calls[0]!.item).toBe("镜头交界连贯");
      expect(calls[0]!.locale).toBe("zh");
      expect(calls[0]!.sessionId).toBe("sess1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("one boundary flagged: fail, detail names it, output carries the issue text", async () => {
    const root = shotListFixture();
    try {
      const { judge } = fakeJudge(allOkExcept({ 2: "颜色变了" }));
      const check = baseCheck({ id: "chkFail", command });
      const result = await runContinuityCheck(root, check, { judge, rules: [], planDir: "work/ep01", sessionId: null });
      expect(result.outcome).toBe("fail");
      expect(result.detail).toContain("2 个交界里 1 个有问题");
      expect(result.detail).toContain("b→c");
      expect(result.detail).toContain("颜色变了");
      expect(result.output).toContain("颜色变了");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unparsable judge answer is retried once, then the check errors", async () => {
    const root = shotListFixture();
    try {
      const { judge, calls } = fakeJudge(() => "não é JSON");
      const result = await runContinuityCheck(root, baseCheck({ command }), { judge, rules: [], planDir: "work/ep01", sessionId: null });
      expect(result.outcome).toBe("error");
      expect(calls).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("more than CONTINUITY_BATCH_MAX boundaries split into several calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "continuity-manyshots-"));
    try {
      const shots = join(root, "shots");
      mkdirSync(shots, { recursive: true });
      const names: string[] = [];
      const shotCount = CONTINUITY_BATCH_MAX + 2;
      for (let i = 0; i < shotCount; i++) {
        const name = `s${String(i).padStart(2, "0")}.mp4`;
        ffmpeg(["-y", "-f", "lavfi", "-i", `color=c=${i % 2 === 0 ? "red" : "blue"}:s=160x90:d=1`, "-pix_fmt", "yuv420p", join(shots, name)]);
        names.push(`shots/${name}`);
      }
      const list = `printf '%s\\n' ${names.join(" ")}`;
      const { judge, calls } = fakeJudge(allOkExcept({}));
      const result = await runContinuityCheck(root, baseCheck({ command: list }), { judge, rules: [], planDir: "work/many", sessionId: null });
      expect(result.outcome).toBe("pass");
      expect(calls.length).toBeGreaterThan(1);
      const total = calls.reduce((sum, call) => sum + call.images.length, 0);
      expect(total).toBe(shotCount - 1);
      for (const call of calls) expect(call.images.length).toBeLessThanOrEqual(CONTINUITY_BATCH_MAX);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!FFMPEG)("runContinuityCheck: scene-detection fallback on a single video", () => {
  test("no shot list, only path: cuts found by scene detection, noted as possibly incomplete, judged and passed", async () => {
    const root = mkdtempSync(join(tmpdir(), "continuity-scene-"));
    try {
      const clips = ["red", "red", "blue"].map((color, i) => {
        const file = join(root, `c${i}.mp4`);
        ffmpeg(["-y", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:d=1`, "-pix_fmt", "yuv420p", file]);
        return file;
      });
      const list = join(root, "concat.txt");
      writeFileSync(list, clips.map((file) => `file '${file}'`).join("\n"));
      const master = join(root, "master.mp4");
      ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", master]);
      expect(statSync(master).size).toBeGreaterThan(0);

      const { judge, calls } = fakeJudge(allOkExcept({}));
      const result = await runContinuityCheck(root, baseCheck({ path: "master.mp4" }), { judge, rules: [], planDir: "work/scene", sessionId: null });
      expect(result.outcome).toBe("pass");
      expect(result.output).toContain("场景检测");
      expect(result.output).toMatch(/\d+\.\d+s→\d+\.\d+s/);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const cutsFound = calls.reduce((sum, call) => sum + call.images.length, 0);
      // The known limitation this fallback has: two near-identical shots (red, red) rarely trip
      // ffmpeg's scene score, so at most the one real cut (red -> blue) is ever found here.
      expect(cutsFound).toBeGreaterThanOrEqual(1);
      expect(cutsFound).toBeLessThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path is a glob: the newest of several candidate deliverables is the one actually read", async () => {
    const root = mkdtempSync(join(tmpdir(), "continuity-scene-glob-"));
    try {
      const clips = ["red", "blue"].map((color, i) => {
        const file = join(root, `c${i}.mp4`);
        ffmpeg(["-y", "-f", "lavfi", "-i", `color=c=${color}:s=160x90:d=1`, "-pix_fmt", "yuv420p", file]);
        return file;
      });
      mkdirSync(join(root, "renders"), { recursive: true });
      writeFileSync(join(root, "renders", "ep_MASTER_V1.mp4"), "not a real video");
      const list = join(root, "concat.txt");
      writeFileSync(list, clips.map((file) => `file '${file}'`).join("\n"));
      ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", join(root, "renders", "ep_MASTER_V2.mp4")]);
      const old = new Date(Date.now() - 60_000);
      utimesSync(join(root, "renders", "ep_MASTER_V1.mp4"), old, old);

      const { judge } = fakeJudge(allOkExcept({}));
      const result = await runContinuityCheck(root, baseCheck({ path: "renders/*_MASTER_V*.mp4" }), {
        judge,
        rules: [],
        planDir: "work/scene",
        sessionId: null,
      });
      // Had the older, unreadable V1 been picked, ffprobe would fail and this would read "error".
      expect(result.outcome).toBe("pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no video matches the path: fail, not error", async () => {
    const root = mkdtempSync(join(tmpdir(), "continuity-scene-missing-"));
    try {
      const { judge } = fakeJudge(allOkExcept({}));
      const result = await runContinuityCheck(root, baseCheck({ path: "renders/*_MASTER.mp4" }), {
        judge,
        rules: [],
        planDir: "work/scene",
        sessionId: null,
      });
      expect(result.outcome).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
