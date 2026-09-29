import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { AcceptanceCheck, Locale } from "@real-bot/protocol";
import { checkEnv } from "./acceptance-eval";
import {
  SEAM_MEDIA_BATCH_MAX,
  naturalCompare,
  parseSeamsJudgeAnswer,
  resolveFfmpegBins,
  resolveNewestMatch,
  runSeamsCheck,
  seamsJudgePrompt,
  type SeamEvidence,
  type JudgeSeams,
} from "./seams-check";

const ENV = checkEnv(process.env);
const FFMPEG = resolveFfmpegBins(ENV);
if (!FFMPEG) {
  console.error("[seams-check.test] ffmpeg/ffprobe not found on PATH or /opt/homebrew/bin — skipping the real-video/image tests");
}

function ffmpeg(args: string[]): void {
  const result = spawnSync(FFMPEG!.ffmpeg, args, { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} exited ${result.status}`);
}

/** A minimal `AcceptanceCheck`; only the fields `seams-check.ts` reads are ever filled in. */
function baseCheck(over: Partial<AcceptanceCheck> = {}): AcceptanceCheck {
  return {
    id: "chk01",
    task_id: "task01",
    ticket_id: null,
    item: "衔接一致",
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

type JudgeCall = { evidence: readonly SeamEvidence[]; rules: readonly string[]; item: string; locale: Locale; sessionId: string | null };

/** A fake judge that records every call and answers from a caller-supplied function of the call it saw. */
function fakeJudge(answer: (call: JudgeCall) => string): { judge: JudgeSeams; calls: JudgeCall[] } {
  const calls: JudgeCall[] = [];
  const judge: JudgeSeams = async (evidence, rules, item, locale, sessionId) => {
    const call = { evidence, rules, item, locale, sessionId };
    calls.push(call);
    return answer(call);
  };
  return { judge, calls };
}

/**
 * `{"pairs":[...]}` marking every seam `ok` unless its 1-based `n` is in `notOk` (then `issues`
 * explains why); the digest call (evidence[0].kind === "digest") always answers a passing
 * `overall` unless `overallIssues` says otherwise — tests that care about the whole-set pass
 * override that separately.
 */
function allOkExcept(notOk: Record<number, string> = {}, overallIssues: string[] | null = null): (call: JudgeCall) => string {
  return (call) => {
    if (call.evidence[0]?.kind === "digest") {
      return JSON.stringify({ overall: overallIssues ? { ok: false, issues: overallIssues } : { ok: true, issues: [] } });
    }
    const seams = call.evidence as Extract<SeamEvidence, { n: number }>[];
    return JSON.stringify({
      pairs: seams.map((e) => ({ n: e.n, ok: !(e.n in notOk), issues: e.n in notOk ? [notOk[e.n]!] : [] })),
    });
  };
}

describe("parseSeamsJudgeAnswer", () => {
  test("plain JSON, fenced JSON, unparsable text, and an overall-only answer", () => {
    expect(parseSeamsJudgeAnswer('{"pairs":[{"n":1,"ok":true,"issues":[]}]}')).toEqual({ pairs: [{ n: 1, ok: true, issues: [] }], overall: null });
    expect(parseSeamsJudgeAnswer('```json\n{"pairs":[{"n":2,"ok":false,"issues":["变了"]}]}\n```')).toEqual({
      pairs: [{ n: 2, ok: false, issues: ["变了"] }],
      overall: null,
    });
    expect(parseSeamsJudgeAnswer("这是我的想法，不是 JSON")).toBeNull();
    expect(parseSeamsJudgeAnswer('{"pairs":[]}')).toBeNull();
    expect(parseSeamsJudgeAnswer('{"nope":true}')).toBeNull();
    expect(parseSeamsJudgeAnswer('{"overall":{"ok":false,"issues":["名字变了"]}}')).toEqual({ pairs: null, overall: { ok: false, issues: ["名字变了"] } });
  });
});

describe("seamsJudgePrompt", () => {
  test("carries the acceptance line, the plan's rules, and the fixed checklist, in the app's locale", () => {
    const zh = seamsJudgePrompt("衔接一致", ["义肢在左手"], "zh", "image");
    expect(zh).toContain("衔接一致");
    expect(zh).toContain("义肢在左手");
    expect(zh).toContain("pairs");
    expect(zh).toContain("两侧几乎一样是好事");
    const en = seamsJudgePrompt("the parts fit together", [], "en", "image");
    expect(en).toContain("the parts fit together");
    expect(en).toContain("no extra rules");
    expect(en).toContain("Two nearly identical sides are good news");
  });

  test("text mode asks the same checklist but no vision framing, digest mode asks for `overall`", () => {
    const text = seamsJudgePrompt("衔接一致", [], "zh", "text");
    expect(text).toContain("pairs");
    expect(text).not.toContain("两侧几乎一样是好事");
    const digest = seamsJudgePrompt("衔接一致", [], "zh", "digest");
    expect(digest).toContain("overall");
    expect(digest).not.toContain("pairs");
  });
});

describe("naturalCompare", () => {
  test("digit runs compare numerically: c2 before c10", () => {
    expect(naturalCompare("c2.md", "c10.md")).toBeLessThan(0);
    expect(naturalCompare("c10.md", "c2.md")).toBeGreaterThan(0);
    expect(["c10.md", "c1.md", "c2.md"].sort(naturalCompare)).toEqual(["c1.md", "c2.md", "c10.md"]);
  });
});

describe("runSeamsCheck: missing ffmpeg", () => {
  test("resolveFfmpegBins returning null is what a video/image check's own 'need ffmpeg' outcome reads", () => {
    // For video/image evidence, runSeamsCheck's early move is `if (!bins) return error("需要 ffmpeg")`
    // — proven directly here; a machine with ffmpeg installed under /opt/homebrew/bin (this one
    // included) can never actually reach that branch through the public API for a video check,
    // since that is exactly the fallback the real check is allowed to use.
    expect(resolveFfmpegBins({ PATH: "" }, [])).toBeNull();
  });
});

describe.skipIf(!FFMPEG)("resolveNewestMatch: real files on disk", () => {
  test("literal path, glob match, and the newest of several matches", () => {
    const root = mkdtempSync(join(tmpdir(), "seams-glob-"));
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

describe.skipIf(!FFMPEG)("runSeamsCheck: real ffmpeg, ordered video parts from a command", () => {
  function shotListFixture() {
    const root = mkdtempSync(join(tmpdir(), "seams-shots-"));
    const shots = join(root, "shots");
    mkdirSync(shots, { recursive: true });
    ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=160x90:d=1", "-pix_fmt", "yuv420p", join(shots, "a.mp4")]);
    ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=160x90:d=1", "-pix_fmt", "yuv420p", join(shots, "b.mp4")]);
    ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=1", "-pix_fmt", "yuv420p", join(shots, "c.mp4")]);
    return root;
  }

  const command = "printf '%s\\n' shots/a.mp4 shots/b.mp4 shots/c.mp4";

  test("every seam ok: pass, one call, evidence and rules reach the judge, pair images land under checks/<id>/", async () => {
    const root = shotListFixture();
    try {
      const { judge, calls } = fakeJudge(allOkExcept());
      const check = baseCheck({ id: "chkPass", command, item: "衔接一致" });
      const result = await runSeamsCheck(root, check, { judge, rules: ["义肢在左手"], planDir: "work/ep01", sessionId: "sess1" });
      expect(result.outcome).toBe("pass");
      expect(result.detail).toContain("2");
      expect(result.output).toContain("a→b");
      expect(result.output).toContain("b→c");
      expect(result.output).toContain("work/ep01/checks/chkPass/01_pair.jpg");
      expect(result.output).toContain("work/ep01/checks/chkPass/02_pair.jpg");
      expect(existsSync(join(root, "work/ep01/checks/chkPass/01_pair.jpg"))).toBe(true);
      expect(existsSync(join(root, "work/ep01/checks/chkPass/02_pair.jpg"))).toBe(true);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.evidence).toHaveLength(2);
      expect(calls[0]!.evidence[0]).toMatchObject({ kind: "image" });
      expect((calls[0]!.evidence[0] as { dataUri: string }).dataUri).toStartWith("data:image/jpeg;base64,");
      expect(calls[0]!.rules).toEqual(["义肢在左手"]);
      expect(calls[0]!.item).toBe("衔接一致");
      expect(calls[0]!.locale).toBe("zh");
      expect(calls[0]!.sessionId).toBe("sess1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("one seam flagged: fail, detail names it with a colon, output carries the issue text", async () => {
    const root = shotListFixture();
    try {
      const { judge } = fakeJudge(allOkExcept({ 2: "颜色变了" }));
      const check = baseCheck({ id: "chkFail", command });
      const result = await runSeamsCheck(root, check, { judge, rules: [], planDir: "work/ep01", sessionId: null });
      expect(result.outcome).toBe("fail");
      expect(result.detail).toContain("2 处衔接里 1 处有问题");
      expect(result.detail).toContain("b→c：颜色变了");
      expect(result.output).toContain("颜色变了");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("several issues on one seam join without a doubled full stop", async () => {
    const root = shotListFixture();
    try {
      const { judge } = fakeJudge((call) => {
        if (call.evidence[0]?.kind === "digest") return JSON.stringify({ overall: { ok: true, issues: [] } });
        return '{"pairs":[{"n":1,"ok":true,"issues":[]},{"n":2,"ok":false,"issues":["门从侧面跳到正面。","缺少转身过渡。"]}]}';
      });
      const check = baseCheck({ id: "chkJoin", command });
      const result = await runSeamsCheck(root, check, { judge, rules: [], planDir: "work/ep01", sessionId: null });
      expect(result.output).toContain("门从侧面跳到正面；缺少转身过渡");
      expect(result.output).not.toContain("。、");
      expect(result.output).not.toContain("。；");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unparsable judge answer is retried once, then the check errors", async () => {
    const root = shotListFixture();
    try {
      const { judge, calls } = fakeJudge(() => "não é JSON");
      const result = await runSeamsCheck(root, baseCheck({ command }), { judge, rules: [], planDir: "work/ep01", sessionId: null });
      expect(result.outcome).toBe("error");
      expect(calls).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("more than SEAM_MEDIA_BATCH_MAX boundaries split into several calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "seams-manyshots-"));
    try {
      const shots = join(root, "shots");
      mkdirSync(shots, { recursive: true });
      const names: string[] = [];
      const shotCount = SEAM_MEDIA_BATCH_MAX + 2;
      for (let i = 0; i < shotCount; i++) {
        const name = `s${String(i).padStart(2, "0")}.mp4`;
        ffmpeg(["-y", "-f", "lavfi", "-i", `color=c=${i % 2 === 0 ? "red" : "blue"}:s=160x90:d=1`, "-pix_fmt", "yuv420p", join(shots, name)]);
        names.push(`shots/${name}`);
      }
      const list = `printf '%s\\n' ${names.join(" ")}`;
      const { judge, calls } = fakeJudge(allOkExcept());
      const result = await runSeamsCheck(root, baseCheck({ command: list }), { judge, rules: [], planDir: "work/many", sessionId: null });
      expect(result.outcome).toBe("pass");
      expect(calls.length).toBeGreaterThan(1);
      const total = calls.reduce((sum, call) => sum + call.evidence.length, 0);
      expect(total).toBe(shotCount - 1);
      for (const call of calls) expect(call.evidence.length).toBeLessThanOrEqual(SEAM_MEDIA_BATCH_MAX);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!FFMPEG)("runSeamsCheck: scene-detection fallback on a single video", () => {
  test("no parts list, only path: cuts found by scene detection, noted as possibly incomplete, judged and passed", async () => {
    const root = mkdtempSync(join(tmpdir(), "seams-scene-"));
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

      const { judge, calls } = fakeJudge(allOkExcept());
      const result = await runSeamsCheck(root, baseCheck({ path: "master.mp4" }), { judge, rules: [], planDir: "work/scene", sessionId: null });
      expect(result.outcome).toBe("pass");
      expect(result.output).toContain("场景检测");
      expect(result.output).toMatch(/\d+\.\d+s→\d+\.\d+s/);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const cutsFound = calls.reduce((sum, call) => sum + call.evidence.length, 0);
      // The known limitation this fallback has: two near-identical shots (red, red) rarely trip
      // ffmpeg's scene score, so at most the one real cut (red -> blue) is ever found here.
      expect(cutsFound).toBeGreaterThanOrEqual(1);
      expect(cutsFound).toBeLessThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path is a glob of videos with no list command: the newest of several candidates is the one actually read", async () => {
    const root = mkdtempSync(join(tmpdir(), "seams-scene-glob-"));
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

      const { judge } = fakeJudge(allOkExcept());
      const result = await runSeamsCheck(root, baseCheck({ path: "renders/*_MASTER_V*.mp4" }), {
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
    const root = mkdtempSync(join(tmpdir(), "seams-scene-missing-"));
    try {
      const { judge } = fakeJudge(allOkExcept());
      const result = await runSeamsCheck(root, baseCheck({ path: "renders/*_MASTER.mp4" }), {
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

describe.skipIf(!FFMPEG)("runSeamsCheck: image parts", () => {
  function imagesFixture() {
    const root = mkdtempSync(join(tmpdir(), "seams-images-"));
    const dir = join(root, "posters");
    mkdirSync(dir, { recursive: true });
    ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", join(dir, "01-cover.png")]);
    ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", join(dir, "02-inside.png")]);
    ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", join(dir, "03-back.png")]);
    return root;
  }

  test("a glob of images with no list command is the ordered part list, natural-sorted, sent as image pairs", async () => {
    const root = imagesFixture();
    try {
      const { judge, calls } = fakeJudge(allOkExcept({ 2: "配色变了" }));
      const check = baseCheck({ id: "chkPoster", path: "posters/*.png", item: "海报风格一致" });
      const result = await runSeamsCheck(root, check, { judge, rules: [], planDir: "work/poster", sessionId: null });
      expect(result.outcome).toBe("fail");
      expect(result.detail).toContain("02-inside→03-back：配色变了");
      expect(result.output).toContain("01-cover→02-inside");
      expect(result.output).toContain("02-inside→03-back");
      expect(result.output).toContain("配色变了");
      expect(existsSync(join(root, "work/poster/checks/chkPoster/01_pair.jpg"))).toBe(true);
      expect(calls[0]!.evidence.every((e) => e.kind === "image")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runSeamsCheck: text parts", () => {
  // These tests are deliberately not gated on ffmpeg's presence: text evidence never shells out to
  // it, and the digest call never attaches an image part either.
  function textFixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "seams-text-"));
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      writeFileSync(abs, body);
    }
    return root;
  }

  test("two markdown files listed by a command: a changed term is flagged, evidence is text with no image parts", async () => {
    const root = textFixture({
      "chapters/01-intro.md": "# 概述\n\n这份报告分析 Setapp 的市场表现，覆盖 2025 年第三季度。",
      "chapters/02-detail.md": "# 细节\n\nSetApp 在本季度的增长超出预期，具体数字见下表。",
    });
    try {
      const { judge, calls } = fakeJudge(allOkExcept({ 1: "「Setapp」写成了「SetApp」" }));
      const command = "printf '%s\\n' chapters/01-intro.md chapters/02-detail.md";
      const check = baseCheck({ id: "chkReport", command, item: "术语前后一致" });
      const result = await runSeamsCheck(root, check, { judge, rules: [], planDir: "work/report", sessionId: null });
      expect(result.outcome).toBe("fail");
      expect(result.detail).toContain("「Setapp」写成了「SetApp」");
      expect(result.output).toContain("整体：");

      const seamCalls = calls.filter((call) => call.evidence[0]?.kind === "text");
      expect(seamCalls).toHaveLength(1);
      const evidence = seamCalls[0]!.evidence[0] as { kind: "text"; before: string; after: string; label: string };
      expect(evidence.label).toBe("01-intro→02-detail");
      expect(evidence.before).toContain("Setapp");
      expect(evidence.after).toContain("SetApp");
      expect(calls.every((call) => call.evidence.every((e) => e.kind !== "image"))).toBe(true);

      const digestCall = calls.find((call) => call.evidence[0]?.kind === "digest");
      expect(digestCall).toBeDefined();
      const digestText = (digestCall!.evidence[0] as { kind: "digest"; text: string }).text;
      expect(digestText).toContain("概述");
      expect(digestText).toContain("细节");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a glob of markdown files, natural-sorted (c2 before c10), all seams ok", async () => {
    const root = textFixture({
      "chapters/c1.md": "# 第一章\n\n第一章正文，交代主角登场。",
      "chapters/c2.md": "# 第二章\n\n承接第一章，主角出发。",
      "chapters/c10.md": "# 第十章\n\n承接第九章的收尾，故事结束。",
    });
    try {
      const { judge, calls } = fakeJudge(allOkExcept());
      const check = baseCheck({ path: "chapters/*.md" });
      const result = await runSeamsCheck(root, check, { judge, rules: [], planDir: "work/book", sessionId: null });
      expect(result.outcome).toBe("pass");
      // A glob's matches are file-backed parts labelled by filename (not by heading) — natural
      // sort puts c2 before c10 even though c10 sorts first lexicographically.
      expect(result.output).toContain("c1→c2");
      expect(result.output).toContain("c2→c10");
      const seamCall = calls.find((call) => call.evidence[0]?.kind === "text")!;
      expect(seamCall.evidence).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a single markdown file split at ## headings into its sections", async () => {
    const root = textFixture({
      "report.md": ["## 市场分析", "", "本季度市场稳定增长。", "", "## 渠道对比", "", "线上渠道占比继续提升。"].join("\n"),
    });
    try {
      const { judge, calls } = fakeJudge(allOkExcept());
      const check = baseCheck({ path: "report.md" });
      const result = await runSeamsCheck(root, check, { judge, rules: [], planDir: "work/report2", sessionId: null });
      expect(result.outcome).toBe("pass");
      expect(result.output).toContain("市场分析→渠道对比");
      const seamCall = calls.find((call) => call.evidence[0]?.kind === "text")!;
      const evidence = seamCall.evidence[0] as { before: string; after: string };
      expect(evidence.before).toContain("稳定增长");
      expect(evidence.after).toContain("线上渠道");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a single html file split at <h1>/<h2>, tags stripped", async () => {
    const root = textFixture({
      "deck.html": [
        "<html><body>",
        "<h1>产品发布</h1>",
        "<p>这是<b>第一页</b>的内容，介绍背景。</p>",
        "<h2>功能亮点</h2>",
        "<p>这是第二页的内容，列出三项功能。</p>",
        "</body></html>",
      ].join("\n"),
    });
    try {
      const { judge, calls } = fakeJudge(allOkExcept());
      const check = baseCheck({ path: "deck.html" });
      const result = await runSeamsCheck(root, check, { judge, rules: [], planDir: "work/deck", sessionId: null });
      expect(result.outcome).toBe("pass");
      expect(result.output).toContain("产品发布→功能亮点");
      const seamCall = calls.find((call) => call.evidence[0]?.kind === "text")!;
      const evidence = seamCall.evidence[0] as { before: string; after: string };
      expect(evidence.before).toContain("第一页");
      expect(evidence.before).not.toContain("<b>");
      expect(evidence.after).toContain("第二页");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a single file that cannot be split into 2 parts errors with a hint", async () => {
    const root = textFixture({ "notes.txt": "just one paragraph, no headings at all." });
    try {
      const { judge } = fakeJudge(allOkExcept());
      const result = await runSeamsCheck(root, baseCheck({ path: "notes.txt" }), { judge, rules: [], planDir: "work/notes", sessionId: null });
      expect(result.outcome).toBe("error");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a whole-set problem fails the check even when every seam is ok", async () => {
    const root = textFixture({
      "chapters/01.md": "# 上篇\n\n本篇预算为 100 万元。",
      "chapters/02.md": "# 下篇\n\n延续上篇的安排继续展开。",
    });
    try {
      const { judge } = fakeJudge(allOkExcept({}, ["预算数字前后不一致"]));
      const command = "printf '%s\\n' chapters/01.md chapters/02.md";
      const result = await runSeamsCheck(root, baseCheck({ command }), { judge, rules: [], planDir: "work/budget", sessionId: null });
      expect(result.outcome).toBe("fail");
      expect(result.detail).toContain("整体不一致");
      expect(result.detail).toContain("预算数字前后不一致");
      expect(result.output).toContain("整体：预算数字前后不一致");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mixed file types in a listed set error with a hint", async () => {
    const root = textFixture({ "a.md": "# a\n\nbody a", "b.png": "not really a png" });
    try {
      const { judge } = fakeJudge(allOkExcept());
      const command = "printf '%s\\n' a.md b.png";
      const result = await runSeamsCheck(root, baseCheck({ command }), { judge, rules: [], planDir: "work/mixed", sessionId: null });
      expect(result.outcome).toBe("error");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("seamsJudgePrompt: matching visual evidence is a seamless cut", () => {
  test("says so in both languages", () => {
    const zh = seamsJudgePrompt("衔接一致", ["义肢在左手"], "zh", "image");
    expect(zh).toContain("两侧几乎一样是好事");
    const en = seamsJudgePrompt("the parts fit together", [], "en", "image");
    expect(en).toContain("Two nearly identical sides are good news");
  });
});
