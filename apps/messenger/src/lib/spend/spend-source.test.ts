import { expect, test } from "bun:test";
import { spendSource } from "./spend-source.ts";

const providers = [
  { id: "p-anthropic", base_url: "https://api.anthropic.com/", api_format: "anthropic" as const },
  { id: "p-own", base_url: "https://proxy.example.com/v1", api_format: "openai" as const },
];

test("a local agent's call wears its agent's logo, an endpoint's its vendor's, an unknown one a tile", () => {
  expect(spendSource("", "Claude Agent", providers)).toEqual({ kind: "claude-agent", name: "Claude Agent" });
  expect(spendSource(null, "Codex", providers)).toEqual({ kind: "agent", runner: "codex", name: "Codex" });
  expect(spendSource("", "My ACP thing", providers)).toEqual({ kind: "agent", runner: "custom", name: "My ACP thing" });
  expect(spendSource("p-anthropic", "My Anthropic", providers)).toMatchObject({ kind: "connector", name: "My Anthropic" });
  expect(spendSource("p-own", "Mine", providers)).toEqual({ kind: "custom", name: "Mine" });
  expect(spendSource("p-gone", "Old", providers)).toEqual({ kind: "custom", name: "Old" });
  expect(spendSource(null, null, providers)).toBeNull();
});
