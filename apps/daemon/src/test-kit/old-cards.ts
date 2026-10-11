/**
 * The 放行/退回 card older builds put a hand-over to you with (ADR 0046, ADR 0058 §13). None is put up
 * since ADR 0084 — a hand-over waits on your word — but a database from before still holds some, and
 * they still answer a press; tests that press one make it here.
 */
import { USER_MEMBER, type Message } from "@real-bot/protocol";
import type { Store } from "../store";

/** A card for the hand-over `submissionId`, waiting on you in `sessionId`, as an older build left it. */
export function oldApprovalCard(store: Store, submissionId: string, sessionId: string): Message {
  const submission = store.getSubmission(submissionId);
  if (submission.awaiting?.kind !== "approval") throw new Error(`submission ${submissionId} does not wait on you`);
  const card = store.insertMessage({ sessionId, kind: "system", author: USER_MEMBER, body: "交上来了。看过之后，放行或者退回。", hiddenFromBots: true,
    control: { kind: "review_item", submission_id: submission.id, task_id: submission.task_id, ticket_id: submission.ticket_id,
      requirement_ids: submission.awaiting.requirement_ids, check_ids: [], offer: ["approve", "reject"] } });
  store.db.run("UPDATE submissions SET awaiting = json_set(awaiting, '$.message_id', ?) WHERE id = ?", [card.id, submission.id]);
  return card;
}

/** The hand-over waiting on you in `taskId`, newest first: what an old card would have been put up for. */
export function waitingHandOver(store: Store, taskId: string): string {
  const waiting = store.listSubmissions({ taskId }).find((row) => row.awaiting?.kind === "approval");
  if (!waiting) throw new Error(`nothing in ${taskId} waits on you`);
  return waiting.id;
}
