/**
 * The app's lines about the requirements ledger (ADR 0040 P3), in the plan's conversation when you
 * are in it, each with its buttons. Two kinds:
 * - `legacy`: the plan bears old rules the app found none of your words for (taken in from before
 *   the ledger, `unverified`): 「这些是你说的吗」 with 都是 (they are in force from then) and 逐条看
 *   (the messenger opens the board, where each has its own buttons). Put up once per rule, the
 *   first time a line of yours lands in a plan that bears it.
 * - `standing`: craft requirements of one category you have now raised in two or more video jobs of
 *   one conversation, the words of each on the card: 升为常设 makes them hold for every video job,
 *   不用 leaves them where they are. Once per category; when the category's entries say different
 *   things, about one entry you have said in two such jobs instead, once per entry.
 * Neither is sent to the Bots: they read the ledger in the plan's situation.
 */
import { USER_MEMBER, type ControlActionResult, type Locale, type Message } from "@real-bot/protocol";
import { HttpError } from "../errors";
import type { Store, UserQuote } from "../store";
import { appLineAuthor } from "./derived-checks";

export type RequirementCardsDeps = {
  store: Store;
  publishMessage: (message: Message) => void;
  log?: (line: string) => void;
};

export type RequirementCards = {
  /** A line or an answer of yours landed in a plan: old rules no card has asked you about get one. */
  noteLine: (messageId: string) => void;
  /** The scribe wrote down or raised these entries from one of your lines: maybe the standing suggestion. */
  noteFiled: (quote: UserQuote, touched: readonly string[]) => void;
  /** A button on one of these lines. */
  act: (message: Message, input: { action: unknown }) => ControlActionResult;
};

/** How many of the old rules a card names in its body; the board lists the rest. */
const LEGACY_NAMED = 5;
const NAMED_MAX = 60;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return [...flat].length > NAMED_MAX ? `${[...flat].slice(0, NAMED_MAX).join("")}…` : flat;
}

/** What a card about old rules says. */
export function legacyCardBody(locale: Locale, quotes: readonly string[]): string {
  const en = locale === "en";
  const named = quotes.slice(0, LEGACY_NAMED).map((quote) => (en ? `"${clip(quote)}"` : `「${clip(quote)}」`));
  const rest = quotes.length - named.length;
  const list = named.join(en ? ", " : "") + (rest > 0 ? (en ? ` and ${rest} more` : ` 等 ${quotes.length} 条`) : "");
  return en
    ? `This job has ${quotes.length} old rule${quotes.length === 1 ? "" : "s"} from before the requirements ledger with none of your words found for ${quotes.length === 1 ? "it" : "them"}: ${list}. The Bots read ${quotes.length === 1 ? "it" : "them"} for reference only, and nothing is held to ${quotes.length === 1 ? "it" : "them"}. Did you say ${quotes.length === 1 ? "it" : "these"}?`
    : `这件事有 ${quotes.length} 条台账之前的旧规则，没找到你说过它们的原话：${list}。现在 Bot 只把它们当参考，不按它们验收。这些是你说的吗？`;
}

/**
 * What a card suggesting entries hold for every job of a kind says: the words of each, so the press
 * is made knowing what it widens; `each` when it asks about one entry of its category alone.
 */
export function standingCardBody(
  locale: Locale,
  card: { category: string; domain: string; plans: number; quotes: readonly string[]; each: boolean },
): string {
  const en = locale === "en";
  const kind = card.domain === "video" ? (en ? "video job" : "视频") : card.domain;
  const words = card.quotes.map((quote) => (en ? `"${clip(quote)}"` : `「${clip(quote)}」`)).join(en ? ", " : "");
  const these = card.quotes.length === 1 ? (en ? "it" : "这条") : en ? "them" : "这些";
  if (card.each) {
    return en
      ? `You have said ${words} in ${card.plans} jobs. Make it hold for every ${kind} from now on?`
      : `${words}你在 ${card.plans} 件事里都说过。要不要以后每个${kind}都照这条？`;
  }
  return en
    ? `You have asked for "${card.category}" in ${card.plans} jobs: ${words}. Make ${these} hold for every ${kind} from now on?`
    : `「${card.category}」这类要求你在 ${card.plans} 件事里都提过：${words}。要不要以后每个${kind}都照${these}？`;
}

