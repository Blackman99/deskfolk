/**
 * Runs `app/e2e/live.test.tsx` headless against the dev runtime (never the stable one): writes a
 * line into the dev instance's first conversation so there is something to read, and hands the
 * test the dev runtime's address and token in a file it removes afterwards.
 *
 *   bun apps/desktop-nsh/scripts/e2e-live.ts
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeSnapshot } from "../../../packages/protocol/src/index.ts";
import { assertApartFromStable, devInstance } from "./dev-instance";

const root = resolve(import.meta.dir, "..");
const instance = devInstance();
assertApartFromStable(instance);

const descriptor = JSON.parse(readFileSync(join(instance.dataDir, "local-api.json"), "utf8")) as { port: number; token: string };
if (descriptor.port !== instance.port) throw new Error(`the dev descriptor names port ${descriptor.port}, not ${instance.port}`);
const origin = `http://127.0.0.1:${descriptor.port}`;
const headers = { Authorization: `Bearer ${descriptor.token}`, "Content-Type": "application/json" };

const snapshot = (await (await fetch(`${origin}/v1/snapshot`, { headers })).json()) as RuntimeSnapshot;
const session = snapshot.sessions[0];
if (!session) throw new Error("the dev runtime has no conversation yet; open the dev build once");
const expect = `NSH 实测 ${new Date().toISOString().slice(11, 19)}`;
const posted = await fetch(`${origin}/v1/sessions/${session.id}/messages`, {
  method: "POST",
  headers,
  body: JSON.stringify({ body: `${expect}\n\n- 一行 **粗体**\n- 一行 \`代码\`` }),
});
if (!posted.ok) throw new Error(`could not write the probe line: ${posted.status}`);

const paramsFile = join(root, "app", "e2e", ".live-params.json");
const live = `${expect} · 实时`;
writeFileSync(paramsFile, JSON.stringify({ origin, token: descriptor.token, session: session.id, expect, live }), { mode: 0o600 });
try {
  const nsh = process.env.NSH ?? join(homedir(), ".local", "bin", "nsh");
  const test = Bun.spawn([nsh, "test", "e2e/live.test.tsx"], { cwd: join(root, "app"), stdout: "inherit", stderr: "inherit" });
  // Written while the test holds the conversation open: only the event stream can bring it in.
  await Bun.sleep(2500);
  const sent = await fetch(`${origin}/v1/sessions/${session.id}/messages`, { method: "POST", headers, body: JSON.stringify({ body: live }) });
  if (!sent.ok) console.error(`could not write the live line: ${sent.status}`);
  process.exitCode = await test.exited;
} finally {
  rmSync(paramsFile, { force: true });
}
