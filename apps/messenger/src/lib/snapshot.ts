import {
  INTERRUPT_NOTE_BODY,
  USER_MEMBER,
  isHiddenTranscriptKind,
  type Approval,
  type AllowRule,
  type Routine,
  type RuntimeSnapshot,
  type Bot,
  type ClientEvent,
  type CredentialOperation,
  type Judgement,
  type McpServer,
  type Memory,
  type Message,
  type Provider,
  type PendingJudgement,
  type SearchHit,
  type SessionSummary,
  type Settings,
  type Skill,
  type Turn,
} from "@real-bot/protocol";

export type Snapshot = {
  credentialOperations: CredentialOperation[];
  settings: Settings;
  bots: Bot[];
  sessions: SessionSummary[];
  mcpServers: McpServer[];
  providers: Provider[];
  skills: Skill[];
  memories: Memory[];
  routines: Routine[];
  allowRules: AllowRule[];
  messages: Message[];
  turns: Turn[];
  judgements: Judgement[];
  pendingJudgements: PendingJudgement[];
  approvals: Approval[];
  searchHits: SearchHit[];
};

export function emptySnapshot(): Snapshot {
  return {
    settings: {
      workspace_path: null,
      endpoint_base_url: null,
      endpoint_key_set: false,
      endpoint_models: [],
      endpoint_model_catalog: [],
      endpoint_default_model: null,
      default_provider_id: null,
      launch_at_login: true,
      locale: "zh",
      theme: "system",
      wizard_complete: false,
    },
    credentialOperations: [],
    bots: [],
    sessions: [],
    mcpServers: [],
    providers: [],
    skills: [],
    memories: [],
    routines: [],
    allowRules: [],
    messages: [],
    turns: [],
    judgements: [],
    pendingJudgements: [],
    approvals: [],
    searchHits: [],
  };
}

export function fromRuntimeSnapshot(snapshot: RuntimeSnapshot): Snapshot {
  return {
    ...emptySnapshot(), ...snapshot,
    messages: snapshot.sessions.flatMap((session) => session.last_message ? [session.last_message] : []),
    turns: snapshot.sessions.flatMap((session) => session.live_turns ?? []),
    pendingJudgements: snapshot.sessions.flatMap((session) => session.pending_judgements ?? []),
  };
}

