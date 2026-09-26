import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { USER_MEMBER, type SearchHit } from "@real-bot/protocol";
import { listBots } from "./bots";
import { notCheckBackLine } from "./check-backs";
import { listRoutines } from "./routines";
import { listParticipants, listSessions } from "./sessions";
import { requireNonEmpty, sessionRow, sessionSearchTitle, workspacePath, type StoreContext } from "./shared";

export function search(ctx: StoreContext, q: string): SearchHit[] {
  const needle = requireNonEmpty("q", q).toLowerCase();
  const botNames = new Map(
    ctx.db
      .query<{ id: string; name: string }, []>(`SELECT id, name FROM bots`)
      .all()
      .map((row) => [row.id, row.name] as const),
  );
  const sessions = listSessions(ctx);
  const titles = new Map<string, string>();
  const youBotByPeer = new Map<string, string>();
  for (const session of sessions) {
    titles.set(session.id, sessionSearchTitle(session, session.participants, botNames));
    if (session.kind !== "direct") continue;
    const active = session.participants.filter((p) => p.left_at === null).map((p) => p.member);
    if (!active.includes(USER_MEMBER)) continue;
    const peer = active.find((member) => member !== USER_MEMBER);
    if (peer) youBotByPeer.set(peer, session.id);
  }
  const titleFor = (sessionId: string): string => {
    const cached = titles.get(sessionId);
    if (cached !== undefined) return cached;
    try {
      const session = sessionRow(ctx, sessionId);
      const title = sessionSearchTitle(session, listParticipants(ctx, sessionId), botNames);
      titles.set(sessionId, title);
      return title;
    } catch {
      return "";
    }
  };
  const bots = listBots(ctx)
    .filter((b) => `${b.name} ${b.duties} ${b.boundaries}`.toLowerCase().includes(needle))
    .map((b) => {
      const sessionId = youBotByPeer.get(b.id);
      return {
        kind: "bot" as const,
        id: b.id,
        snippet: b.duties ? b.duties : b.name,
        session_id: sessionId,
        session_title: b.name,
        avatar: b.avatar ?? null,
      };
    });
  const sessionHits = sessions
    .filter((s) => (s.name ?? "").toLowerCase().includes(needle))
    .map((s) => ({
      kind: "session" as const,
      id: s.id,
      snippet: s.name ?? (titleFor(s.id) || s.kind),
      session_id: s.id,
      session_title: titleFor(s.id) || s.name || s.kind,
    }));
  const messages = ctx.db
    .query<{ id: string; session_id: string; parent_id: string | null; body: string }, []>(
      `SELECT id, session_id, parent_id, body FROM messages WHERE kind != 'profile_change' AND ${notCheckBackLine()}`,
    )
    .all()
    .filter((m) => m.body.toLowerCase().includes(needle))
    .map((m) => ({
      kind: "message" as const,
      id: m.id,
      snippet: m.body.slice(0, 160),
      session_id: m.session_id,
      session_title: titleFor(m.session_id),
      parent_id: m.parent_id,
    }));
  const routines = listRoutines(ctx)
    .filter((r) => `${r.title} ${r.instruction}`.toLowerCase().includes(needle))
    .map((r) => ({ kind: "routine" as const, id: r.id, snippet: r.title }));
  const files = searchWorkspaceFiles(ctx, needle);
  return [...bots, ...sessionHits, ...messages, ...routines, ...files];
}

export function searchWorkspaceFiles(
  ctx: StoreContext,
  needle: string,
): Array<{ kind: "file"; path: string; snippet: string }> {
  const root = workspacePath(ctx);
  if (!root) return [];
  const hits: Array<{ kind: "file"; path: string; snippet: string }> = [];
  const walk = (abs: string, rel: string, depth: number) => {
    if (hits.length >= 40 || depth > 8) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (hits.length >= 40) return;
      if (name === ".git" || name === "node_modules" || name === ".DS_Store") continue;
      if (name.startsWith(".") && name !== ".env") continue;
      const childAbs = join(abs, name);
      const childRel = rel === "." ? name : `${rel}/${name}`;
      let st;
      try {
        st = statSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (childRel.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)) {
        hits.push({ kind: "file", path: childRel, snippet: childRel });
      }
    }
  };
  walk(root, ".", 0);
  return hits;
}
