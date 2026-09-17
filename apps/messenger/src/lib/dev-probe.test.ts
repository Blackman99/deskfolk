import { expect, test } from "bun:test";
import { classifyMessengerDev, decideMessengerDev } from "./dev-probe.ts";

test("discovery with port and token is ours", () => {
  expect(classifyMessengerDev(200, { port: 17890, token: "t" })).toBe("ours");
  expect(classifyMessengerDev(200, { name: "real-bot", port: 17890, token: "t" })).toBe("ours");
});

test("missing runtime on our Vite path is ours", () => {
  expect(
    classifyMessengerDev(404, {
      error: { code: "not_found", message: "runtime not running" },
    }),
  ).toBe("ours");
  expect(
    classifyMessengerDev(404, {
      name: "real-bot",
      error: { code: "not_found", message: "runtime not running" },
    }),
  ).toBe("ours");
});

test("another process on the port is other", () => {
  expect(classifyMessengerDev(200, { ok: true })).toBe("other");
  expect(classifyMessengerDev(200, "<html>vite</html>")).toBe("other");
  expect(classifyMessengerDev(404, { error: { code: "missing" } })).toBe("other");
});

test("unreachable is down", () => {
  expect(classifyMessengerDev(null, null)).toBe("down");
});

test("reuse if any probe is ours, refuse if another process answered, else start", () => {
  expect(decideMessengerDev(["down", "ours"])).toBe("reuse");
  expect(decideMessengerDev(["other", "ours"])).toBe("reuse");
  expect(decideMessengerDev(["down", "other"])).toBe("refuse");
  expect(decideMessengerDev(["down", "down"])).toBe("start");
});