export function applyEvent(snapshot: Snapshot, event: ClientEvent): Snapshot {
  switch (event.event) {
    case "credential_operations.changed": return { ...snapshot, credentialOperations: event.items };
    case "settings.changed": {
      const { event: _e, occurred_at: _at, ...settings } = event;
      return { ...snapshot, settings };
    }
    case "bot.upsert": {
      const { event: _e, occurred_at: _at, deleted_at, ...bot } = event;
      if (deleted_at) return { ...snapshot, bots: snapshot.bots.filter((b) => b.id !== bot.id) };
      return { ...snapshot, bots: upsert(snapshot.bots, bot) };
    }
    case "session.upsert": {
      const { event: _e, occurred_at: _at, ...session } = event;
      const existing = snapshot.sessions.find((s) => s.id === session.id);
      const merged: SessionSummary = {
        ...session,
        last_read_at:
          session.last_read_at !== undefined ? session.last_read_at : (existing?.last_read_at ?? null),
        archived_at:
          session.archived_at !== undefined ? session.archived_at : (existing?.archived_at ?? null),
        origin_session_id:
          session.origin_session_id !== undefined
            ? session.origin_session_id
            : (existing?.origin_session_id ?? null),
        origin_message_id:
          session.origin_message_id !== undefined
            ? session.origin_message_id
            : (existing?.origin_message_id ?? null),
        unread_count:
          session.unread_count !== undefined ? session.unread_count : (existing?.unread_count ?? 0),
        last_message: (() => {
          const incoming =
            session.last_message !== undefined ? session.last_message : (existing?.last_message ?? null);
          return incoming && isHiddenTranscriptKind(incoming.kind) ? null : incoming;
        })(),
        live_turns: session.live_turns !== undefined ? session.live_turns : (existing?.live_turns ?? []),
        pending_judgements:
          session.pending_judgements !== undefined
            ? session.pending_judgements
            : (existing?.pending_judgements ?? []),
        notification_preference:
          session.notification_preference !== undefined
            ? session.notification_preference
            : existing?.notification_preference,
      };
      return {
        ...snapshot,
        sessions: upsert(snapshot.sessions, merged),
      };
    }
    case "session.removed": {
      return {
        ...snapshot,
        sessions: snapshot.sessions.filter((s) => s.id !== event.id),
        messages: snapshot.messages.filter((m) => m.session_id !== event.id),
        turns: snapshot.turns.filter((t) => t.session_id !== event.id),
        judgements: snapshot.judgements.filter((j) => j.session_id !== event.id),
        pendingJudgements: snapshot.pendingJudgements.filter((j) => j.session_id !== event.id),
      };
    }
    case "session.cleared": {
      return {
        ...snapshot,
        sessions: snapshot.sessions.map((s) =>
          s.id === event.id ? { ...s, last_message: null, live_turns: [], unread_count: 0 } : s,
        ),
        messages: snapshot.messages.filter((m) => m.session_id !== event.id),
        turns: snapshot.turns.filter((t) => t.session_id !== event.id),
        judgements: snapshot.judgements.filter((j) => j.session_id !== event.id),
        pendingJudgements: snapshot.pendingJudgements.filter((j) => j.session_id !== event.id),
      };
    }
    case "message.upsert": {
      const { event: _e, occurred_at: _at, ...message } = event;
      if (isHiddenTranscriptKind(message.kind)) return snapshot;
      return {
        ...snapshot,
        messages: upsert(snapshot.messages, message),
        sessions: snapshot.sessions.map((s) => s.last_message?.id === message.id ? { ...s, last_message: message } : s),
      };
    }
    case "message.created": {
      const { event: _e, occurred_at: _at, ...message } = event;
      if (isHiddenTranscriptKind(message.kind)) return snapshot;
      if (snapshot.messages.some((m) => m.id === message.id)) return snapshot;
      const sessions = snapshot.sessions.map((s) =>
        s.id === message.session_id
          ? {
              ...s,
              last_message: message,
              unread_count:
                message.author === USER_MEMBER
                  ? (s.unread_count ?? 0)
                  : (s.unread_count ?? 0) + 1,
            }
          : s,
      );
      return { ...snapshot, messages: [...snapshot.messages, message], sessions };
    }
    case "turn.upsert": {
      const { event: _e, occurred_at: _at, ...turn } = event;
      const voidApprovals = turn.status === "stopped" || turn.status === "redirected" || turn.status === "interrupted";
      return {
        ...snapshot,
        turns: upsert(snapshot.turns, turn),
        messages: snapshot.messages.map((message) =>
          message.id === turn.trigger_message_id &&
          message.kind === "system" &&
          message.body === INTERRUPT_NOTE_BODY &&
          !message.source_turn_id
            ? { ...message, source_turn_id: turn.id }
            : message,
        ),
        approvals: voidApprovals
          ? snapshot.approvals.map((approval) =>
              approval.turn_id === turn.id && approval.status === "pending"
                ? { ...approval, status: "voided", resolved_at: turn.updated_at }
                : approval,
            )
          : snapshot.approvals,
      };
    }
    case "turn.token": {
      return {
        ...snapshot,
        turns: snapshot.turns.map((turn) =>
          turn.id === event.turn_id
            ? { ...turn, partial_text: `${turn.partial_text ?? ""}${event.text}` }
            : turn,
        ),
      };
    }
    // Usage is not kept on the client: nothing shows it, and on a phone it was most of every
    // snapshot. A view that needs it asks `GET /v1/spend` when it opens.
    case "spend.created":
    case "spend.removed":
      return snapshot;
    case "judgement.started": {
      const { event: _e, occurred_at: _at, ...row } = event;
      if (snapshot.pendingJudgements.some((j) => j.id === row.id)) return snapshot;
      return { ...snapshot, pendingJudgements: [...snapshot.pendingJudgements, row] };
    }
    case "judgement.created": {
      const { event: _e, occurred_at: _at, ...row } = event;
      return {
        ...snapshot,
        pendingJudgements: snapshot.pendingJudgements.filter(
          (j) => !(j.session_id === row.session_id && j.message_id === row.message_id && j.bot_id === row.bot_id),
        ),
        judgements: snapshot.judgements.some((j) => j.id === row.id)
          ? snapshot.judgements
          : [...snapshot.judgements, row],
      };
    }
    case "judgement.ended": {
      return {
        ...snapshot,
        pendingJudgements: snapshot.pendingJudgements.filter((j) => j.id !== event.id),
      };
    }
    case "approval.removed":
      return { ...snapshot, approvals: snapshot.approvals.filter((row) => row.id !== event.id) };
    case "approval.upsert": {
      const { event: _e, occurred_at: _at, ...row } = event;
      return {
        ...snapshot,
        approvals: upsert(snapshot.approvals, row),
      };
    }
    case "mcp.upsert": {
      const { event: _e, occurred_at: _at, ...row } = event;
      return {
        ...snapshot,
        mcpServers: upsert(snapshot.mcpServers, row).sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        ),
      };
    }
    case "mcp.removed": {
      return {
        ...snapshot,
        mcpServers: snapshot.mcpServers.filter((s) => s.id !== event.id),
      };
    }
    case "provider.upsert": {
      const { event: _e, occurred_at: _at, ...row } = event;
      return {
        ...snapshot,
        providers: upsert(snapshot.providers, row).sort(
          (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
        ),
      };
    }
    case "provider.removed": {
      return {
        ...snapshot,
        providers: snapshot.providers.filter((s) => s.id !== event.id),
      };
    }
    case "skill.upsert": {
      const { event: _e, occurred_at: _at, ...row } = event;
      return {
        ...snapshot,
        skills: upsert(snapshot.skills, row).sort(
          (a, b) =>
            a.bot_id.localeCompare(b.bot_id) ||
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
            a.id.localeCompare(b.id),
        ),
      };
    }
    case "memory.upsert": {
      const { event: _e, occurred_at: _at, ...row } = event;
      // Newest first: the pane is scanned for what the Bot just learned, not browsed A-Z.
      return {
        ...snapshot,
        memories: upsert(snapshot.memories, row).sort(
          (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id),
        ),
      };
    }
    case "routine.upsert": {
      const { event: _e, occurred_at: _at, ...row } = event;
      return { ...snapshot, routines: upsert(snapshot.routines, row) };
    }
    case "routine.removed":
      return { ...snapshot, routines: snapshot.routines.filter((row) => row.id !== event.id) };
    case "allow_rule.upsert": {
      const { event: _e, occurred_at: _at, ...row } = event;
      return { ...snapshot, allowRules: upsert(snapshot.allowRules, row) };
    }
    case "allow_rule.removed":
      return { ...snapshot, allowRules: snapshot.allowRules.filter((row) => row.id !== event.id) };
    case "memory.removed": {
      return { ...snapshot, memories: snapshot.memories.filter((m) => m.id !== event.id) };
    }
    case "skill.removed": {
      return {
        ...snapshot,
        skills: snapshot.skills.filter((s) => s.id !== event.id),
      };
    }
    case "reaction.changed": {
      return {
        ...snapshot,
        messages: snapshot.messages.map((m) => {
          if (m.id !== event.message_id) return m;
          const reactions =
            event.op === "add"
              ? [
                  ...m.reactions.filter(
                    (r) => !(r.actor === event.actor && r.emoji === event.emoji),
                  ),
                  {
                    message_id: m.id,
                    actor: event.actor,
                    emoji: event.emoji,
                    created_at: event.occurred_at,
                  },
                ]
              : m.reactions.filter(
                  (r) => !(r.actor === event.actor && r.emoji === event.emoji),
                );
          return { ...m, reactions };
        }),
      };
    }
    default:
      return snapshot;
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((row) => row.id === item.id);
  if (index === -1) return [...list, item];
  return list.map((row, i) => (i === index ? item : row));
}