export function createRequirementCards(deps: RequirementCardsDeps): RequirementCards {
  const { store, publishMessage } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));

  /** Where a card about the plan goes: its conversation, when you are in it; else nowhere. */
  function home(taskId: string): string | null {
    try {
      const sessionId = store.getTask(taskId).session_id;
      return sessionId && store.isPresent(sessionId, USER_MEMBER) ? sessionId : null;
    } catch {
      return null;
    }
  }

  /** The line and the work log's note of it land together; the line goes out once both have. */
  function say(
    sessionId: string,
    body: string,
    control: Extract<Message["control"], { kind: "requirement" }>,
    note: (messageId: string) => void,
  ): void {
    const message = store.transaction(() => {
      const line = store.insertMessage({ sessionId, kind: "system", author: appLineAuthor(store, sessionId), body, hiddenFromBots: true, control });
      note(line.id);
      return line;
    });
    publishMessage(message);
  }

  function noteLine(messageId: string): void {
    try {
      const taskId = store.getMessage(messageId).task_id;
      if (!taskId) return;
      const due = store.legacyCardDue(taskId);
      const sessionId = due.length > 0 ? home(taskId) : null;
      if (!sessionId) return;
      const quotes = due.map((id) => store.getRequirement(id).quote);
      say(
        sessionId,
        legacyCardBody(store.settingsCached().locale, quotes),
        { kind: "requirement", event: "legacy", requirement_ids: due, task_id: taskId, offer: ["confirm_requirements", "review_requirements"] },
        (messageId) => store.recordRequirementCard({ card: "legacy", requirements: due, messageId, taskId }),
      );
    } catch (error) {
      log(`[requirements] line ${messageId}: could not ask about old rules: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function noteFiled(quote: UserQuote, touched: readonly string[]): void {
    if (!quote.task_id || touched.length === 0) return;
    try {
      const suggestion = store.standingSuggestion(quote.task_id, touched);
      const sessionId = suggestion ? home(quote.task_id) : null;
      if (!suggestion || !sessionId) return;
      const taskId = quote.task_id;
      say(
        sessionId,
        standingCardBody(store.settingsCached().locale, suggestion),
        {
          kind: "requirement",
          event: "standing",
          requirement_ids: suggestion.requirements,
          task_id: taskId,
          category: suggestion.category,
          domain: suggestion.domain,
          offer: ["make_standing", "keep_project"],
        },
        (messageId) =>
          store.recordRequirementCard({
            card: "standing",
            requirements: suggestion.requirements,
            category: suggestion.category,
            each: suggestion.each,
            messageId,
            taskId,
          }),
      );
    } catch (error) {
      log(`[requirements] quote ${quote.id}: could not suggest standing: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function act(message: Message, input: { action: unknown }): ControlActionResult {
    const control = message.control;
    if (control?.kind !== "requirement") throw new HttpError(422, "invalid_args", "this line is not about requirements");
    const action = input.action;
    const served = action === "confirm_requirements" || action === "make_standing" || action === "keep_project";
    if (!served || !control.offer.includes(action)) throw new HttpError(422, "invalid_args", "this line does not offer that button");
    // One press per line, as on every line with buttons.
    if ((control.acted ?? []).length > 0) return { made: [], lifted: [] };
    store.transaction(() => {
      for (const id of control.requirement_ids) {
        let entry;
        try {
          entry = store.getRequirement(id);
        } catch {
          continue; // purged since
        }
        // Each only where it still applies: one you took up or turned down on the board is left as you
        // left it, and 升为常设 widens only what such a card may name now (a craft entry of this
        // conversation, still in force), whatever the line lists.
        if (action === "confirm_requirements" && entry.status === "unverified") store.confirmRequirement(id, { taskId: control.task_id });
        if (action === "make_standing" && store.mayMakeStanding(id, { taskId: control.task_id, category: control.category ?? null })) {
          store.widenRequirement(id, { to: "standing", taskId: control.task_id, domain: control.domain ?? null });
        }
      }
      store.setMessageControl(message.id, { ...control, acted: [action] });
    });
    return { made: [], lifted: [] };
  }

  return { noteLine, noteFiled, act };
}
