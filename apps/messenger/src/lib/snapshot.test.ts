import { expect, test } from "bun:test";
import { applyEvent, emptySnapshot } from "./snapshot.ts";

test("settings.changed replaces the GET-shaped settings, never a key", () => {
  const next = applyEvent(emptySnapshot(), {
    event: "settings.changed",
    occurred_at: "t",
    workspace_path: "/tmp/ws",
    endpoint_base_url: "https://api.example/v1",
    endpoint_key_set: true,
    endpoint_models: ["grok-4.5"],
    endpoint_model_catalog: [
      {
        name: "grok-4.5",
        price: null,
        thinking_levels: ["none", "low", "medium", "high"],
        strengths: [],
      },
    ],
    endpoint_default_model: "grok-4.5",
    default_provider_id: "p1",
    launch_at_login: true,
    locale: "en",
    theme: "dark",
    wizard_complete: true,
  });
  expect(next.settings.locale).toBe("en");
  expect(next.settings.theme).toBe("dark");
  expect(next.settings.endpoint_key_set).toBe(true);
  expect(JSON.stringify(next)).not.toContain("sk-");
});

test("bot.upsert with deleted_at drops the roster row", () => {
  const withBot = applyEvent(emptySnapshot(), {
    event: "bot.upsert",
    occurred_at: "t",
    id: "b1",
    name: "Writer",
    duties: "",
    boundaries: "",
    model: null,
    provider_id: null,
    archived_at: null,
    created_at: "t",
    updated_at: "t",
    deleted_at: null,
  });
  expect(withBot.bots).toHaveLength(1);
  const gone = applyEvent(withBot, {
    event: "bot.upsert",
    occurred_at: "t2",
    id: "b1",
    name: "Writer",
    duties: "",
    boundaries: "",
    model: null,
    provider_id: null,
    archived_at: null,
    created_at: "t",
    updated_at: "t2",
    deleted_at: "t2",
  });
  expect(gone.bots).toHaveLength(0);
});

test("session.upsert keeps last_read_at and unread_count unless the event carries them", () => {
  const first = applyEvent(emptySnapshot(), {
    event: "session.upsert",
    occurred_at: "t",
    id: "s1",
    kind: "group",
    name: "Brief",
    last_read_at: "t0",
    created_at: "t",
    updated_at: "t",
    participants: [{ member: "user", joined_at: "t", left_at: null }],
    unread_count: 2,
  });
  const renamed = applyEvent(first, {
    event: "session.upsert",
    occurred_at: "t2",
    id: "s1",
    kind: "group",
    name: "Brief 2",
    created_at: "t",
    updated_at: "t2",
    participants: [{ member: "user", joined_at: "t", left_at: null }],
  });
  expect(renamed.sessions[0]?.last_read_at).toBe("t0");
  expect(renamed.sessions[0]?.unread_count).toBe(2);
});

test("session.upsert preserves or updates archived_at", () => {
  const first = applyEvent(emptySnapshot(), {
    event: "session.upsert",
    occurred_at: "t",
    id: "s1",
    kind: "group",
    name: "Brief",
    archived_at: "t_arch",
    created_at: "t",
    updated_at: "t",
    participants: [{ member: "user", joined_at: "t", left_at: null }],
  });
  expect(first.sessions[0]?.archived_at).toBe("t_arch");

  const restored = applyEvent(first, {
    event: "session.upsert",
    occurred_at: "t2",
    id: "s1",
    kind: "group",
    name: "Brief",
    archived_at: null,
    created_at: "t",
    updated_at: "t2",
    participants: [{ member: "user", joined_at: "t", left_at: null }],
  });
  expect(restored.sessions[0]?.archived_at).toBeNull();
});

test("session.upsert replaces by id", () => {
  const first = applyEvent(emptySnapshot(), {
    event: "session.upsert",
    occurred_at: "t",
    id: "s1",
    kind: "group",
    name: "Brief",
    created_at: "t",
    updated_at: "t",
    participants: [{ member: "user", joined_at: "t", left_at: null }],
  });
  const renamed = applyEvent(first, {
    event: "session.upsert",
    occurred_at: "t2",
    id: "s1",
    kind: "group",
    name: "Brief 2",
    created_at: "t",
    updated_at: "t2",
    participants: [{ member: "user", joined_at: "t", left_at: null }],
  });
  expect(renamed.sessions).toHaveLength(1);
  expect(renamed.sessions[0]?.name).toBe("Brief 2");
});

