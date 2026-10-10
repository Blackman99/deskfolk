import { expect, test } from "bun:test";
import { folkMotion } from "./folk-motion.ts";
import type { SessionStateKind } from "./sidebar/session-status.ts";

test("every status a Bot shows has a motion, and no status means idle", () => {
  const motions: Record<SessionStateKind, string> = {
    running: "running",
    replying: "replying",
    waiting_approval: "waiting",
    waiting_ask: "waiting",
    failed: "failed",
    interrupted: "failed",
    idle: "idle",
  };
  for (const [kind, motion] of Object.entries(motions)) {
    expect(folkMotion(kind as SessionStateKind)).toBe(motion);
  }
  expect(folkMotion(undefined)).toBe("idle");
});
