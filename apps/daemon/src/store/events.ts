import type { ClientEvent, Judgement, Spend } from "@real-bot/protocol";
import { listApprovals, listAllowRules } from "./approvals";
import { listCredentialOperations } from "./credentials";
import { listMcpServers } from "./mcp";
import { listMemories, withLearning as memoryWithLearning } from "./memories";
import { getMessage } from "./messages";
import { getAnnotation, hasAnnotation } from "./annotations";
import { getNotification, getNotificationPolicy, getNotificationSummary } from "./notifications";
import { providersCached } from "./providers";
import { listRoutines } from "./routines";
import { listSessions } from "./sessions";
import { settingsCached } from "./settings";
import { listSkills, withLearning as skillWithLearning } from "./skills";
import { toBot, type BotRow, type StoreContext } from "./shared";
import { getTurn } from "./turns";

type Change = { entity: string; id: string; op: string; session_id: string | null };

/** TEMP triggers follow nested domain writes and roll back with the business transaction. */
export function installChangeJournal(ctx: StoreContext): void {
  ctx.db.exec(`CREATE TEMP TABLE event_changes (entity TEXT, id TEXT, op TEXT, session_id TEXT)`);
  const tables = ["settings", "bots", "sessions", "messages", "turns", "approvals", "mcp_servers", "providers", "skills", "memories", "routines", "allow_rules", "spend", "judgements", "notifications", "annotations"];
  for (const table of tables) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const row = op === "DELETE" ? "OLD" : "NEW";
      const id = table === "settings" ? "'settings'" : `${row}.id`;
      const session = ["messages", "turns", "spend", "judgements", "notifications", "annotations"].includes(table) ? `${row}.session_id` : "NULL";
      ctx.db.exec(`CREATE TEMP TRIGGER event_${table}_${op} AFTER ${op} ON main.${table}
        BEGIN INSERT INTO event_changes VALUES ('${table}', ${id}, '${op}', ${session}); END`);
    }
  }
  ctx.db.exec(`CREATE TEMP TRIGGER event_settings_rev AFTER UPDATE ON main.request_meta
    WHEN OLD.settings_rev != NEW.settings_rev
    BEGIN INSERT INTO event_changes VALUES ('settings', 'settings', 'UPDATE', NULL); END`);
  ctx.db.exec(`CREATE TEMP TRIGGER event_notification_policy AFTER UPDATE ON main.notification_policy
    BEGIN INSERT INTO event_changes VALUES ('notification_policy', 'notification_policy', 'UPDATE', NULL); END`);
  for (const op of ["INSERT", "UPDATE", "DELETE"]) {
    const row = op === "DELETE" ? "OLD" : "NEW";
    ctx.db.exec(`CREATE TEMP TRIGGER event_pending_keys_${op} AFTER ${op} ON main.pending_keys
      BEGIN INSERT INTO event_changes VALUES ('pending_keys', ${row}.name, '${op}', NULL); END`);
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
  for (const change of changes) {
    unique.set(`${change.entity}:${change.id}`, change);
    if (change.entity === "pending_keys") {
      const match = /^(endpoint-api-key|mcp-auth):(.+)$/.exec(change.id);
      if (match) {
        const entity = match[1] === "endpoint-api-key" ? "providers" : "mcp_servers";
        if (ctx.db.query(`SELECT 1 FROM ${entity} WHERE id = ?`).get(match[2]!)) {
          unique.set(`${entity}:${match[2]}`, { ...change, entity, id: match[2]! });
        }
      }
    }
  }
  if (changes.some((change) => change.entity === "pending_keys")) {
    out.push({ event: "credential_operations.changed", occurred_at, items: listCredentialOperations(ctx) });
  }
  const cleared = new Set(changes.filter((c) => c.entity === "messages" && c.op === "DELETE").map((c) => c.session_id!));
  for (const id of cleared) out.push({ event: "session.cleared", occurred_at, id });
  const sessions = listSessions(ctx);
  for (const { entity, id } of unique.values()) {
    switch (entity) {
      case "settings": break;
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
        if (ctx.db.query("SELECT id FROM messages WHERE id = ?").get(id)) {
          const inserted = changes.some((change) => change.entity === "messages" && change.id === id && change.op === "INSERT");
          out.push({ event: inserted ? "message.created" : "message.upsert", occurred_at, ...getMessage(ctx, id) });
        }
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
        const row = providersCached(ctx).find((r) => r.id === id);
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
        out.push(row ? { event: "skill.upsert", occurred_at, ...skillWithLearning(ctx, row) } : { event: "skill.removed", occurred_at, id });
        break;
      }
      case "memories": {
        const row = listMemories(ctx).find((r) => r.id === id);
        out.push(row ? { event: "memory.upsert", occurred_at, ...memoryWithLearning(ctx, row) } : { event: "memory.removed", occurred_at, id });
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
      case "annotations": {
        out.push(hasAnnotation(ctx, id) ? { event: "annotation.upsert", occurred_at, ...getAnnotation(ctx, id) } : { event: "annotation.removed", occurred_at, id });
        break;
      }
      case "notifications": {
        const item = getNotification(ctx, id);
        out.push(
          item
            ? { event: "notification.upsert", occurred_at, ...item }
            : { event: "notification.removed", occurred_at, id },
        );
        break;
      }
    }
  }
  if (changes.some((change) => change.entity === "notifications")) {
    out.push({ event: "notification.summary", occurred_at, summary: getNotificationSummary(ctx) });
  }
  if (changes.some((change) => change.entity === "notification_policy")) {
    out.push({ event: "notification_policy.changed", occurred_at, ...getNotificationPolicy(ctx) });
  }
  // Provider rows also determine default-model fields and wizard completion.
  if (changes.some((change) => change.entity === "settings" || change.entity === "providers")) {
    out.push({ event: "settings.changed", occurred_at, ...settingsCached(ctx) });
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