test("session.upsert keeps an existing session in place instead of moving it to the end", () => {
  const participant = { member: "user", joined_at: "t", left_at: null };
  let snapshot = emptySnapshot();
  for (const id of ["s1", "s2", "s3"]) {
    snapshot = applyEvent(snapshot, {
      event: "session.upsert",
      occurred_at: "t",
      id,
      kind: "direct",
      name: null,
      created_at: "t",
      updated_at: "t",
      participants: [participant, { member: id, joined_at: "t", left_at: null }],
    });
  }
  const markedRead = applyEvent(snapshot, {
    event: "session.upsert",
    occurred_at: "t2",
    id: "s1",
    kind: "direct",
    name: null,
    last_read_at: "t2",
    created_at: "t",
    updated_at: "t",
    participants: [participant, { member: "s1", joined_at: "t", left_at: null }],
    unread_count: 0,
  });
  expect(markedRead.sessions.map((session) => session.id)).toEqual(["s1", "s2", "s3"]);
  expect(markedRead.sessions[0]?.last_read_at).toBe("t2");
});

test("session.removed drops the session and related messages/turns", () => {
  let s = applyEvent(emptySnapshot(), {
    event: "session.upsert",
    occurred_at: "t",
    id: "s1",
    kind: "group",
    name: "Work",
    created_at: "t",
    updated_at: "t",
    participants: [{ member: "user", joined_at: "t", left_at: null }],
  });
  s = applyEvent(s, {
    event: "message.created",
    occurred_at: "t",
    id: "m1",
    session_id: "s1",
    turn_id: null,
    parent_id: null,
    kind: "user",
    author: "user",
    body: "hi",
    source_turn_id: null,
    created_at: "t",
  });
  expect(s.sessions).toHaveLength(1);
  expect(s.messages).toHaveLength(1);

  const removed = applyEvent(s, {
    event: "session.removed",
    occurred_at: "t2",
    id: "s1",
  });
  expect(removed.sessions).toHaveLength(0);
  expect(removed.messages).toHaveLength(0);
});

test("session.cleared clears messages and turns but keeps the session", () => {
  let s = applyEvent(emptySnapshot(), {
    event: "session.upsert",
    occurred_at: "t",
    id: "s1",
    kind: "group",
    name: "Work",
    created_at: "t",
    updated_at: "t",
    participants: [{ member: "user", joined_at: "t", left_at: null }],
  });
  s = applyEvent(s, {
    event: "message.created",
    occurred_at: "t",
    id: "m1",
    session_id: "s1",
    turn_id: null,
    parent_id: null,
    kind: "user",
    author: "user",
    body: "hi",
    source_turn_id: null,
    created_at: "t",
  });
  expect(s.messages).toHaveLength(1);

  const cleared = applyEvent(s, {
    event: "session.cleared",
    occurred_at: "t2",
    id: "s1",
  });
  expect(cleared.sessions).toHaveLength(1);
  expect(cleared.sessions[0]?.last_message).toBeNull();
  expect(cleared.sessions[0]?.unread_count).toBe(0);
  expect(cleared.messages).toHaveLength(0);
});

test("message.created from a bot increments unread_count", () => {
  let s = applyEvent(emptySnapshot(), {
    event: "session.upsert",
    occurred_at: "t",
    id: "s1",
    kind: "direct",
    name: null,
    last_read_at: "t0",
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
    ],
    unread_count: 0,
  });
  s = applyEvent(s, {
    event: "message.created",
    occurred_at: "t1",
    id: "m1",
    session_id: "s1",
    turn_id: null,
    parent_id: null,
    kind: "bot",
    author: "writer",
    body: "done",
    source_turn_id: null,
    created_at: "t1",
    attachments: [],
    reactions: [],
  });
  expect(s.sessions[0]?.unread_count).toBe(1);
  s = applyEvent(s, {
    event: "message.created",
    occurred_at: "t2",
    id: "m2",
    session_id: "s1",
    turn_id: null,
    parent_id: null,
    kind: "user",
    author: "user",
    body: "ok",
    source_turn_id: null,
    created_at: "t2",
    attachments: [],
    reactions: [],
  });
  expect(s.sessions[0]?.unread_count).toBe(1);
});

