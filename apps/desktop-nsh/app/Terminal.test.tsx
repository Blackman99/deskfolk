/** The canvas terminal's key handling, and typing through the app to the runtime (stubbed). */
import { expect, open, test } from "nsh/test";
import { encode, keyBytes } from "./src/Terminal";

const ORIGIN = "http://127.0.0.1:17990";

function decode(b64: string): string {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bits = b64.replace(/=+$/, "").split("").map((c) => table.indexOf(c).toString(2).padStart(6, "0")).join("");
  const bytes = bits.match(/.{8}/g)?.map((b) => parseInt(b, 2)) ?? [];
  return new TextDecoder().decode(new Uint8Array(bytes));
}

test("text goes to the pty as UTF-8 in base64", () => {
  expect(encode("ls\r")).toBe("bHMN");
  expect(encode("中")).toBe("5Lit");
  expect(encode("")).toBe("");
});

test("keys send VT sequences, application cursor keys when asked", () => {
  expect(keyBytes("up", false)).toBe("\x1b[A");
  expect(keyBytes("up", true)).toBe("\x1bOA");
  expect(keyBytes("shift+tab", false)).toBe("\x1b[Z");
  expect(keyBytes("ctrl+c", false)).toBe("\x03");
  expect(keyBytes("ctrl+z", false)).toBe("\x1a");
  expect(keyBytes("mod+k", false)).toBe(null);
});

test("typing in the terminal pane reaches the runtime's pty", async () => {
  const inputs: string[] = [];
  let watched = false;
  const app = await open("App.tsx", {
    platform: "macos",
    width: 1100,
    height: 760,
    network: {
      [`GET ${ORIGIN}/v1/snapshot`]: {
        body: {
          event_instance_id: "i1",
          watermark_seq: 1,
          settings: { workspace_path: "/tmp/w" },
          bots: [],
          sessions: [],
          approvals: [],
          mcpServers: [],
          providers: [],
          skills: [],
          memories: [],
          routines: [],
        },
      },
      [`GET ${ORIGIN}/v1/terminals`]: { body: { items: [{ id: "t1", title: "zsh", cwd: "/tmp/w", rows: 24, cols: 80, status: "live" }] } },
      [`GET ${ORIGIN}/v1/terminals/t1/screen`]: { body: { offset: 0, data: encode("$ "), rows: 24, cols: 80 } },
      [`POST ${ORIGIN}/v1/terminals/t1/watch`]: () => {
        watched = true;
        return { body: {} };
      },
      [`POST ${ORIGIN}/v1/terminals/t1/resize`]: { body: {} },
      [`POST ${ORIGIN}/v1/terminals/t1/input`]: (request: { body?: string | null }) => {
        inputs.push((JSON.parse(request.body ?? "{}") as { data: string }).data);
        return { body: {} };
      },
    },
    host: { params: { origin: ORIGIN, token: "test-token", windowId: 1, material: "glass" } },
  });
  await app.press("text:终端");
  await app.waitFor("id:terminal");
  await app.waitUntil(() => watched);
  await app.type("id:terminal-keys", "ls");
  await app.waitUntil(() => inputs.map(decode).join("") === "ls");
  expect(decode(encode("中文"))).toBe("中文");
});
