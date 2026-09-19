import { expect, test } from "bun:test";
import type { Approval, Turn } from "@real-bot/protocol";
import { pendingCounts } from "./pending.ts";

test("counts pending approvals onto their session via the turn", () => {
  const turns = [{ id: "t1", session_id: "s1" }, { id: "t2", session_id: "s2" }] as Turn[];
  const approvals = [
    { id: "a1", turn_id: "t1", status: "pending" },
    { id: "a2", turn_id: "t1", status: "pending" },
    { id: "a3", turn_id: "t2", status: "denied" },
  ] as Approval[];
  expect(pendingCounts(approvals, turns).get("s1")).toBe(2);
  expect(pendingCounts(approvals, turns).has("s2")).toBe(false);
});
