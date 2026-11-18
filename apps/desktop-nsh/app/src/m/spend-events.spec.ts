import { expect, test } from "bun:test";
import type { Spend } from "@real-bot/protocol";
import { applyEvent, emptySnapshot } from "./snapshot.ts";

/**
 * Usage rows are not kept on the client. Nothing on screen reads them, and 3,700 of them were
 * 1.4 MB of every snapshot a phone pulled on each reconnect; `GET /v1/spend` serves a view that
 * needs them.
 */
for (const event of ["spend.created", "spend.removed"] as const) {
  test(`a ${event} event leaves the snapshot as it was`, () => {
    const spend: Spend = {
      id: "spend-1",
      session_id: "session-1",
      session_name: "Notes",
      bot_id: "bot-1",
      bot_name: "Writer",
      turn_id: "turn-1",
      judgement_id: null,
      kind: "turn",
      chain_id: null,
      provider_id: null,
      provider_name: null,
      model: null,
      thinking_level: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: 6100,
      cached_tokens: null,
      reasoning_tokens: null,
      cost_usd_ticks: null,
      estimated_cost_usd_ticks: null,
      missing_reason: null,
      created_at: "2026-09-16T00:00:00.000Z",
    };
    const before = emptySnapshot();
    const frame = event === "spend.created"
      ? { event, occurred_at: spend.created_at, ...spend }
      : { event, occurred_at: spend.created_at, id: spend.id };
    expect(applyEvent(before, frame)).toBe(before);
    expect("spend" in before).toBe(false);
  });
}
