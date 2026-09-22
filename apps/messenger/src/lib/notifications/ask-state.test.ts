import { expect, test } from "bun:test";
import { ApiError } from "../api.ts";
import {
  askEndedCopy,
  askSubmitAllowed,
  classifySendAskFailure,
  clearAskIfMatching,
  isExactPendingAsk,
  nextDraftVersion,
  pendingAskIdOf,
  recordAskError,
} from "./ask-state.ts";

const waiting = { id: "turn-1", status: "waiting_ask" as const, pending_ask_id: "ask-2" };
const ask = { id: "ask-1", kind: "ask", turn_id: "turn-1" };

test("only the exact pending_ask_id is actionable when the capability is present", () => {
  expect(isExactPendingAsk(ask, [waiting], true)).toBe(false);
  expect(isExactPendingAsk({ ...ask, id: "ask-2" }, [waiting], true)).toBe(true);
  expect(isExactPendingAsk({ ...ask, id: "ask-2" }, [waiting], false)).toBe(false);
  expect(pendingAskIdOf({ id: "turn-1", status: "running", pending_ask_id: "ask-2" })).toBeNull();
});

test("old cards stay ended even if the turn is still waiting on Q2", () => {
  expect(askEndedCopy(true, "ask-2", "ask-1")).toBe("waiting_other");
  expect(askEndedCopy(true, null, "ask-1")).toBe("ended");
  expect(askEndedCopy(false, "ask-1", "ask-1")).toBe("ended");
});

test("accepted clears only the submitted draft version", () => {
  const first = nextDraftVersion(undefined, "one");
  const edited = nextDraftVersion(first, "two");
  expect(clearAskIfMatching(edited, first.version, true)?.body).toBe("two");
  expect(clearAskIfMatching(first, first.version, true)).toBeUndefined();
  expect(clearAskIfMatching(first, first.version, false)?.body).toBe("one");
});

test("editing a draft body drops the previous requestId", () => {
  const first = { ...nextDraftVersion(undefined, "one"), requestId: "req-1" };
  expect(nextDraftVersion(first, "one").requestId).toBe("req-1");
  expect(nextDraftVersion(first, "two").requestId).toBeUndefined();
});

test("422/409 keep the draft and do not look like success", () => {
  const error = new ApiError(422, "ask_closed", "already answered");
  expect(classifySendAskFailure(error, false)).toEqual({ status: "rejected", error });
  const unknown = new ApiError(503, "request_unknown", "lost", "req-1");
  expect(classifySendAskFailure(unknown, true)).toEqual({
    status: "unknown",
    request_id: "req-1",
    error: unknown,
  });
  const kept = recordAskError(undefined, "ask-1", "draft", "already answered");
  expect(kept.body).toBe("draft");
  expect(kept.error).toBe("already answered");
});

test("not_submitted covers busy, empty, disconnected, and stale ask pointers", () => {
  expect(askSubmitAllowed(true, false, "  ", "ask-1", "ask-1", true)?.reason).toBe("empty");
  expect(askSubmitAllowed(false, false, "hi", "ask-1", "ask-1", true)?.reason).toBe("disconnected");
  expect(askSubmitAllowed(true, true, "hi", "ask-1", "ask-1", true)?.reason).toBe("busy");
  expect(askSubmitAllowed(true, false, "hi", "ask-2", "ask-1", true)?.reason).toBe("stale_ask");
  expect(askSubmitAllowed(true, false, "hi", "ask-1", "ask-1", false)?.reason).toBe("stale_ask");
  expect(askSubmitAllowed(true, false, "hi", "ask-1", "ask-1", true)).toBeNull();
});
