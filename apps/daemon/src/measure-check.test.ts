/**
 * A `measure` check (ADR 0040 P3): what ffprobe's answer is read as, the verdict against a range,
 * and a real run on a real file where ffmpeg is installed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptanceCheck, CheckMeasure } from "@real-bot/protocol";
import { checkEnv } from "./acceptance-eval";
import { measureVerdict, readProbe, runMeasureCheck } from "./measure-check";
import { resolveFfmpegBins } from "./seams-check";

const FFMPEG = resolveFfmpegBins(checkEnv(process.env));

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function check(measure: CheckMeasure | null, path: string | null): AcceptanceCheck {
  return {
    id: "c1", task_id: "t1", ticket_id: null, item: "时长约 2 分钟", kind: "measure", path, pattern: null, negate: false,
    command: null, cwd: null, expect_exit: null, expect_stdout: null, timeout_sec: null, source: "user", origin: "derived",
    measure, bind_kind: path ? "glob" : null, bind_glob: path ? "*MASTER*" : null, created_at: "", updated_at: "", defined_at: "",
    first_passed_at: null, last_run: null, running: false,
  };
}

describe("reading ffprobe", () => {
  test("running time, the picture as displayed, and the frame rate as a fraction", () => {
    const json = JSON.stringify({
      streams: [{ width: 1440, height: 1080, sample_aspect_ratio: "4:3", avg_frame_rate: "30000/1001", r_frame_rate: "30/1" }],
      format: { duration: "107.000000" },
    });
    expect(readProbe(json)).toEqual({ seconds: 107, width: 1920, height: 1080, fps: 30000 / 1001 });
  });

  test("an unknown rate falls back to the stream's own, a missing duration to the stream's", () => {
    const json = JSON.stringify({ streams: [{ width: 16, height: 16, sample_aspect_ratio: "0:1", avg_frame_rate: "0/0", r_frame_rate: "25/1", duration: "3.0" }], format: {} });
    expect(readProbe(json)).toEqual({ seconds: 3, width: 16, height: 16, fps: 25 });
    expect(readProbe(JSON.stringify({ streams: [] }))).toBeNull();
    expect(readProbe("not json")).toBeNull();
  });

  test("a stream shown turned a quarter is measured as shown: a phone's portrait clip stored 1920×1080", () => {
    const stream = { width: 1920, height: 1080, sample_aspect_ratio: "1:1", avg_frame_rate: "30/1" };
    const probe = (extra: Record<string, unknown>) => readProbe(JSON.stringify({ streams: [{ ...stream, ...extra }], format: { duration: "10" } }));
    expect(probe({ side_data_list: [{ rotation: -90 }] })).toMatchObject({ width: 1080, height: 1920 });
    expect(probe({ tags: { rotate: "270" } })).toMatchObject({ width: 1080, height: 1920 });
    expect(probe({ side_data_list: [{ rotation: 180 }] })).toMatchObject({ width: 1920, height: 1080 });
    expect(probe({ tags: {}, side_data_list: [{}] })).toMatchObject({ width: 1920, height: 1080 });
  });
});

describe("the verdict", () => {
  const probe = { seconds: 107, width: 1920, height: 1080, fps: 29.97 };

  test("a running time outside the range fails and says both numbers", () => {
    const verdict = measureVerdict(probe, { dimension: "duration", min: 108, max: 132 }, "zh");
    expect(verdict).toMatchObject({ outcome: "fail", detail: "107.00 秒，要时长 108–132 秒" });
    expect(measureVerdict(probe, { dimension: "duration", min: 100, max: null }, "en")).toMatchObject({ outcome: "pass", detail: "107.00 s" });
  });

  test("resolution by the short side, a rate within its range, a ratio within 1%, and which side is longer", () => {
    expect(measureVerdict(probe, { dimension: "resolution", min: 1080, max: null }, "zh").outcome).toBe("pass");
    expect(measureVerdict({ ...probe, width: 1280, height: 720 }, { dimension: "resolution", min: 1080, max: null }, "zh").outcome).toBe("fail");
    expect(measureVerdict(probe, { dimension: "fps", min: 27, max: 33 }, "zh").outcome).toBe("pass");
    expect(measureVerdict(probe, { dimension: "aspect", ratio: "16:9" }, "zh").outcome).toBe("pass");
    expect(measureVerdict({ ...probe, width: 854, height: 480 }, { dimension: "aspect", ratio: "16:9" }, "zh").outcome).toBe("pass");
    expect(measureVerdict({ ...probe, width: 1440 }, { dimension: "aspect", ratio: "16:9" }, "zh").outcome).toBe("fail");
    expect(measureVerdict(probe, { dimension: "aspect", ratio: "portrait" }, "en")).toMatchObject({ outcome: "fail", detail: "1920×1080; needs Portrait (taller than wide)" });
    expect(measureVerdict(probe, { dimension: "aspect", ratio: "landscape" }, "en").outcome).toBe("pass");
  });

  test("a number ffprobe did not give is an error, not a failure", () => {
    expect(measureVerdict({ ...probe, fps: null }, { dimension: "fps", min: 27, max: 33 }, "zh").outcome).toBe("error");
  });
});

describe("a run", () => {
  test("nothing bound, nothing to measure, outside the workspace, or no file", async () => {
    const root = mkdtempSync(join(tmpdir(), "measure-"));
    roots.push(root);
    const duration: CheckMeasure = { dimension: "duration", min: 108, max: 132 };
    expect((await runMeasureCheck(root, check(duration, null))).outcome).toBe("blocked");
    expect((await runMeasureCheck(root, check(null, "a.mp4"))).outcome).toBe("error");
    expect((await runMeasureCheck(root, check(duration, "../outside.mp4"))).outcome).toBe("blocked");
    expect(await runMeasureCheck(root, check(duration, "EP01_MASTER.mp4"))).toMatchObject({ outcome: "fail", detail: "文件不在" });
    writeFileSync(join(root, "broken_MASTER.mp4"), "not a video");
    if (FFMPEG) expect((await runMeasureCheck(root, check(duration, "broken_MASTER.mp4"))).outcome).toBe("error");
  });

  test.skipIf(!FFMPEG)("ffprobe measures the real file", async () => {
    const root = mkdtempSync(join(tmpdir(), "measure-"));
    roots.push(root);
    mkdirSync(join(root, "out"));
    const made = spawnSync(FFMPEG!.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=25", "-t", "3", "-c:v", "mpeg4", "-y", join(root, "out", "EP01_MASTER.mp4")]);
    expect(made.status).toBe(0);
    const at = (measure: CheckMeasure) => runMeasureCheck(root, check(measure, "out/EP01_MASTER.mp4"), { locale: "en" });
    expect(await at({ dimension: "duration", min: 2.7, max: 3.3 })).toMatchObject({ outcome: "pass", detail: "3.00 s" });
    expect((await at({ dimension: "duration", min: 108, max: 132 })).outcome).toBe("fail");
    expect(await at({ dimension: "resolution", min: null, max: 36 })).toMatchObject({ outcome: "pass", detail: "64×36, short side 36" });
    expect((await at({ dimension: "aspect", ratio: "16:9" })).outcome).toBe("pass");
    expect((await at({ dimension: "aspect", ratio: "portrait" })).outcome).toBe("fail");
    expect(await at({ dimension: "fps", min: 24, max: 26 })).toMatchObject({ outcome: "pass", detail: "25 fps" });

    // The same picture flagged to be shown turned a quarter is a portrait one.
    const turned = spawnSync(FFMPEG!.ffmpeg, ["-v", "error", "-display_rotation", "90", "-i", join(root, "out", "EP01_MASTER.mp4"), "-c", "copy", "-y", join(root, "out", "EP01_MASTER_turned.mp4")]);
    if (turned.status === 0) {
      const turnedCheck = check({ dimension: "aspect", ratio: "portrait" }, "out/EP01_MASTER_turned.mp4");
      expect(await runMeasureCheck(root, turnedCheck, { locale: "en" })).toMatchObject({ outcome: "pass", detail: "36×64" });
    }
  });
});
