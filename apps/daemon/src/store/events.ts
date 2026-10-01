import type { ClientEvent, Judgement, Spend, Ticket } from "@real-bot/protocol";
import { listApprovals, listAllowRules } from "./approvals";
import { isBotOnlyLine } from "./check-backs";
import { taskDetail } from "./plan-spec";
import { listCredentialOperations } from "./credentials";
import { listMcpServers } from "./mcp";
import { listMemories, withLearning as memoryWithLearning } from "./memories";
import { citedPathExists, getMessage } from "./messages";
import { FileProbe, getAnnotation, hasAnnotation } from "./annotations";
import { getNotification, getNotificationPolicy, getNotificationSummary } from "./notifications";
import { providersCached } from "./providers";
import { listRoutines } from "./routines";
import { listSessions } from "./sessions";
import { settingsCached } from "./settings";
import { listSkills, withLearning as skillWithLearning } from "./skills";
import { toBot, type BotRow, type StoreContext } from "./shared";
import { getTurn } from "./turns";
import { getHold } from "./holds";
import { GATE_SETTING_KEYS } from "./schema-gate";
import { groupLeadState } from "./group-leads";
import { getDelegationView } from "./delegation-view";

type Change = { entity: string; id: string; op: string; session_id: string | null };

/** TEMP triggers follow nested domain writes and roll back with the business transaction. */
export function installChangeJournal(ctx: StoreContext): void {
  ctx.db.exec(`CREATE TEMP TABLE event_changes (entity TEXT, id TEXT, op TEXT, session_id TEXT)`);
  const tables = ["settings", "bots", "sessions", "messages", "turns", "approvals", "mcp_servers", "providers", "skills", "memories", "routines", "allow_rules", "spend", "judgements", "notifications", "annotations", "tasks", "tickets", "holds"];
  for (const table of tables) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      if (table === "spend" && op === "UPDATE") continue;
      const row = op === "DELETE" ? "OLD" : "NEW";
      const id = table === "settings" ? "'settings'" : `${row}.id`;
      // The version gate's rows are not settings anyone edits (see GATE_SETTING_KEYS).
      const when = table === "settings" ? ` WHEN ${row}.key NOT IN (${GATE_SETTING_KEYS.map((key) => `'${key}'`).join(", ")})` : "";
      // A ticket's "session" slot carries its plan, so a removed ticket can still say which board it left.
      const session = ["messages", "turns", "spend", "judgements", "notifications", "annotations", "tasks"].includes(table)
        ? `${row}.session_id`
        : table === "tickets"
          ? `${row}.task_id`
          : "NULL";
      ctx.db.exec(`CREATE TEMP TRIGGER event_${table}_${op} AFTER ${op} ON main.${table}${when}
        BEGIN INSERT INTO event_changes VALUES ('${table}', ${id}, '${op}', ${session}); END`);
    }
  }
  // A spend row is only ever updated by a re-price, which rewrites many rows at once: one change, not one per row.
  ctx.db.exec(`CREATE TEMP TRIGGER event_spend_UPDATE AFTER UPDATE ON main.spend
    BEGIN INSERT INTO event_changes VALUES ('spend_repriced', 'spend', 'UPDATE', NULL); END`);
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
  // Acceptance checks have no event of their own: a change to either table is a change to the
  // plan that holds it, so `TaskDetail.checks` carries it through the plan's own `task.upsert`.
  for (const table of ["acceptance_checks", "acceptance_check_runs"]) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      const row = op === "DELETE" ? "OLD" : "NEW";
      ctx.db.exec(`CREATE TEMP TRIGGER event_${table}_${op} AFTER ${op} ON main.${table}
        BEGIN INSERT INTO event_changes VALUES ('tasks', ${row}.task_id, 'UPDATE', ${row}.task_id); END`);
    }
  }
  // The requirements ledger has no event of its own either (ADR 0040 P3): an entry changing is a
  // change to the boards that show it — the plan it was said in, the plan or ticket it holds for,
  // and for one of a whole conversation, that conversation's open plans — carried by `task.upsert`
  // in `TaskDetail.requirements`. A standing entry reaches the others when they are next read.
  for (const op of ["INSERT", "UPDATE"]) {
    ctx.db.exec(`CREATE TEMP TRIGGER event_requirements_${op} AFTER ${op} ON main.requirements
      BEGIN
        INSERT INTO event_changes SELECT 'tasks', id, 'UPDATE', id FROM main.tasks
        WHERE id = NEW.origin_task_id
          OR (NEW.scope = 'plan' AND id = NEW.scope_id)
          OR (NEW.scope = 'ticket' AND id = (SELECT task_id FROM main.tickets WHERE tickets.id = NEW.scope_id))
          OR (NEW.scope = 'project' AND session_id = NEW.scope_id AND closed_at IS NULL);
      END`);
  }
  for (const op of ["INSERT", "DELETE"]) {
    const row = op === "DELETE" ? "OLD" : "NEW";
    ctx.db.exec(`CREATE TEMP TRIGGER event_requirement_exclusions_${op} AFTER ${op} ON main.requirement_exclusions
      BEGIN INSERT INTO event_changes VALUES ('tasks', ${row}.task_id, 'UPDATE', ${row}.task_id); END`);
  }
  // Handoffs and their event waits change independently of the thread's ordinary transcript.
  for (const op of ["INSERT", "UPDATE"]) {
    ctx.db.exec(`CREATE TEMP TRIGGER event_delegations_${op} AFTER ${op} ON main.delegations
      BEGIN
        INSERT INTO event_changes VALUES ('delegation', NEW.id, '${op}', NEW.thread_session_id);
        INSERT INTO event_changes VALUES ('tasks', NEW.task_id, 'UPDATE', NULL);
        INSERT INTO event_changes VALUES ('sessions', NEW.thread_session_id, 'UPDATE', NEW.thread_session_id);
      END`);
    ctx.db.exec(`CREATE TEMP TRIGGER event_delegation_wait_${op} AFTER ${op} ON main.check_backs
      WHEN NEW.kind = 'delegation_wait'
      BEGIN INSERT INTO event_changes SELECT 'delegation', id, 'UPDATE', thread_session_id FROM main.delegations
        WHERE id = json_extract(NEW.wait_spec, '$.ref'); END`);
    ctx.db.exec(`CREATE TEMP TRIGGER event_delegation_inbox_${op} AFTER ${op} ON main.inbox_items
      WHEN NEW.source IN ('delegation', 'delegation_reply')
      BEGIN INSERT INTO event_changes SELECT 'delegation', id, 'UPDATE', thread_session_id FROM main.delegations
        WHERE request_inbox_seq = NEW.seq OR result_inbox_seq = NEW.seq; END`);
  }
  // Confirmation eligibility changes independently of the flag: a departed/archived/deleted Bot
  // must disappear from every client's cached confirmation, without a noisy reload per message.
  ctx.db.exec(`CREATE TEMP TRIGGER event_group_lead_participant_UPDATE AFTER UPDATE ON main.session_participants
    WHEN OLD.is_lead <> NEW.is_lead OR (OLD.is_lead = 1 AND OLD.left_at IS NOT NEW.left_at)
    BEGIN INSERT INTO event_changes VALUES ('group_lead', NEW.session_id, 'UPDATE', NEW.session_id); END`);
  ctx.db.exec(`CREATE TEMP TRIGGER event_group_lead_participant_DELETE AFTER DELETE ON main.session_participants
    WHEN OLD.is_lead = 1
    BEGIN INSERT INTO event_changes VALUES ('group_lead', OLD.session_id, 'UPDATE', OLD.session_id); END`);
  ctx.db.exec(`CREATE TEMP TRIGGER event_group_lead_bot_UPDATE AFTER UPDATE ON main.bots
    WHEN OLD.deleted_at IS NOT NEW.deleted_at OR OLD.archived_at IS NOT NEW.archived_at
    BEGIN INSERT INTO event_changes SELECT 'group_lead', session_id, 'UPDATE', session_id
      FROM main.session_participants WHERE member = NEW.id AND is_lead = 1; END`);
  ctx.db.exec(`CREATE TEMP TRIGGER event_group_lead_INSERT AFTER INSERT ON main.work_events
    WHEN NEW.kind = 'group_lead.confirmed' AND NEW.session_id IS NOT NULL
    BEGIN INSERT INTO event_changes VALUES ('group_lead', NEW.session_id, 'UPDATE', NEW.session_id); END`);
  // Corrections are projected at commit from the authoritative message, including remote catch-up.
  ctx.db.exec(`CREATE TEMP TRIGGER event_work_attribution_INSERT AFTER INSERT ON main.work_events
    WHEN NEW.kind = 'attribution.changed'
    BEGIN
      INSERT INTO event_changes VALUES ('attribution', json_extract(NEW.payload, '$.message'), 'UPDATE', NEW.session_id);
      INSERT INTO event_changes SELECT 'tasks', json_extract(value, '$.taskId'), 'UPDATE', NULL
        FROM json_each(NEW.payload, '$.before') WHERE json_extract(value, '$.taskId') IS NOT NULL;
      INSERT INTO event_changes SELECT 'tasks', json_extract(value, '$.taskId'), 'UPDATE', NULL
        FROM json_each(NEW.payload, '$.after') WHERE json_extract(value, '$.taskId') IS NOT NULL;
    END`);
  // Nor has the inbox (ADR 0040 P4a): where a line of yours stands in a working Bot's inbox is part
  // of the line (`Message.delivery`), so each change to it is a `message.upsert` of that line.
  for (const op of ["INSERT", "UPDATE"]) {
    ctx.db.exec(`CREATE TEMP TRIGGER event_inbox_items_${op} AFTER ${op} ON main.inbox_items
      WHEN NEW.message_id IS NOT NULL AND NEW.source IN ('user', 'annotation')
      BEGIN INSERT INTO event_changes VALUES ('messages', NEW.message_id, 'UPDATE', NULL); END`);
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
  // One look at each annotated file per pass, however many of its annotations changed.
  let probe: FileProbe | undefined;
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
      case "delegation": {
        const delegation = getDelegationView(ctx, id);
        if (delegation) out.push({ event: "delegation.changed", occurred_at, ...delegation });
        break;
      }
      case "group_lead": {
        if (sessions.some((session) => session.id === id && session.kind === "group")) {
          out.push({ event: "group_lead.changed", occurred_at, ...groupLeadState(ctx, id) });
        }
        break;
      }
      case "attribution": {
        if (ctx.db.query("SELECT id FROM messages WHERE id = ?").get(id) && !isBotOnlyLine(ctx, id)) {
          const message = getMessage(ctx, id);
          out.push({ event: "attribution.changed", occurred_at, message_id: id, session_id: message.session_id,
            filing_state: message.filing_state ?? "none", filings: message.filings ?? [] });
        }
        break;
      }
      case "messages": {
        if (ctx.db.query("SELECT id FROM messages WHERE id = ?").get(id) && !isBotOnlyLine(ctx, id)) {
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
      case "spend_repriced": {
        out.push({ event: "spend.repriced", occurred_at });
        break;
      }
      case "judgements": {
        const row = ctx.db.query<Judgement, [string]>("SELECT * FROM judgements WHERE id = ?").get(id);
        if (row) out.push({ event: "judgement.created", occurred_at, ...row });
        break;
      }
      case "annotations": {
        out.push(hasAnnotation(ctx, id) ? { event: "annotation.upsert", occurred_at, ...getAnnotation(ctx, id, (probe ??= new FileProbe(ctx))) } : { event: "annotation.removed", occurred_at, id });
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
      case "tasks": {
        if (ctx.db.query("SELECT id FROM tasks WHERE id = ?").get(id)) {
          out.push({ event: "task.upsert", occurred_at, ...taskDetail(ctx, id, (path) => citedPathExists(ctx, path)) });
        } else {
          out.push({ event: "task.removed", occurred_at, id });
        }
        break;
      }
      case "holds": {
        // Never deleted, so a change is always one to publish.
        if (ctx.db.query("SELECT 1 FROM holds WHERE id = ?").get(id)) out.push({ event: "hold.upsert", occurred_at, ...getHold(ctx, id) });
        break;
      }
      case "tickets": {
        const row = ctx.db.query<Ticket, [string]>("SELECT * FROM tickets WHERE id = ?").get(id);
        const change = unique.get(`tickets:${id}`);
        out.push(
          row
            ? { event: "ticket.upsert", occurred_at, ...row }
            : { event: "ticket.removed", occurred_at, id, task_id: change?.session_id ?? "" },
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
