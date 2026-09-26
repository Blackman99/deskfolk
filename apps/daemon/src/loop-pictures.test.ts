import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMBER } from "@real-bot/protocol";
import type { ChatContentPart, ChatMessage, CompletionOk } from "./completions";
import {
  LOOP_PICTURE_BYTES_MAX,
  LOOP_PICTURES_MAX,
  attachPictures,
  fitsHop,
  loopPictureSpend,
  pictureMime,
  type LoopPicture,
} from "./loop-pictures";
import { memoryKeyStore } from "./secrets";
import { Store } from "./store";
import { createTurnEngine } from "./turn-engine";
import { runWorkspaceTool } from "./workspace-tools";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(tag: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `real-bot-pictures-${tag}-`)));
  dirs.push(root);
  mkdirSync(join(root, "frames"));
  return root;
}

function picture(path: string, bytes: number): LoopPicture {
  return { path, mime: "image/png", bytes: Buffer.alloc(bytes) };
}

function imageParts(message: ChatMessage | undefined): ChatContentPart[] {
  return Array.isArray(message?.content) ? message.content.filter((part) => part.type === "image_url") : [];
}

function textOf(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function calls(...list: Array<[string, Record<string, unknown>]>): CompletionOk {
  return {
    ok: true,
    content: "",
    toolCalls: list.map(([name, args]) => ({ id: crypto.randomUUID(), name, arguments: JSON.stringify(args) })),
    finishReason: "tool_calls",
    hadChoices: true,
    usage: null,
    missingReason: null,
  };
}

function say(content: string): CompletionOk {
  return { ok: true, content, toolCalls: [], finishReason: "stop", hadChoices: true, usage: null, missingReason: null };
}

/** A reviewer in its direct with the user, whose model follows `script`; every judge call fails open. */
async function reviewer(root: string, script: (messages: ChatMessage[], hop: number) => CompletionOk) {
  const store = new Store({ endpointKey: memoryKeyStore() });
  const seen: ChatMessage[][] = [];
  const waiters: Array<() => void> = [];
  const engine = createTurnEngine({
    store,
    publish(event) {
      if (event.event === "turn.upsert" && event.status === "completed") for (const wake of waiters.splice(0)) wake();
    },
    completions: {
      async complete(request) {
        seen.push(request.messages);
        return script(request.messages, seen.length);
      },
      async judge() {
        throw new Error("no judge in this test");
      },
    },
  });
  await store.patchSettings({
    workspace_path: root,
    endpoint_base_url: "http://127.0.0.1:1/v1",
    endpoint_api_key: "fixture",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
  });
  const bot = store.createBot({ name: "审片员", duties: "review", boundaries: "stay" });
  return {
    store,
    seen,
    bot,
    async run(body: string) {
      const trigger = store.insertMessage({ sessionId: bot.direct_session.id, kind: "user", author: USER_MEMBER, body });
      const done = new Promise<void>((resolve) => waiters.push(resolve));
      await engine.handleInboundMessage(trigger, { fromUser: true });
      await done;
    },
    async close() {
      await engine.close();
      store.close();
    },
  };
}

describe("loop pictures", () => {
  test("only raster pictures are shown; everything else stays text", () => {
    expect(pictureMime("frames/C01_START.PNG")).toBe("image/png");
    expect(pictureMime("a.jpeg")).toBe("image/jpeg");
    expect(pictureMime("a.webp")).toBe("image/webp");
    expect(pictureMime("a.svg")).toBeNull();
    expect(pictureMime("notes.md")).toBeNull();
  });

  test("a hop's line names each picture before its image, and the spend counts it", () => {
    const loop: ChatMessage[] = [{ role: "user", content: "check-in" }];
    attachPictures(loop, [{ path: "frames/a.png", mime: "image/png", bytes: PNG_1X1 }], "zh");
    expect(loop).toHaveLength(2);
    expect(loop[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "read_file 读到的图片，按调用顺序：" },
        { type: "text", text: "frames/a.png" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1.toString("base64")}` } },
      ],
    });
    expect(loopPictureSpend(loop)).toEqual({ images: 1, bytes: PNG_1X1.byteLength });
    attachPictures(loop, [], "zh");
    expect(loop).toHaveLength(2);
  });

  test("one hop holds at most the cap in count and in bytes", () => {
    const small = Array.from({ length: LOOP_PICTURES_MAX }, (_, i) => picture(`p${i}.png`, 10));
    expect(fitsHop(small.slice(0, -1), picture("x.png", 10))).toBe(true);
    expect(fitsHop(small, picture("x.png", 10))).toBe(false);
    const half = Math.floor(LOOP_PICTURE_BYTES_MAX / 2) + 1;
    expect(fitsHop([picture("a.png", half)], picture("b.png", half))).toBe(false);
  });

  test("a later hop's pictures push the earliest out, which keep their path line", () => {
    const loop: ChatMessage[] = [];
    attachPictures(loop, Array.from({ length: LOOP_PICTURES_MAX }, (_, i) => picture(`old${i}.png`, 10)), "zh");
    attachPictures(loop, [picture("new0.png", 10), picture("new1.png", 10)], "zh");
    expect(loopPictureSpend(loop).images).toBe(LOOP_PICTURES_MAX);
    const first = loop[0]!.content as ChatContentPart[];
    expect(imageParts(loop[0])).toHaveLength(LOOP_PICTURES_MAX - 2);
    // old0 and old1 went, oldest first; each keeps its path and says how to look again.
    expect(first[1]).toEqual({ type: "text", text: "old0.png" });
    expect(first[2]).toEqual({ type: "text", text: "（这张图已移出上下文，给新读的图腾出位置；要再看就重新 read_file。）" });
    expect(first[4]!.type).toBe("text");
    expect(first[6]!.type).toBe("image_url");
    expect(imageParts(loop[1])).toHaveLength(2);

    const heavy: ChatMessage[] = [];
    const half = Math.floor(LOOP_PICTURE_BYTES_MAX / 2) + 1;
    attachPictures(heavy, [picture("a.png", half)], "en");
    attachPictures(heavy, [picture("b.png", half)], "en");
    expect(imageParts(heavy[0])).toHaveLength(0);
    expect(imageParts(heavy[1])).toHaveLength(1);
    expect(JSON.stringify(heavy[0])).toContain("read_file it again to look");
  });

  test("read_file answers a picture with its path and hands the shrunk bytes to the engine", async () => {
    const root = workspace("read");
    writeFileSync(join(root, "frames/a.png"), PNG_1X1);
    // Past the 1 MB text limit: frames are 1–4 MB PNGs, and they are shrunk before they are shown.
    writeFileSync(join(root, "frames/big.png"), Buffer.alloc(1_200_000, 1));
    writeFileSync(join(root, "frames/huge.png"), Buffer.alloc(LOOP_PICTURE_BYTES_MAX + 1, 1));
    const store = new Store({ endpointKey: memoryKeyStore("sk-test") });
    await store.patchSettings({ workspace_path: root });
    const signal = new AbortController().signal;
    const read = await runWorkspaceTool({ store, signal }, "read_file", { path: "frames/a.png" });
    expect(read.ok).toBe(true);
    expect(read.data).toEqual({ path: "frames/a.png", mime: "image/png" });
    expect(read.picture).toEqual({ path: "frames/a.png", mime: "image/png", bytes: PNG_1X1 });
    const big = await runWorkspaceTool({ store, signal }, "read_file", { path: "frames/big.png" });
    expect(big.ok).toBe(true);
    expect(big.picture?.bytes.byteLength).toBeLessThanOrEqual(1_200_000);
    // Not a real PNG, so nothing shrinks it, and it stays too big to show.
    const huge = await runWorkspaceTool({ store, signal }, "read_file", { path: "frames/huge.png" });
    expect(huge.error?.code).toBe("too_large");
    store.close();
  });

  test("the next hop sees the picture after the tool results, and the result says so", async () => {
    const root = workspace("hop");
    writeFileSync(join(root, "frames/C01_START.png"), PNG_1X1);
    const h = await reviewer(root, (messages) =>
      messages.some((m) => m.role === "tool") ? say("C01 起帧看过了，没有画风跳变。") : calls(["read_file", { path: "frames/C01_START.png" }]),
    );
    try {
      await h.run("审一下 frames/C01_START.png");
      expect(h.seen).toHaveLength(2);
      const second = h.seen[1]!;
      const at = second.findIndex((m) => m.role === "tool");
      const result = JSON.parse(textOf(second[at]!)) as { ok: boolean; data: Record<string, unknown> };
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({ path: "frames/C01_START.png", mime: "image/png", shown: true });
      expect(String(result.data.note)).toContain("已作为图像附在这批工具结果之后");
      // The line right after the tool results carries the path, then the pixels.
      const line = second[at + 1]!;
      expect(line.role).toBe("user");
      expect((line.content as ChatContentPart[])[1]).toEqual({ type: "text", text: "frames/C01_START.png" });
      expect(imageParts(line)).toEqual([
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1.toString("base64")}` } },
      ]);
      const route = h.store.db
        .query<{ tool_errors: number | null }, [string]>("SELECT tool_errors FROM turn_route_decisions WHERE bot_id = ?")
        .get(h.bot.bot.id);
      expect(route?.tool_errors).toBe(0);
    } finally {
      await h.close();
    }
  });

  test("eighteen frames: a hop shows the cap, says which it left out, and later reads push the earliest out", async () => {
    const root = workspace("frames");
    const frames: string[] = [];
    for (let shot = 1; shot <= 9; shot += 1) {
      for (const edge of ["START", "END"]) {
        const rel = `frames/C0${shot}_${edge}.png`;
        writeFileSync(join(root, rel), PNG_1X1);
        frames.push(rel);
      }
    }
    const h = await reviewer(root, (_messages, hop) => {
      if (hop === 1) return calls(...frames.slice(0, 14).map((path): [string, Record<string, unknown>] => ["read_file", { path }]));
      if (hop === 2) return calls(...frames.slice(12).map((path): [string, Record<string, unknown>] => ["read_file", { path }]));
      return say("18 张起止帧逐对看完：C01–C09 起止姿态衔接，没有画风跳变。");
    });
    try {
      await h.run("逐对核验 frames/ 下的 18 张起止帧");
      expect(h.seen).toHaveLength(3);
      const second = h.seen[1]!;
      const results = second.filter((m) => m.role === "tool").map((m) => JSON.parse(textOf(m)) as { data: { shown: boolean; note: string } });
      expect(results.map((r) => r.data.shown)).toEqual([...Array(LOOP_PICTURES_MAX).fill(true), false, false]);
      expect(results.at(-1)!.data.note).toContain("没附上");
      expect(second.flatMap(imageParts)).toHaveLength(LOOP_PICTURES_MAX);

      // Hop 2 read the last six; the loop still carries the cap, and hop 1's six earliest gave way.
      const third = h.seen[2]!;
      const lines = third.filter((m) => m.role === "user" && Array.isArray(m.content) && JSON.stringify(m.content).includes("read_file 读到的图片"));
      expect(lines).toHaveLength(2);
      expect(imageParts(lines[0])).toHaveLength(LOOP_PICTURES_MAX - 6);
      expect(imageParts(lines[1])).toHaveLength(6);
      expect(JSON.stringify(lines[0]!.content)).toContain("已移出上下文");
      const posted = h.store.listMainMessages(h.bot.direct_session.id, 10).filter((m) => m.kind === "bot");
      expect(posted.map((m) => m.body)).toEqual(["18 张起止帧逐对看完：C01–C09 起止姿态衔接，没有画风跳变。"]);
    } finally {
      await h.close();
    }
  });
});
