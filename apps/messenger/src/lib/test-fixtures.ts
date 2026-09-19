/** Small stand-ins for the runtime and its rows, so a component test says only what it is about. */
import type { Bot, SessionSummary, Skill } from "@real-bot/protocol";
import { emptySnapshot, type Snapshot } from "./snapshot.ts";
import type { MessengerRuntime } from "./runtime.svelte.ts";

export function aBot(over: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Researcher",
    duties: "收集资料",
    boundaries: "不乱改文件",
    avatar: "data:image/svg+xml;base64,PHN2Zy8+",
    model: null,
    provider_id: null,
    thinking_level: null,
    archived_at: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    ...over,
  } as Bot;
}

export function aGroup(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "sess-1",
    kind: "group",
    name: "视频组",
    archived_at: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    last_read_at: null,
    participants: [
      { member: "you", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
      { member: "bot-1", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
      { member: "bot-2", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
    ],
    ...over,
  } as SessionSummary;
}

export function aDirect(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: "direct-1",
    kind: "direct",
    name: null,
    archived_at: null,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    last_read_at: null,
    participants: [
      { member: "you", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
      { member: "bot-1", joined_at: "2026-09-19T00:00:00.000Z", left_at: null },
    ],
    ...over,
  } as SessionSummary;
}

export function aSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    bot_id: "bot-1",
    name: "查证",
    description: "需要核实时",
    body: "先找一手来源",
    uses: [],
    enabled: true,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
    ...over,
  } as Skill;
}

export type FakeRuntime = MessengerRuntime & {
  calls: { name: string; args: unknown[] }[];
};

/**
 * Enough of `MessengerRuntime` for a pane to render and report what it asked for. Every stub
 * resolves to `null`, which is how the real methods say "that worked".
 */
export function fakeRuntime(over: Partial<Snapshot> = {}, stubs: Record<string, unknown> = {}): FakeRuntime {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    (name: string, result: unknown = null) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return stubs[name] !== undefined
        ? (stubs[name] as (...a: unknown[]) => unknown)(...args)
        : Promise.resolve(result);
    };
  return {
    calls,
    snapshot: { ...emptySnapshot(), ...over },
    connection: "connected",
    selectedId: null,
    profileBotId: null,
    draft: "",
    busy: false,
    composerSuggestions: [],
    searchHits: [],
    searchQuery: "",
    focusedTurnId: null,
    replyingToId: null,
    createBot: record("createBot"),
    createGroup: record("createGroup"),
    patchBot: record("patchBot"),
    patchSession: record("patchSession"),
    addMember: record("addMember"),
    removeMember: record("removeMember"),
    archiveBot: record("archiveBot"),
    restoreBot: record("restoreBot"),
    createSkill: record("createSkill"),
    patchSkill: record("patchSkill"),
    deleteSkill: record("deleteSkill"),
    patchSettings: record("patchSettings"),
  } as unknown as FakeRuntime;
}
