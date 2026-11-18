import { expect, test } from "bun:test";
import { classifyHealth } from "./health.ts";

test("200 with our health body is ours", () => {
  expect(classifyHealth(200, { ok: true, name: "real-bot" })).toBe("ours");
});

test("200 with someone else on the port is other", () => {
  expect(classifyHealth(200, { ok: true, name: "nginx" })).toBe("other");
  expect(classifyHealth(404, { ok: false })).toBe("other");
});

test("unreachable is down", () => {
  expect(classifyHealth(null, null)).toBe("down");
});