test("message.created profile_change is ignored", () => {
  let s = applyEvent(emptySnapshot(), {
    event: "session.upsert",
    occurred_at: "t",
    id: "s1",
    kind: "direct",
    name: null,
    last_read_at: "t0",
    created_at: "t",
    updated_at: "t",
    participants: [
      { member: "user", joined_at: "t", left_at: null },
      { member: "writer", joined_at: "t", left_at: null },
    ],
    unread_count: 0,
  });
  s = applyEvent(s, {
    event: "message.created",
    occurred_at: "t1",
    id: "p1",
    session_id: "s1",
    turn_id: null,
    parent_id: null,
    kind: "profile_change",
    author: "writer",
    body: "Writer\n\nwrite\n\nstay",
    source_turn_id: null,
    created_at: "t1",
    attachments: [],
    reactions: [],
  });
  expect(s.messages).toHaveLength(0);
  expect(s.sessions[0]?.unread_count).toBe(0);
  expect(s.sessions[0]?.last_message ?? null).toBeNull();
});

test("turn.token appends a delta onto that turn and never inserts a message", () => {
  const running = applyEvent(emptySnapshot(), {
    event: "turn.upsert",
    occurred_at: "t",
    id: "turn-1",
    session_id: "s1",
    bot_id: "writer",
    status: "running",
    trigger_message_id: "m1",
    last_activity_at: "t",
    created_at: "t",
    updated_at: "t",
    partial_text: "",
  });
  const hello = applyEvent(running, {
    event: "turn.token",
    occurred_at: "t1",
    turn_id: "turn-1",
    session_id: "s1",
    text: "hel",
  });
  const lo = applyEvent(hello, {
    event: "turn.token",
    occurred_at: "t2",
    turn_id: "turn-1",
    session_id: "s1",
    text: "lo",
  });
  expect(lo.turns[0]?.partial_text).toBe("hello");
  expect(lo.messages).toHaveLength(0);
});

test("ending a turn voids its pending approval across the transcript and session status", () => {
  for (const status of ["stopped", "redirected", "interrupted"] as const) {
    let snapshot = applyEvent(emptySnapshot(), {
      event: "approval.upsert", occurred_at: "t", id: "approval-1", turn_id: "turn-1",
      message_id: "m1", status: "pending", kind_key: "outside-write", summary: "Write",
      target: "/tmp/file", created_at: "t", resolved_at: null, requires_api_key: false,
    });
    snapshot = applyEvent(snapshot, {
      event: "approval.upsert", occurred_at: "t", id: "approval-2", turn_id: "turn-2",
      message_id: "m2", status: "pending", kind_key: "outside-write", summary: "Other write",
      target: "/tmp/other", created_at: "t", resolved_at: null, requires_api_key: false,
    });
    const next = applyEvent(snapshot, {
      event: "turn.upsert", occurred_at: "t2", id: "turn-1", session_id: "s1", bot_id: "writer",
      status, trigger_message_id: "trigger", last_activity_at: "t", created_at: "t", updated_at: "t2",
      partial_text: null,
    });
    expect(next.approvals[0]?.status).toBe("voided");
    expect(next.approvals[0]?.resolved_at).toBe("t2");
    expect(next.approvals[1]?.status).toBe("pending");
    expect(snapshot.approvals[0]?.status).toBe("pending");
  }
});

test("continuing from an interrupt stamps source_turn_id on the 中断 note", () => {
  let snapshot = applyEvent(emptySnapshot(), {
    event: "message.created",
    occurred_at: "t",
    id: "cut-1",
    session_id: "s1",
    turn_id: "turn-cut",
    parent_id: null,
    kind: "system",
    author: "writer",
    body: "中断",
    source_turn_id: null,
    created_at: "t",
    attachments: [],
    reactions: [],
  });
  snapshot = applyEvent(snapshot, {
    event: "turn.upsert",
    occurred_at: "t2",
    id: "turn-next",
    session_id: "s1",
    bot_id: "writer",
    status: "running",
    trigger_message_id: "cut-1",
    last_activity_at: "t2",
    created_at: "t2",
    updated_at: "t2",
    partial_text: null,
  });
  expect(snapshot.messages[0]?.source_turn_id).toBe("turn-next");
});

