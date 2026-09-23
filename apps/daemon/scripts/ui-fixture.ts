/**
 * An isolated daemon for UI verification: its own data dir, its own port, an in-memory keystore
 * (never the macOS Keychain), the scheduler off, and a scripted model (scripts/fake-openai.ts).
 * It seeds a workspace with one artifact of every previewable kind, a Bot that handed them over in
 * your direct, and a Bot↔Bot direct whose message hands over a file too — so every annotation
 * surface can be exercised by hand or by a browser driver.
 *
 *   bun apps/daemon/scripts/fake-openai.ts &
 *   REAL_BOT_DATA_DIR=/tmp/rb-annot/data bun apps/daemon/scripts/ui-fixture.ts
 *   cd apps/messenger && REAL_BOT_DATA_DIR=/tmp/rb-annot/data pnpm exec vite dev --port 5197 --strictPort
 *
 * Env: REAL_BOT_DATA_DIR (required), REAL_BOT_FIXTURE_BIND (default 127.0.0.1:17907),
 * REAL_BOT_FAKE_ORIGIN (default http://127.0.0.1:17917/v1). Generated media need `ffmpeg` on PATH;
 * without it those files are skipped. Stop with Ctrl-C.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startRuntime } from "../src/runtime";
import { memoryKeyStore } from "../src/secrets";

const dataDir = process.env.REAL_BOT_DATA_DIR;
if (!dataDir) {
  console.error("set REAL_BOT_DATA_DIR to a throwaway directory");
  process.exit(1);
}
const bind = process.env.REAL_BOT_FIXTURE_BIND ?? "127.0.0.1:17907";
const fakeOrigin = process.env.REAL_BOT_FAKE_ORIGIN ?? "http://127.0.0.1:17917/v1";
const workspace = join(dataDir, "workspace");
const DIR = "deliveries";

const PICK_TS = `// Picks the next item to review.
export type Item = { id: string; score: number; seen: boolean };

export function pick(items: Item[]): Item | null {
  const open = items.filter((x) => !x.seen);
  if (open.length === 0) return null;
  let best = open[0]!;
  for (const x of open) {
    if (x.score > best.score) best = x;
  }
  return best;
}

export function markSeen(items: Item[], id: string): Item[] {
  return items.map((x) => (x.id === id ? { ...x, seen: true } : x));
}
`;

const REPORT_MD = `---
title: 季度报告
---

# 季度报告

本季度我们完成了 **三个** 主要目标，详见[附录](#附录)。

## 进展

- 发布了新版本
  - 修复了 12 个问题
  - 新增离线模式
- 迁移了数据库

| 指标 | 上季度 | 本季度 |
| --- | --- | --- |
| 活跃用户 | 1200 | 1850 |
| 留存 | 41% | 47% |

> 下季度重点：稳定性。

\`\`\`ts
export const target = 0.5;
\`\`\`

<div class="note">HTML 块也算一块。</div>

## 附录

最后一段，用来跨段落划词。
`;

const SITE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>设计稿</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; }
  .hero { padding: 48px 32px; background: linear-gradient(120deg, #1d4ed8, #7c3aed); color: #fff; }
  .hero h1 { margin: 0 0 12px; font-size: 32px; animation: pulse 2s infinite alternate; }
  .cta { display: inline-block; margin-right: 12px; padding: 10px 18px; border-radius: 8px; border: 0; font-size: 15px; cursor: pointer; }
  .cta.primary { background: #fff; color: #1d4ed8; }
  .features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 24px 32px; }
  .card { padding: 16px; border: 1px solid #ddd; border-radius: 10px; }
  @keyframes pulse { from { opacity: 1; } to { opacity: 0.8; } }
</style>
</head>
<body>
<section class="hero">
  <h1>把重复的事交给队友</h1>
  <p>本机的 Bot 队友，接你自己的模型端点。</p>
  <button class="cta primary">立即开始</button>
  <button class="cta">了解更多</button>
</section>
<section class="features">
  <div class="card"><h3>本机优先</h3><p>数据留在你的 Mac 上。</p></div>
  <div class="card"><h3>开放端点</h3><p>任何 OpenAI 兼容接口。</p></div>
  <div class="card"><h3>MCP 工具</h3><p>接上你已有的工具。</p></div>
</section>
<script>
  document.querySelector('.cta.primary').addEventListener('click', () => alert('开始'));
  window.parent.postMessage({ hello: 'from the page itself' }, '*');
</script>
</body>
</html>
`;

const NOTES_MD = `# 交接说明

这是 Editor 在 Bot↔Bot 私聊里交出的文件。

- 第一条注意事项
- 第二条注意事项
`;

/** A hand-written PDF: five pages of Helvetica text, no library needed. */
function fixturePdf(): Uint8Array {
  const pages = 5;
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let i = 0; i < pages; i++) {
    const pageObj = 4 + i * 2;
    const contentObj = pageObj + 1;
    const lines = [
      `BT /F1 28 Tf 72 720 Td (Page ${i + 1}: Quarterly figures) Tj ET`,
      `BT /F1 14 Tf 72 680 Td (Revenue grew in region ${String.fromCharCode(65 + i)} by ${10 + i * 3} percent.) Tj ET`,
      `BT /F1 14 Tf 72 656 Td (Total 42 units shipped on page ${i + 1}.) Tj ET`,
      `0.2 0.4 0.8 rg 72 420 ${200 + i * 40} 160 re f`,
      `BT /F1 12 Tf 72 400 Td (Chart ${i + 1}) Tj ET`,
    ].join("\n");
    objects[pageObj] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] = `<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`;
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function ffmpeg(args: string[]): boolean {
  const run = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  return run.status === 0;
}

