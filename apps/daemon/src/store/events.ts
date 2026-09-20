import type { ClientEvent, Judgement, Spend } from "@real-bot/protocol";
import { listApprovals, listAllowRules } from "./approvals";
import { listMcpServers } from "./mcp";
import { listMemories } from "./memories";
import { getMessage } from "./messages";
import { listProvidersCached } from "./providers";
import { listRoutines } from "./routines";
import { listSessions } from "./sessions";
import { settingsCached } from "./settings";
import { listSkills } from "./skills";
import { toBot, type BotRow, type StoreContext } from "./shared";
import { getTurn } from "./turns";

type Change = { entity: string; id: string; op: string; session_id: string | null };

/** TEMP triggers follow nested domain writes and roll back with the business transaction. */
export function installChangeJournal(ctx: StoreContext): void {
  ctx.db.exec(`CREATE TEMP TABLE event_changes (entity TEXT, id TEXT, op TEXT, session_id TEXT)`);
  const tables = ["settings", "bots", "sessions", "messages", "turns", "approvals", "mcp_servers", "providers", "skills", "memories", "routines", "allow_rules", "spend", "judgements"];
  for (const table of tables) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const row = op === "DELETE" ? "OLD" : "NEW";
      const id = table === "settings" ? "'settings'" : `${row}.id`;
      const session = ["messages", "turns", "spend", "judgements"].includes(table) ? `${row}.session_id` : "NULL";
      ctx.db.exec(`CREATE TEMP TRIGGER event_${table}_${op} AFTER ${op} ON main.${table}
        BEGIN INSERT INTO event_changes VALUES ('${table}', ${id}, '${op}', ${session}); END`);
    }
  }
  for (const table of ["session_participants", "attachments", "reactions"]) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const row = op === "DELETE" ? "OLD" : "NEW";
      const entity = table === "session_participants" ? "sessions" : "messages";
      const id = table === "session_participants" ? `${row}.session_id` : `${row}.message_id`;
      ctx.db.exec(`CREATE TEMP TRIGGER event_${table}_${op} AFTER ${op} ON main.${table}
        BEGIN INSERT INTO event_changes VALUES ('${entity}', ${id}, 'UPDATE', NULL); END`);
    }
  }
}

export function committedEvents(ctx: StoreContext): ClientEvent[] {
  const changes = ctx.db.query<Change, []>("SELECT * FROM event_changes ORDER BY rowid").all();
  ctx.db.run("DELETE FROM event_changes");
  if (!changes.length) return [];
  const occurred_at = new Date().toISOString();
  const out: ClientEvent[] = [];
  const unique = new Map<string, Change>();
  for (const change of changes) unique.set(`${change.entity}:${change.id}`, change);
  const cleared = new Set(changes.filter((c) => c.entity === "messages" && c.op === "DELETE").map((c) => c.session_id!));
  for (const id of cleared) out.push({ event: "session.cleared", occurred_at, id });
  const sessions = listSessions(ctx);
  for (const { entity, id } of unique.values()) {
    switch (entity) {
      case "settings": out.push({ event: "settings.changed", occurred_at, ...settingsCached(ctx) }); break;
      case "bots": {
        const row = ctx.db.query<BotRow, [string]>("SELECT * FROM bots WHERE id = ?").get(id);
        if (row) out.push({ event: "bot.upsert", occurred_at, ...toBot(row), deleted_at: row.deleted_at });
        break;
      }
      case "sessions": {
        const row = sessions.find((s) => s.id === id);
        out.push(row ? { event: "session.upsert", occurred_at, ...row } : { event: "session.removed", occurred_at, id });
        break;
      }
      case "messages": {
        if (ctx.db.query("SELECT id FROM messages WHERE id = ?").get(id)) out.push({ event: "message.upsert", occurred_at, ...getMessage(ctx, id) });
        break;
      }
      case "turns": {
        if (ctx.db.query("SELECT id FROM turns WHERE id = ?").get(id)) out.push({ event: "turn.upsert", occurred_at, ...getTurn(ctx, id) });
        break;
      }
      case "approvals": {
        const row = listApprovals(ctx).find((r) => r.id === id);
        out.push(row ? { event: "approval.upsert", occurred_at, ...row } : { event: "approval.removed", occurred_at, id });
        break;
      }
      case "providers": {
        const row = listProvidersCached(ctx).find((r) => r.id === id);
        out.push(row ? { event: "provider.upsert", occurred_at, ...row } : { event: "provider.removed", occurred_at, id });
        break;
      }
      case "mcp_servers": {
        const row = listMcpServers(ctx).find((r) => r.id === id);
        out.push(row ? { event: "mcp.upsert", occurred_at, ...row } : { event: "mcp.removed", occurred_at, id });
        break;
      }
      case "skills": {
        const row = listSkills(ctx).find((r) => r.id === id);
        out.push(row ? { event: "skill.upsert", occurred_at, ...row } : { event: "skill.removed", occurred_at, id });
        break;
      }
      case "memories": {
        const row = listMemories(ctx).find((r) => r.id === id);
        out.push(row ? { event: "memory.upsert", occurred_at, ...row } : { event: "memory.removed", occurred_at, id });
        break;
      }
      case "routines": {
        const row = listRoutines(ctx).find((r) => r.id === id);
        out.push(row ? { event: "routine.upsert", occurred_at, ...row } : { event: "routine.removed", occurred_at, id });
        break;
      }
      case "allow_rules": {
        const row = listAllowRules(ctx).find((r) => r.id === id);
        out.push(row ? { event: "allow_rule.upsert", occurred_at, ...row } : { event: "allow_rule.removed", occurred_at, id });
        break;
      }
      case "spend": {
        const row = ctx.db.query<Spend, [string]>("SELECT * FROM spend WHERE id = ?").get(id);
        out.push(row ? { event: "spend.created", occurred_at, ...row } : { event: "spend.removed", occurred_at, id });
        break;
      }
      case "judgements": {
        const row = ctx.db.query<Judgement, [string]>("SELECT * FROM judgements WHERE id = ?").get(id);
        if (row) out.push({ event: "judgement.created", occurred_at, ...row });
        break;
      }
    }
  }
  // Deleting a Bot hides its directs even though the session rows remain.
  if (changes.some((c) => c.entity === "bots")) {
    const visible = new Set(sessions.map((s) => s.id));
    const rows = ctx.db.query<{ id: string }, []>("SELECT id FROM sessions").all();
    for (const { id } of rows) if (!visible.has(id)) out.push({ event: "session.removed", occurred_at, id });
  }
  // A message insert may share its timestamp with the previous write, so touchSession can be a no-op.
  for (const session of sessions) {
    if (changes.some((c) => c.entity === "messages" && c.session_id === session.id) && !unique.has(`sessions:${session.id}`)) {
      out.push({ event: "session.upsert", occurred_at, ...session });
    }
  }
  return out;
}
