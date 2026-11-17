/**
 * The questions a project session's agent asks you mid-run (ADR 0095 addendum 2026-11-17): Codex's
 * `request_user_input`, Claude Code's `AskUserQuestion`, Antigravity's `ask_question`. Each question
 * is a card in the conversation, the one a Bot's `ask_user` makes (`ask` line, `AskCard`): its
 * options to pick, words of your own beside them. The agent waits until every question of the call
 * has an answer, then goes on with them. A line you type meanwhile answers every card still open,
 * in your words, as it does a Bot's question. When the run ends first, the cards take no answer.
 *
 * What an agent sends is its model's, so it is taken as it comes: options beyond what a card holds,
 * too long or repeated are trimmed rather than refused. A question with fewer than two options is
 * one you answer in words.
 */
import {
  ASK_CUSTOM_MAX,
  ASK_DESCRIPTION_MAX,
  ASK_LABEL_MAX,
  ASK_OPTIONS_MAX,
  ASK_OPTIONS_MIN,
  USER_MEMBER,
  type AskOption,
  type AskSpec,
  type Message,
} from "@real-bot/protocol";
import { parseAskAnswer } from "./ask";
import { HttpError } from "./errors";
import { isoNow } from "./ids";
import type { Store } from "./store";

/** One question as an agent asks it. */
export type AgentQuestion = {
  question: string;
  /** A short tag some agents put above the question (Codex's `header`): the card's words only when the question has none. */
  header?: string | null;
  options: Array<{ label: string; description?: string | null }>;
  multiSelect: boolean;
};

/** Your answer to one question: the options you picked, by the agent's own labels, and words of your own. */
export type AgentAnswer = { selected: string[]; custom: string | null };

const codePoints = (text: string) => [...text].length;
const clip = (text: string, max: number) => (codePoints(text) > max ? `${[...text].slice(0, max - 1).join("")}…` : text);

/**
 * The card a question makes: its options as a card holds them (trimmed, clipped, no repeats), each
 * shown label with the agent's own behind it. Fewer than two left, the question is one of words.
 */
export function askCardOf(question: AgentQuestion): { body: string; spec: AskSpec | null; labels: Map<string, string> } {
  const labels = new Map<string, string>();
  const options: AskOption[] = [];
  for (const option of question.options) {
    if (options.length >= ASK_OPTIONS_MAX) break;
    const raw = typeof option.label === "string" ? option.label.trim() : "";
    if (!raw) continue;
    const label = clip(raw, ASK_LABEL_MAX);
    if (labels.has(label)) continue;
    labels.set(label, option.label);
    const description = typeof option.description === "string" ? option.description.trim() : "";
    options.push({ label, ...(description ? { description: clip(description, ASK_DESCRIPTION_MAX) } : {}) });
  }
  // The question says what its tag does; the tag stands in only when there are no other words.
  const body = question.question.trim() || question.header?.trim() || "?";
  if (options.length < ASK_OPTIONS_MIN) return { body, spec: null, labels: new Map() };
  return { body, spec: { options, multi_select: question.multiSelect }, labels };
}

/** One call's questions, waiting until each has its answer. */
type Call = {
  ids: string[];
  cards: Array<ReturnType<typeof askCardOf>>;
  answers: Array<AgentAnswer | undefined>;
  done: (answers: AgentAnswer[] | null) => void;
};

export type QuestionDesk = {
  /** Puts the questions up as cards and waits for an answer to each; null when the run ends first. */
  ask(questions: AgentQuestion[]): Promise<AgentAnswer[] | null>;
  /** Your answer on one card; refused when the card no longer waits. */
  answer(askId: string, input: { selected?: unknown; custom?: unknown }): Message;
  /** Your line while cards are open: the answer to each, in your words. True when it was taken so. */
  takeLine(message: Message): boolean;
  /** The ids of the cards waiting now, oldest first. */
  open(): string[];
  /** The run is over: open cards take no answer now, and the agent's waits end with null. */
  close(): void;
};

/**
 * A run's questions. `changed` hears the cards waiting after each change (the run's `asks`, and
 * whether it waits on you); it is not called by `close`, since an ended run waits on nothing.
 */
export function questionDesk(store: Store, sessionId: string, changed: (open: string[]) => void): QuestionDesk {
  const calls: Call[] = [];
  let closed = false;

  const open = () => calls.flatMap((call) => call.ids.filter((_, index) => call.answers[index] === undefined));
  const where = (askId: string) => {
    for (const call of calls) {
      const index = call.ids.indexOf(askId);
      if (index >= 0 && call.answers[index] === undefined) return { call, index };
    }
    return null;
  };
  /** One answer in: once a call's questions all have theirs, the agent goes on. */
  const settle = (call: Call) => {
    if (call.answers.some((answer) => answer === undefined)) return;
    calls.splice(calls.indexOf(call), 1);
    call.done(call.answers as AgentAnswer[]);
  };

  return {
    ask(questions) {
      if (closed) return Promise.resolve(null);
      if (questions.length === 0) return Promise.resolve([]);
      return new Promise<AgentAnswer[] | null>((done) => {
        const cards = questions.map(askCardOf);
        const ids = cards.map((card) => store.insertAgentAsk(sessionId, { question: card.body, spec: card.spec }).id);
        calls.push({ ids, cards, answers: ids.map(() => undefined), done });
        changed(open());
      });
    },
    answer(askId, input) {
      const at = where(askId);
      if (!at || closed) throw new HttpError(422, "invalid_args", "ask is no longer pending");
      const card = at.call.cards[at.index]!;
      const answer = parseAskAnswer(card.spec, input.selected, input.custom, isoNow());
      const message = store.recordAgentAskAnswer(askId, answer);
      at.call.answers[at.index] = { selected: answer.selected.map((label) => card.labels.get(label) ?? label), custom: answer.custom };
      settle(at.call);
      changed(open());
      return message;
    },
    takeLine(message) {
      if (closed || message.kind !== "user" || message.author !== USER_MEMBER || message.attachments.length > 0) return false;
      const words = message.body.trim();
      const waiting = open();
      if (!words || waiting.length === 0) return false;
      const custom = clip(words, ASK_CUSTOM_MAX);
      for (const askId of waiting) {
        const at = where(askId);
        if (!at) continue;
        const answer = { selected: [], custom, answered_at: isoNow() };
        store.recordAgentAskAnswer(askId, answer);
        at.call.answers[at.index] = { selected: [], custom };
      }
      store.markLineTaken(message.id, "answer");
      for (const call of [...calls]) settle(call);
      changed(open());
      return true;
    },
    open,
    close() {
      closed = true;
      for (const call of calls.splice(0)) call.done(null);
    },
  };
}

/** An answer as one text: what you picked, then your words. */
export function answerText(answer: AgentAnswer, joiner = ", "): string {
  return [answer.selected.join(joiner), answer.custom ?? ""].filter(Boolean).join(joiner);
}
