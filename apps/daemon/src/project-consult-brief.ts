/**
 * The composer's consultant switch (ADR 0116 addendum 2026-11-23). While it is on, a line of yours
 * reaches the agent with a note after it, as annotations are spelled out after a line: ask each of
 * these consultants first, at once, each on its own, then give their views and your own. The note
 * names the consultant this session already has for each member, so a member goes on in the same
 * consultant from line to line and remembers what was said. Nothing of it is stored on your line.
 */
import { USER_MEMBER, type ConsultMember, type Message } from "@real-bot/protocol";
import { slashCommandOf } from "./project-runner";
import { AGENT_NAMES } from "./store/project-sessions";
import type { Store } from "./store";

/** A member as a line names it: the agent, then the model and the level when set. */
export function memberLabel(member: ConsultMember): string {
  return [AGENT_NAMES[member.agent], member.model, member.effort].filter(Boolean).join(" · ");
}

/** The note that goes after a line of yours while the switch is on; null when it is off, for a consultant, or for a command. */
export function consultBrief(store: Store, message: Message, en: boolean): string | null {
  if (message.kind !== "user" || message.author !== USER_MEMBER) return null;
  // A command (`/compact`) goes to the agent as typed; a line that starts with a path is no command.
  if (slashCommandOf(message.body)) return null;
  const project = store.projectOf(message.session_id);
  if (!project || project.parentId || !project.consult?.on || project.consult.members.length === 0) return null;
  // The session's consultant for each agent, model and level, the newest where there are several;
  // each goes to one member only, so two members never share a consultant.
  const key = (agent: string, model: string | null, effort: string | null) => `${agent}\n${model ?? ""}\n${effort ?? ""}`;
  const held = new Map<string, string>();
  for (const id of store.consultantsOf(message.session_id)) {
    const consultant = store.projectOf(id);
    if (consultant) held.set(key(consultant.agent, consultant.model, consultant.effort), id);
  }
  const given = new Set<string>();
  const lines = project.consult.members.map((member, index) => {
    const found = held.get(key(member.agent, member.model, member.effort));
    const id = found && !given.has(found) ? found : undefined;
    if (id) given.add(id);
    const how = id
      ? `consultant=${id}`
      : [`agent=${member.agent}`, member.model ? `model=${member.model}` : null, member.effort ? `effort=${member.effort}` : null].filter(Boolean).join(", ");
    return en
      ? `${index + 1}. ${memberLabel(member)} — ${id ? "go on with" : "ask anew:"} ${how}`
      : `${index + 1}. ${memberLabel(member)} —— ${id ? "接着用" : "新请："} ${how}`;
  });
  return en
    ? [
      "[Consultants on] The user turned the consultant switch on: before you answer this line, use the consult tool to ask each consultant below at the same time, each on its own, about what this line is about. They cannot see this conversation, so put the context they need in message.",
      ...lines,
      "Once they have answered, give each one's view in turn, then your own view and conclusion.",
    ].join("\n")
    : [
      "[参谋开着] 用户在输入框里打开了参谋：回答这句话之前，先用 consult 工具同时请下面每一位参谋，各自就这句话说的事给意见。他们看不到这段对话，把需要的上下文写进 message。",
      ...lines,
      "都答完后，先分别写出每位参谋的意见，再给出你自己的看法和结论。",
    ].join("\n");
}
