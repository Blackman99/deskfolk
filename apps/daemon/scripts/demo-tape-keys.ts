/**
 * How demo-tape keys a model call, so a replay answers it with the reply the shoot recorded: a
 * Bot's turn by its name, and each of the app's side calls by its kind (told apart by how its
 * system prompt starts) plus, where calls can arrive in either order, what pins it to one moment of
 * the story. demo-tape adds the call's order within the key on top.
 */

export const SIDE_CALLS: [string, string][] = [
  ["你正在做一次判断", "judge"],
  ["你在为一条刚到的消息挑模型", "route"],
  ["你在替这个会话整理", "organizer"],
  ["你是书记员", "scribe"],
  ["你在替一个 Bot 做收尾自检", "closing"],
  ["你在复盘一次模型选择", "review"],
  ["你在替这个 Bot 记下一条", "learn"],
  ["你在给用户写下一步", "composer"],
  // Reading a line (ADR 0055, 0057): your line, a Bot's line, and which job your line is about.
  ["你在替一个多 Bot 协作应用读用户说的一句话", "read_user"],
  ["你在替一个多 Bot 协作应用读一个 Bot 发出的一条消息", "read_bot"],
  ["你在替一个多 Bot 协作应用判断用户刚说的一句话是在说哪件事", "read_filing"],
  // Whether a job is large, to be laid out with a sample first (ADR 0060).
  ["你在替一个多 Bot 协作应用判断用户交代的一件事是不是「大活」", "read_scale"],
  // The narrowed reflection after a wrongful approval or a capability ceiling (ADR 0051).
  ["你在回看自己出了问题的一张任务", "reflect"],
];

export type ChatBody = { stream?: boolean; messages?: { role: string; content: unknown }[] };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && "text" in p ? String(p.text) : "")).join("\n");
  return "";
}

export function classify(body: ChatBody): string {
  const system = textOf(body.messages?.find((m) => m.role === "system")?.content);
  const user = textOf(body.messages?.find((m) => m.role === "user")?.content);
  if (body.stream) {
    const name = system.match(/# (?:人设|Profile)\n\n## (?:名字|Name)\n\n([^\n]+)/)?.[1];
    return `turn:${name ?? "?"}`;
  }
  const kind = SIDE_CALLS.find(([prefix]) => system.startsWith(prefix))?.[1] ?? "other";
  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(user);
  } catch {
    // not JSON
  }
  if (kind === "judge") return `judge:${payload.you?.name ?? "?"}`;
  if (kind === "route" || kind === "review") return `${kind}:${payload.bot?.name ?? "?"}`;
  if (kind === "organizer") return `organizer:${payload.mode ?? "?"}:${payload.session?.name ?? "?"}`;
  // The scribe runs after each line's turns have started, so it is matched by the line it reads.
  if (kind === "scribe") return `scribe:${digest(normalize(String(payload.said?.body ?? "")))}`;
  // Bots can finish in either order, so a closing check is matched by the reply it checks.
  if (kind === "closing") return `closing:${digest(normalize(String(payload.reply ?? "")))}`;
  // A line is read once, while turns and other readings run beside it: matched by the line itself.
  // Your line is read twice over (what it means, and which job it is about), so the kind stays in.
  if (kind === "read_user" || kind === "read_bot" || kind === "read_filing") return `${kind}:${digest(normalize(String(payload.said ?? "")))}`;
  // A job's size is read from your lines about it, again as segments go by: matched by those lines.
  if (kind === "read_scale") return `read_scale:${digest(normalize(JSON.stringify(payload.said ?? [])))}`;
  if (kind === "reflect") return `reflect:${digest(normalize(String(payload.ticket ?? "")))}`;
  return kind;
}

/** A reply with its run-specific ids and work dirs blanked, so both runs read the same. */
export function normalize(s: string): string {
  return s.replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "#").replace(/(work\/[^\s"'`\\/]+)-[0-9a-z]{4,26}/g, "$1-#");
}

export function digest(s: string): string {
  return new Bun.CryptoHasher("sha1").update(s).digest("hex").slice(0, 12);
}