function seedFiles(): string[] {
  const dir = join(workspace, DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pick.ts"), PICK_TS);
  writeFileSync(join(dir, "report.md"), REPORT_MD);
  writeFileSync(join(dir, "site.html"), SITE_HTML);
  writeFileSync(join(dir, "spec.pdf"), fixturePdf());
  writeFileSync(join(dir, "notes.md"), NOTES_MD);
  const files = ["pick.ts", "report.md", "site.html", "spec.pdf"];
  const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  if (hasFfmpeg) {
    if (existsSync(join(dir, "cover.png")) || ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1600x1000:rate=1", "-frames:v", "1", join(dir, "cover.png")])) files.push("cover.png");
    if (existsSync(join(dir, "clip.mp4")) || ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "12", "-pix_fmt", "yuv420p", "-c:v", "libx264", join(dir, "clip.mp4")])) files.push("clip.mp4");
    if (existsSync(join(dir, "voice.wav")) || ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=8", join(dir, "voice.wav")])) files.push("voice.wav");
  } else {
    console.warn("ffmpeg not found: cover.png, clip.mp4 and voice.wav are skipped");
  }
  return files.map((name) => `${DIR}/${name}`);
}

const handle = await startRuntime({ dataDir, bind, endpointKey: memoryKeyStore(), schedule: false, supervisor: "none" });
const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  const res = await fetch(`${handle.origin}${path}`, {
    method,
    headers: { Authorization: `Bearer ${handle.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

const store = handle.store;
if (store.listBots().length === 0) {
  mkdirSync(workspace, { recursive: true });
  await api("PATCH", "/v1/settings", {
    workspace_path: workspace,
    endpoint_base_url: fakeOrigin,
    endpoint_api_key: "fixture-key",
    endpoint_models: ["fixture"],
    endpoint_default_model: "fixture",
    locale: "zh",
  });
  const paths = seedFiles();
  const writer = store.createBot({ name: "Writer", duties: "写东西、改东西", boundaries: "只在工作区里动手", model: "fixture" });
  const editor = store.createBot({ name: "Editor", duties: "审稿", boundaries: "只读", model: "fixture" });
  // Your direct with Writer: you asked, Writer delivered every kind in one message.
  const ask = store.postMessage(writer.direct_session.id, { body: "把这批产物交给我：代码、报告、设计稿、PDF、图片、视频和音频。" });
  const turn = store.createTurn({ sessionId: writer.direct_session.id, botId: writer.bot.id, triggerMessageId: ask.id });
  store.insertMessage({
    sessionId: writer.direct_session.id,
    turnId: turn.id,
    kind: "bot",
    author: writer.bot.id,
    body: `都在这里了，打开看看，有问题直接在上面批注。\n${paths.map((p) => `附件：${p}`).join("\n")}`,
    paths,
  });
  store.setTurnStatus(turn.id, "completed");
  // A Bot↔Bot direct: Writer asked Editor, Editor handed a file back.
  const opener = store.insertMessage({ sessionId: writer.direct_session.id, turnId: turn.id, kind: "bot", author: writer.bot.id, body: "我去请 Editor 看一下交接说明。" });
  const botDm = store.createBotDirect(writer.bot.id, editor.bot.id, { sessionId: writer.direct_session.id, messageId: opener.id });
  const ask2 = store.insertMessage({ sessionId: botDm.id, turnId: turn.id, kind: "bot", author: writer.bot.id, body: `@Editor 请整理交接说明。` });
  const turn2 = store.createTurn({ sessionId: botDm.id, botId: editor.bot.id, triggerMessageId: ask2.id });
  store.insertMessage({ sessionId: botDm.id, turnId: turn2.id, kind: "bot", author: editor.bot.id, body: `整理好了。\n附件：${DIR}/notes.md`, paths: [`${DIR}/notes.md`] });
  store.setTurnStatus(turn2.id, "completed");
  console.log(JSON.stringify({ writer_direct: writer.direct_session.id, bot_direct: botDm.id, editor_direct: editor.direct_session.id }));
}

console.log(`fixture daemon on ${handle.origin} (data ${dataDir}); Ctrl-C stops it`);
const stop = async () => {
  await handle.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
