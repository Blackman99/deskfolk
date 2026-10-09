/**
 * A scenario's reader when the test scripts none: it answers a reading of your line the way the
 * model does, in the model's format, worked out by the word rules (`control-line.ts`,
 * `complaint-words.ts`). Since ADR 0070 the app carries nothing out on a line the reader could not
 * read, so an unscripted reading has to come back as a model's for a test's 「停」 or 「继续」 to
 * mean anything; what the app makes of a reading is what the tests are about, and the rules are a
 * fair stand-in for a model that reads such lines right.
 */
import { clauseObjects, clausesOf } from "../complaint-words";
import { readControlLine } from "../control-line";
import { isoNow } from "../ids";
import type { Store } from "../store";

/** The model's answer to `call.read_user_line` for `payload`, or "" when the payload is not one. */
export function userLineAnswerByRules(store: Store | null, payload: unknown): string {
  const fields = (payload ?? {}) as { said?: unknown; where?: unknown };
  if (typeof fields.said !== "string") return "";
  const said = fields.said;
  const reading = readControlLine({
    message: { kind: "user", body: said, session_id: "", created_at: isoNow(), parent_id: null, attachments: [], annotation_source_message_id: null },
    sessionKind: fields.where === "group" ? "group" : "direct",
    roster: store ? store.listBots().map((bot) => ({ id: bot.id, name: bot.name })) : [],
    present: [],
    // 「没停」 reads as a stop to the model: it says the work has not stopped.
    held: () => true,
  });
  const answer = { control: "none", control_only: false, status_only: false, objections: clausesOf(said).filter(clauseObjects) };
  switch (reading.kind) {
    case "stop":
    case "reaffirm":
      return JSON.stringify({ ...answer, control: "stop", control_only: true, objections: [] });
    case "continue":
      return JSON.stringify({ ...answer, control: "go_on", control_only: true, objections: [] });
    case "possible_control": {
      const stop = reading.offer.includes("stop");
      const goOn = reading.offer.includes("continue");
      return JSON.stringify({ ...answer, control: stop && goOn ? "both" : stop ? "stop" : "go_on" });
    }
    case "status":
      return JSON.stringify({ ...answer, status_only: true });
    default:
      return JSON.stringify(answer);
  }
}
