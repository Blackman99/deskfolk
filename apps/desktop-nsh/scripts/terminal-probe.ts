/**
 * Development check of the native terminal, beside the person's own work: types into the dev
 * runtime's live terminal through the runtime (the same input route the view's keys take) and asks
 * the dev shell for a picture after each step (`--snapshots`). Never touches the stable instance.
 *
 *   bun apps/desktop-nsh/scripts/terminal-probe.ts [--shots /tmp/deskfolk-nsh-shots]
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Terminal } from "../../../packages/protocol/src/index.ts";
import { assertApartFromStable, devInstance } from "./dev-instance";

const instance = devInstance();
assertApartFromStable(instance);
const at = process.argv.indexOf("--shots");
const shots = at >= 0 ? process.argv[at + 1]! : "/tmp/deskfolk-nsh-shots";
const { port, token } = JSON.parse(readFileSync(join(instance.dataDir, "local-api.json"), "utf8")) as { port: number; token: string };
if (port !== instance.port) throw new Error(`the dev descriptor names port ${port}`);
const origin = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const { items } = (await (await fetch(`${origin}/v1/terminals`, { headers })).json()) as { items: Terminal[] };
const terminal = items.find((t) => t.status === "live");
if (!terminal) throw new Error("no live terminal: open the dev build on its terminal pane (DESKFOLK_PANE=terminal)");

async function type(text: string): Promise<void> {
  const res = await fetch(`${origin}/v1/terminals/${terminal!.id}/input`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data: Buffer.from(text).toString("base64") }),
  });
  if (!res.ok) throw new Error(`input refused: ${res.status}`);
}

async function picture(name: string): Promise<void> {
  const out = join(shots, "window-1.png");
  rmSync(out, { force: true });
  writeFileSync(join(shots, "request"), "");
  for (let i = 0; i < 50 && !existsSync(out); i++) await Bun.sleep(100);
  await Bun.sleep(150);
  if (!existsSync(out)) throw new Error("the dev shell drew no picture: start it with DESKFOLK_SNAPSHOTS");
  renameSync(out, join(shots, `terminal-${name}.png`));
  console.log(`picture ${join(shots, `terminal-${name}.png`)}`);
}

const steps: [string, string, number][] = [
  [
    "colours",
    "clear; printf '\\e[1;31m红色粗体\\e[0m \\e[42;30m 绿底 \\e[0m 中文宽字符|English|对齐\\n'; for i in $(seq 0 15); do printf \"\\e[48;5;${i}m  \"; done; printf '\\e[0m\\n'; for i in $(seq 16 6 231); do printf \"\\e[48;5;${i}m \"; done; printf '\\e[0m\\n'\r",
    800,
  ],
  ["flood", "clear; time (yes 'NSH terminal throughput probe 0123456789 中文' | head -200000)\r", 8000],
  ["vim", "vim -u NONE -N -c 'set number' -c 'syntax on' /etc/hosts\r", 1500],
  ["vim-closed", ":q!\r", 800],
  ["top", "top -o cpu -n 12\r", 2500],
];

for (const [name, keys, wait] of steps) {
  await type(keys);
  await Bun.sleep(wait);
  await picture(name);
}
await type("q");
await Bun.sleep(400);
await type("clear\r");