test("turn.token for an unknown turn is ignored", () => {
  const next = applyEvent(emptySnapshot(), {
    event: "turn.token",
    occurred_at: "t",
    turn_id: "missing",
    session_id: "s1",
    text: "nope",
  });
  expect(next.turns).toHaveLength(0);
  expect(next.messages).toHaveLength(0);
});

test("turn.upsert with accumulated partial_text replaces, completed clears it", () => {
  const running = applyEvent(emptySnapshot(), {
    event: "turn.upsert",
    occurred_at: "t",
    id: "turn-1",
    session_id: "s1",
    bot_id: "writer",
    status: "running",
    trigger_message_id: "m1",
    last_activity_at: "t",
    created_at: "t",
    updated_at: "t",
    partial_text: "hel",
  });
  const late = applyEvent(running, {
    event: "turn.upsert",
    occurred_at: "t2",
    id: "turn-1",
    session_id: "s1",
    bot_id: "writer",
    status: "running",
    trigger_message_id: "m1",
    last_activity_at: "t2",
    created_at: "t",
    updated_at: "t2",
    partial_text: "hello from writer",
  });
  expect(late.turns).toHaveLength(1);
  expect(late.turns[0]?.partial_text).toBe("hello from writer");
  const done = applyEvent(late, {
    event: "turn.upsert",
    occurred_at: "t3",
    id: "turn-1",
    session_id: "s1",
    bot_id: "writer",
    status: "completed",
    trigger_message_id: "m1",
    last_activity_at: "t3",
    created_at: "t",
    updated_at: "t3",
    partial_text: null,
  });
  expect(done.turns[0]?.status).toBe("completed");
  expect(done.turns[0]?.partial_text).toBeNull();
  expect(done.messages).toHaveLength(0);
});

test("mcp.upsert replaces by id; mcp.removed drops the row", () => {
  const first = applyEvent(emptySnapshot(), {
    event: "mcp.upsert",
    occurred_at: "t",
    id: "m1",
    name: "probe",
    transport: "stdio",
    command: "bun",
    args: ["run", "fix.ts"],
    url: null,
    headers: [],
    auth_set: false,
    enabled: true,
    instructions: null,
    usage_note: null,
    tool_catalog: [],
    created_at: "t",
    updated_at: "t",
  });
  expect(first.mcpServers).toHaveLength(1);
  const renamed = applyEvent(first, {
    event: "mcp.upsert",
    occurred_at: "t2",
    id: "m1",
    name: "time",
    transport: "stdio",
    command: "bun",
    args: ["run", "fix.ts"],
    url: null,
    headers: [],
    auth_set: false,
    enabled: false,
    instructions: null,
    usage_note: null,
    tool_catalog: [],
    created_at: "t",
    updated_at: "t2",
  });
  expect(renamed.mcpServers).toHaveLength(1);
  expect(renamed.mcpServers[0]?.name).toBe("time");
  expect(renamed.mcpServers[0]?.enabled).toBe(false);
  const gone = applyEvent(renamed, {
    event: "mcp.removed",
    occurred_at: "t3",
    id: "m1",
  });
  expect(gone.mcpServers).toHaveLength(0);
});

test("skill.upsert replaces by id; skill.removed drops the row", () => {
  const first = applyEvent(emptySnapshot(), {
    event: "skill.upsert",
    occurred_at: "t",
    id: "s1",
    bot_id: "b1",
    name: "commits",
    description: "when committing",
    body: "use conventional commits",
    uses: [],
    enabled: true,
    created_at: "t",
    updated_at: "t",
  });
  expect(first.skills).toHaveLength(1);
  const renamed = applyEvent(first, {
    event: "skill.upsert",
    occurred_at: "t2",
    id: "s1",
    bot_id: "b1",
    name: "git-commits",
    description: "when committing",
    body: "use conventional commits",
    uses: ["github"],
    enabled: false,
    created_at: "t",
    updated_at: "t2",
  });
  expect(renamed.skills).toHaveLength(1);
  expect(renamed.skills[0]?.name).toBe("git-commits");
  expect(renamed.skills[0]?.enabled).toBe(false);
  const gone = applyEvent(renamed, {
    event: "skill.removed",
    occurred_at: "t3",
    id: "s1",
  });
  expect(gone.skills).toHaveLength(0);
});

