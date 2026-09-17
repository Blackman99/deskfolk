import { expect, test } from "bun:test";
import type { Spend } from "@real-bot/protocol";
import { formatSpend } from "./spend-format.ts";

function row(partial: Partial<Spend>): Spend {
  return {
    id: "s",
    session_id: "sess",
    bot_id: "bot",
    turn_id: "turn",
    judgement_id: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cached_tokens: null,
    reasoning_tokens: null,
    cost_usd_ticks: null,
    missing_reason: "endpoint_omitted",
    created_at: "t",
    ...partial,
  };
}

test("no numbers is an em dash, not zero", () => {
  expect(formatSpend([])).toBe("—");
  expect(formatSpend([row({ missing_reason: "endpoint_omitted" })])).toBe("—");
});

test("tokens without ticks show a token chip", () => {
  expect(formatSpend([row({ total_tokens: 6100, missing_reason: null })])).toBe("6.1k");
  expect(formatSpend([row({ total_tokens: 91, missing_reason: null })])).toBe("91");
});

test("ticks win and format as USD", () => {
  expect(
    formatSpend([
      row({
        total_tokens: 100,
        cost_usd_ticks: 18_400_000_000,
        missing_reason: null,
      }),
    ]),
  ).toBe("$1.84");
});

test("sums rows; a missing side stays missing", () => {
  expect(
    formatSpend([
      row({ total_tokens: 1000, missing_reason: null }),
      row({ total_tokens: 500, missing_reason: null }),
    ]),
  ).toBe("1.5k");
});
