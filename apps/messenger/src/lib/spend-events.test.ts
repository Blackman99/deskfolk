import { expect, test } from "bun:test";
import type { Spend } from "@real-bot/protocol";
import { applyEvent, emptySnapshot } from "./snapshot.ts";

for (const totalTokens of [null, 6100]) {
  test(`usage remains in the snapshot without a statistics display: ${totalTokens}`, () => {
    const spend: Spend = {
      id: "spend-1",
      session_id: "session-1",
      bot_id: "bot-1",
      turn_id: "turn-1",
      judgement_id: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: totalTokens,
      cached_tokens: null,
      reasoning_tokens: null,
      cost_usd_ticks: null,
      missing_reason: totalTokens === null ? "endpoint_omitted" : null,
      created_at: "2026-09-16T00:00:00.000Z",
    };
    const event = { event: "spend.created" as const, occurred_at: spend.created_at, ...spend };
    const snapshot = applyEvent(emptySnapshot(), event);
    expect(snapshot.spend).toEqual([spend]);
    expect(applyEvent(snapshot, event)).toBe(snapshot);
    expect(snapshot.messages).toEqual([]);
  });
}
