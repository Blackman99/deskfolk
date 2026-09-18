import { expect, test } from "bun:test";
import { corsHeaders, originDecision } from "./origin";

test("missing Origin is allowed for curl and tests", () => {
  expect(originDecision(null)).toBe("missing");
});

test("loopback http origins are allowed, including IPv6", () => {
  expect(originDecision("http://localhost:5173")).toBe("allowed");
  expect(originDecision("http://127.0.0.1:5173")).toBe("allowed");
  expect(originDecision("http://[::1]:5173")).toBe("allowed");
  expect(originDecision("http://[::1]")).toBe("allowed");
});

test("tauri localhost origin is allowed", () => {
  expect(originDecision("tauri://localhost")).toBe("allowed");
});

test("non-loopback and non-http origins are forbidden", () => {
  expect(originDecision("https://evil.example")).toBe("forbidden");
  expect(originDecision("http://192.168.1.10:5173")).toBe("forbidden");
  expect(originDecision("http://[::2]:5173")).toBe("forbidden");
  expect(originDecision("https://localhost:5173")).toBe("forbidden");
  expect(originDecision("not a url")).toBe("forbidden");
});

test("CORS headers echo the origin and allow private / local network", () => {
  const headers = corsHeaders("http://[::1]:5173");
  expect(headers["Access-Control-Allow-Origin"]).toBe("http://[::1]:5173");
  expect(headers["Access-Control-Allow-Private-Network"]).toBe("true");
  expect(headers["Access-Control-Allow-Local-Network"]).toBe("true");
});
