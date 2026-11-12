/**
 * A project session out of usage (ADR 0110): what moving it to another of your Claude accounts
 * does, and what it says. Moving is what picking another account in the composer does (ADR 0095,
 * decision 10): Claude Code finds a session to resume only under the account's own directory, so the
 * session's file goes there first, and the session's account follows it — replay, task details and
 * paths read the transcript through it. A session the new account cannot find starts afresh there.
 */
import type { Locale, Message } from "@real-bot/protocol";
import { carryClaudeSession, claudeSessionRoots } from "./claude-code/sessions";
import type { Store } from "./store";

type Project = NonNullable<ReturnType<Store["projectOf"]>>;

/** Moves a project session to `to` (null: the daemon's own environment). Its run must have ended. */
export function moveProjectAccount(store: Store, sessionId: string, project: Project, to: string | null): void {
  const roots = claudeSessionRoots(store.claudeCodeConfigDirs());
  const from = roots.find((root) => root.configDir === project.configDir) ?? roots[0]!;
  const target = roots.find((root) => root.configDir === to) ?? roots[0]!;
  if (project.source) carryClaudeSession(from, target, project.source);
  // Never written where it was (a run that failed before Claude Code kept anything): nothing to resume there either.
  if (project.agentSession && !carryClaudeSession(from, target, project.agentSession)) store.recordProjectAgentSession(sessionId, null);
  store.tuneProjectSession(sessionId, { configDir: to });
}

/** How long a run waits for the Claude Code before it to exit before its session is copied. */
export const EXIT_WAIT_MS = 5_000;

/** The line a session moved by itself says: which account ran out, until when, and where it goes on. */
export function switchedLine(locale: Locale, from: string, to: string, reset: string | null): string {
  return locale === "en"
    ? `Claude account ${from} is out of usage${reset ? ` (${reset})` : ""}; this session goes on on ${to}.`
    : `Claude 账号 ${from} 的用量额度用完了${reset ? `（${reset}）` : ""}，这个会话换到 ${to} 接着做。`;
}

/** The line a session out of usage on every account says; `detail` names the reset and when it picks up. */
export function outOfUsageLine(locale: Locale, detail: string, agent = "Claude"): string {
  return locale === "en" ? `${agent} usage limit reached (${detail})` : `${agent} 的用量额度用完了（${detail}）`;
}

const QUOTE_MAX = 600;

function clip(text: string): string {
  const flat = text.trim();
  const points = [...flat];
  return points.length > QUOTE_MAX ? `${points.slice(0, QUOTE_MAX).join("")}…` : flat;
}

/**
 * What a run the app starts says to Claude Code: the request before was turned away by the plan's
 * limit, and now it can go on — on another account, or with the limit over. The lines of yours it
 * had not answered are quoted, in case the one turned away was never kept; what ran in the
 * background ended with that run.
 */
export function continueNote(locale: Locale, why: "switched" | "reset", unanswered: readonly Message[], agent = "Claude"): string {
  const en = locale === "en";
  const head = en
    ? `(Deskfolk) Your last request was turned away because the ${agent} account's usage limit was reached, and the work stopped there. ${why === "switched" ? "The session has moved to another of the user's accounts" : "The limit is over now"}: carry on with what was left unfinished, without redoing what is done. Anything you ran in the background ended with that run; start it again if it is still needed.`
    : `（Deskfolk）刚才的请求因为 ${agent} 账号的用量额度用完被拒了，工作停在了那里。${why === "switched" ? "现在会话换到了用户的另一个账号" : "现在额度恢复了"}：接着做没做完的事，已经做完的不要重做。之前在后台跑的任务随上一轮一起结束了，还需要的话重新开。`;
  const quoted = unanswered.map((message) => clip(message.body)).filter(Boolean);
  if (quoted.length === 0) return head;
  return [head, en ? "What the user said that you had not answered yet:" : "用户说了、你还没回复的话：", ...quoted.map((text) => (en ? `"${text}"` : `「${text}」`))].join("\n");
}