test("provider.upsert replaces by id; provider.removed drops the row", () => {
  const first = applyEvent(emptySnapshot(), {
    event: "provider.upsert",
    occurred_at: "t",
    id: "p1",
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    key_set: true,
    models: ["gpt-4o"],
    model_catalog: [
      {
        name: "gpt-4o",
        price: null,
        thinking_levels: ["none", "low", "medium", "high"],
        strengths: [],
      },
    ],
    default_model: "gpt-4o",
    created_at: "t",
    updated_at: "t",
  });
  expect(first.providers).toHaveLength(1);
  const renamed = applyEvent(first, {
    event: "provider.upsert",
    occurred_at: "t2",
    id: "p1",
    name: "CPA",
    base_url: "https://api.openai.com/v1",
    key_set: true,
    models: ["gpt-4o"],
    model_catalog: [
      {
        name: "gpt-4o",
        price: null,
        thinking_levels: ["none", "low", "medium", "high"],
        strengths: [],
      },
    ],
    default_model: "gpt-4o",
    created_at: "t",
    updated_at: "t2",
  });
  expect(renamed.providers).toHaveLength(1);
  expect(renamed.providers[0]?.name).toBe("CPA");
  const gone = applyEvent(renamed, {
    event: "provider.removed",
    occurred_at: "t3",
    id: "p1",
  });
  expect(gone.providers).toHaveLength(0);
});

test("judgement.started lands in the snapshot; created and ended drop it", () => {
  const started = applyEvent(emptySnapshot(), {
    event: "judgement.started",
    occurred_at: "t",
    id: "pj1",
    session_id: "s1",
    message_id: "m1",
    bot_id: "writer",
    created_at: "t",
  });
  expect(started.pendingJudgements).toEqual([
    {
      id: "pj1",
      session_id: "s1",
      message_id: "m1",
      bot_id: "writer",
      created_at: "t",
    },
  ]);
  const created = applyEvent(started, {
    event: "judgement.created",
    occurred_at: "t2",
    id: "j1",
    session_id: "s1",
    message_id: "m1",
    bot_id: "writer",
    decision: "join",
    reason: "duties",
    error: null,
    created_at: "t2",
  });
  expect(created.pendingJudgements).toEqual([]);
  expect(created.judgements).toHaveLength(1);

  const again = applyEvent(emptySnapshot(), {
    event: "judgement.started",
    occurred_at: "t",
    id: "pj2",
    session_id: "s1",
    message_id: "m1",
    bot_id: "researcher",
    created_at: "t",
  });
  const ended = applyEvent(again, {
    event: "judgement.ended",
    occurred_at: "t3",
    id: "pj2",
    session_id: "s1",
    message_id: "m1",
    bot_id: "researcher",
  });
  expect(ended.pendingJudgements).toEqual([]);
});

test("approval.upsert replaces the row so a pending card can leave pending", () => {
  const pending = applyEvent(emptySnapshot(), {
    event: "approval.upsert",
    occurred_at: "t",
    id: "a1",
    turn_id: "turn-1",
    message_id: "appr-1",
    status: "pending",
    kind_key: "outside-write",
    summary: "outside-write /tmp/x",
    target: "/tmp/x",
    created_at: "t",
    resolved_at: null,
    requires_api_key: false,
  });
  expect(pending.approvals).toHaveLength(1);
  expect(pending.approvals[0]?.status).toBe("pending");
  const allowed = applyEvent(pending, {
    event: "approval.upsert",
    occurred_at: "t2",
    id: "a1",
    turn_id: "turn-1",
    message_id: "appr-1",
    status: "allowed_once",
    kind_key: "outside-write",
    summary: "outside-write /tmp/x",
    target: "/tmp/x",
    created_at: "t",
    resolved_at: "t2",
    requires_api_key: false,
  });
  expect(allowed.approvals).toHaveLength(1);
  expect(allowed.approvals[0]?.status).toBe("allowed_once");
});
