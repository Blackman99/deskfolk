import { expect, test } from "bun:test";
import type { AgentReplay, AgentReplayCall, AgentToolPlace, SessionReplay, ToolFrame } from "@real-bot/protocol";
import { copyFor } from "../copy.ts";
import { buildDistricts } from "./districts.ts";
import { buildFrame, placeName, statusText } from "./frame.ts";
import { AgentCallLog } from "./live.svelte.ts";
import { fromAgentReplay, fromSessionReplay, mergeLive } from "./map-data.ts";
import { modelFamily, modelLabel } from "./model-label.ts";
import { momentText } from "./moment-text.ts";
import { LONG_GAP, buildTimeline } from "./timeline.ts";

const T0 = Date.parse("2026-10-20T01:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const project = (path: string): AgentToolPlace => ({ zone: "project", path });

let n = 0;
function aCall(over: Partial<AgentReplayCall> & { s?: number } = {}): AgentReplayCall {
  const { s = n, ...rest } = over;
  n += 1;
  return { id: `toolu_${String(n).padStart(4, "0")}`, at: iso(s), agent_id: null, tool: "Read", place: project("apps/daemon/src/a.ts"), model: "claude-opus-5-5", file: "a.ts", ok: true, duration_ms: 500, decision: null, ...rest };
}

function aReplay(calls: AgentReplayCall[], over: Partial<AgentReplay> = {}): AgentReplay {
  return { session_id: "proj-1", agent_session: "s-1", source_session: null, calls, subagents: [], said: [], ...over };
}

test("Claude's model ids read as family and version, anything else as it is", () => {
  expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
  expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(modelLabel("gpt-5-codex")).toBe("gpt-5-codex");
  expect(modelLabel(null)).toBe("");
  expect(modelFamily("claude-opus-5-5")).toBe("Opus");
  expect(modelFamily("gpt-5-codex")).toBe("gpt-5-codex");
});

test("a replay becomes map data: calls oldest first, the agent first, subagents in the order they came out", () => {
  const data = fromAgentReplay(aReplay([
    aCall({ s: 30, agent_id: "agent-b" }),
    aCall({ s: 10 }),
    aCall({ s: 20, agent_id: "agent-a" }),
    aCall({ s: 40, agent_id: "agent-b" }),
  ], { subagents: [{ id: "agent-a", description: "Map the code", agent_type: "Explore", model: null, spawned_by: null, first_at: iso(20), last_at: iso(25), calls: 1 }] }), "claude_code");
  expect(data.calls.map((c) => c.at - T0)).toEqual([10_000, 20_000, 30_000, 40_000]);
  expect(data.characters.map((c) => c.key)).toEqual(["main", "agent-a", "agent-b"]);
  expect(data.characters[1]!.description).toBe("Map the code");
  expect(data.characters[2]!.description).toBeNull();
  expect(data.calls.map((c) => c.who)).toEqual([0, 1, 2, 2]);
});

test("live calls the replay does not hold are added; a subagent first seen live gets a character", () => {
  const data = fromAgentReplay(aReplay([aCall({ s: 1, id: "toolu_a" })]), "claude_code");
  const merged = mergeLive(data, [
    { id: "toolu_a", sessionId: "proj-1", actor: null, tool: "Read", info: { session_id: "proj-1", agent_id: null, place: project("x"), model: null, at: iso(1) }, startedAt: T0 + 1000, running: false, ok: true, durationMs: 1 },
    { id: "toolu_b", sessionId: "proj-1", actor: "agent-new", tool: "Bash", info: { session_id: "proj-1", agent_id: "agent-new", place: { zone: "check", check: "test" }, model: "claude-sonnet-5-5", at: iso(5) }, startedAt: T0 + 5000, running: true, ok: null, durationMs: null },
    { id: "toolu_c", sessionId: "other", actor: null, tool: "Bash", info: { session_id: "other", agent_id: null, place: { zone: "git" }, model: null, at: iso(6) }, startedAt: T0 + 6000, running: false, ok: true, durationMs: 1 },
  ]);
  expect(merged.calls.map((c) => c.id)).toEqual(["toolu_a", "toolu_b"]);
  expect(merged.characters.map((c) => c.key)).toEqual(["main", "agent-new"]);
  expect(merged.calls[1]!.running).toBe(true);
  expect(merged.calls[1]!.model).toBe("claude-sonnet-5-5");
});

test("districts split the busiest folders, keep the fixed places, and fold small folders into one", () => {
  const places: AgentToolPlace[] = [
    ...Array.from({ length: 40 }, (_, i) => project(`apps/daemon/src/store/f${i % 3}.ts`)),
    ...Array.from({ length: 30 }, () => project("apps/daemon/src/local-api/routes/a.ts")),
    ...Array.from({ length: 50 }, () => project("apps/messenger/src/lib/sidebar/Row.svelte")),
    ...Array.from({ length: 45 }, () => project("apps/messenger/src/lib/chat/Chat.svelte")),
    ...Array.from({ length: 20 }, () => project("docs/adr/0095.md")),
    project("scripts/once.ts"),
    project("CONTEXT.md"),
    ...Array.from({ length: 25 }, () => ({ zone: "check", check: "test" }) as const),
    ...Array.from({ length: 6 }, () => ({ zone: "git" }) as const),
    { zone: "outside", path: "/tmp/x" },
    { zone: "none" },
  ];
  const map = buildDistricts(places);
  const code = map.districts.filter((d) => d.kind === "code");
  expect(code.map((d) => d.path)).toEqual(["apps/daemon/src/local-api/routes", "apps/daemon/src/store", "apps/messenger/src/lib/chat", "apps/messenger/src/lib/sidebar", "docs/adr"]);
  expect(code.map((d) => d.label)).toEqual(["routes", "store", "chat", "sidebar", "adr"]);
  // Shapes follow the folder's name, and none repeats.
  expect(code.map((d) => d.archetype)).toEqual(["clips", "mail", "song", "board", "bible"]);
  expect(new Set(map.districts.map((d) => d.archetype)).size).toBe(map.districts.length);
  expect(map.districts.map((d) => d.kind)).toEqual(["root", "code", "code", "code", "code", "code", "check", "git", "outside", "other"]);
  // A path seen later lands in the folder that holds it, a stray one in 「仓库别处」, a question at the root.
  expect(map.districts[map.indexOf(project("apps/daemon/src/store/new/deep.ts"))]!.path).toBe("apps/daemon/src/store");
  expect(map.districts[map.indexOf(project("apps/landing/x.ts"))]!.kind).toBe("other");
  expect(map.districts[map.indexOf({ zone: "none" })]!.kind).toBe("root");
  expect(map.districts[map.indexOf({ zone: "claude_home", path: "~/.claude/x" })]!.kind).toBe("other");
});

test("districts are the same for the same calls, and never more than the town holds", () => {
  const places = Array.from({ length: 400 }, (_, i) => project(`pkg/m${i % 16}/sub${i % 3}/f.ts`));
  const a = buildDistricts(places), b = buildDistricts(places);
  expect(a.districts).toEqual(b.districts);
  expect(a.districts.filter((d) => d.kind === "code").length).toBeLessThanOrEqual(10);
  const slots = a.districts.map((d) => `${d.gx},${d.gy}`);
  expect(new Set(slots).size).toBe(slots.length);
});

test("a folder carrying shell words is cut where they start, and plates skip names like src and lib", () => {
  const places: AgentToolPlace[] = [
    ...Array.from({ length: 30 }, () => project("apps/daemon/src/$R;/x.ts")),
    ...Array.from({ length: 30 }, () => project("apps/daemon/src/store/a.ts")),
    ...Array.from({ length: 30 }, () => project("apps/messenger;/src/lib/a.ts")),
    ...Array.from({ length: 30 }, () => project("apps/messenger/src/lib/b.ts")),
  ];
  const map = buildDistricts(places);
  const code = map.districts.filter((d) => d.kind === "code");
  expect(code.some((d) => /[$;]/.test(d.path))).toBe(false);
  expect(code.map((d) => d.label).sort()).toEqual(["daemon", "messenger", "store"]);
});

test("MCP calls stand at one services building on the floating island, named for its server when there is one", () => {
  const svc = (server: string): AgentToolPlace => ({ zone: "service", server });
  const one = buildDistricts([project("src/a.ts"), svc("westlake-cpa"), svc("westlake-cpa")]);
  const d = one.districts.find((x) => x.kind === "service")!;
  expect(d).toMatchObject({ island: "ext", archetype: "relay", label: "westlake-cpa", path: "westlake-cpa", calls: 2 });
  expect(one.indexOf(svc("anything"))).toBe(one.districts.indexOf(d));
  const t = copyFor("zh").taskmap;
  expect(placeName(d, t)).toBe("westlake-cpa");
  const two = buildDistricts([svc("b"), svc("a"), svc("a")]).districts.find((x) => x.kind === "service")!;
  expect(two).toMatchObject({ label: "", path: "a · b" });
  expect(placeName(two, t)).toBe(t.places.service);
  expect(new Set(buildDistricts([svc("a"), { zone: "claude_home", path: "/h/.claude" }, { zone: "outside", path: "/x" }]).districts.map((x) => x.archetype)).size).toBe(4);
});

test("a session with no calls yet is a town of one: the root", () => {
  const map = buildDistricts([]);
  expect(map.districts.map((d) => d.kind)).toEqual(["root"]);
  expect(map.indexOf(project("anything/at/all.ts"))).toBe(0);
});

test("the timeline squeezes a long pause, and words what happened as moments", () => {
  n = 0;
  const calls = [
    aCall({ s: 0 }),
    aCall({ s: 5, tool: "AskUserQuestion", place: { zone: "none" }, duration_ms: 60_000, decision: { decision: "accept", source: "user_temporary", reason_type: null } }),
    aCall({ s: 70, tool: "Edit", decision: { decision: "accept", source: "user_temporary", reason_type: null } }),
    aCall({ s: 80, tool: "Bash", decision: { decision: "reject", source: "user_reject", reason_type: null }, ok: false }),
    aCall({ s: 90, tool: "Bash", ok: false }),
    aCall({ s: 100 + LONG_GAP + 60, tool: "Bash", place: { zone: "check", check: "test" }, duration_ms: 120_000 }),
  ];
  const data = fromAgentReplay(aReplay(calls, {
    said: [
      { kind: "say", at: iso(0), text: "start" },
      { kind: "answer", at: iso(65), asked_at: iso(5), questions: ["Which?"], answers: ["This one"] },
      { kind: "say", at: iso(100 + LONG_GAP + 30), text: "carry on" },
    ],
  }), "claude_code");
  const map = buildDistricts(data.calls.map((c) => c.place));
  const tl = buildTimeline(data, map);
  expect(tl.v[0]).toBe(0);
  expect(tl.idles).toHaveLength(1);
  // The pause takes four seconds of replay, not fifteen minutes.
  expect(tl.v[5]! - tl.v[4]!).toBeCloseTo(4, 5);
  const kinds = tl.moments.map((m) => m.kind);
  expect(kinds).toContain("ask");
  expect(kinds).toContain("approve");
  expect(kinds).toContain("reject");
  expect(kinds).toContain("idle");
  // Your answer to its question is not an approval, even though Claude Code records it the same way.
  expect(tl.moments.filter((m) => m.kind === "approve")).toHaveLength(1);
  const fail = tl.moments.find((m) => m.kind === "fail");
  expect(fail && fail.kind === "fail" ? fail.count : 0).toBe(1);
  const idle = tl.moments.find((m) => m.kind === "idle");
  expect(idle && idle.kind === "idle" ? idle.waitingForYou : null).toBe(true);
  expect(tl.quests.map((q) => q.kind)).toEqual(["say", "answer", "say"]);
  expect(tl.lanes).toHaveLength(1);
});

function aFrame(over: Partial<ToolFrame> & { phase: ToolFrame["phase"] }): ToolFrame {
  return {
    type: "tool", turn_id: "run-1", id: "toolu_1", name: "Bash",
    agent_run: { session_id: "proj-1", agent_id: null, place: { zone: "git" }, model: "claude-opus-5-5", at: iso(1) },
    ...over,
  } as ToolFrame;
}

test("the live log keeps each call's start and end by id, and ignores frames it cannot place", () => {
  const log = new AgentCallLog();
  log.applyTool(aFrame({ phase: "started" }));
  log.applyTool(aFrame({ phase: "started", id: "toolu_2", agent_run: { session_id: "proj-1", agent_id: "agent-x", place: project("a.ts"), model: null, at: iso(2) } }));
  expect(log.callsOf("proj-1").map((c) => [c.id, c.running])).toEqual([["toolu_1", true], ["toolu_2", true]]);
  // The subagent's call ends first; the agent's is still running.
  log.applyTool(aFrame({ phase: "exited", id: "toolu_2", duration_ms: 900, agent_run: { session_id: "proj-1", agent_id: "agent-x", place: project("a.ts"), model: "claude-sonnet-5-5", at: iso(3), ok: false } }));
  const [first, second] = log.callsOf("proj-1");
  expect(first!.running).toBe(true);
  expect(second!.running).toBe(false);
  expect(second!.ok).toBe(false);
  expect(second!.durationMs).toBe(900);
  expect(second!.info.model).toBe("claude-sonnet-5-5");
  // A Bot turn's frame, or one whose place is broken, is not a project session's call.
  log.applyTool({ type: "tool", turn_id: "t", id: "x", name: "shell", phase: "started" } as ToolFrame);
  log.applyTool(aFrame({ phase: "started", id: "bad", agent_run: { session_id: "proj-1", agent_id: null, place: { zone: "moon" } as unknown as AgentToolPlace, model: null, at: iso(4) } }));
  expect(log.callsOf("proj-1")).toHaveLength(2);
  log.applyTool(aFrame({ phase: "started", id: "toolu_3", agent_run: { session_id: "proj-1", agent_id: null, place: { zone: "service", server: "westlake-cpa" }, model: null, at: iso(5) } }));
  log.applyTool(aFrame({ phase: "started", id: "toolu_4", agent_run: { session_id: "proj-1", agent_id: null, place: { zone: "service" } as unknown as AgentToolPlace, model: null, at: iso(6) } }));
  expect(log.callsOf("proj-1").map((c) => c.id)).toEqual(["toolu_1", "toolu_2", "toolu_3"]);
  log.forget("proj-1");
  expect(log.callsOf("proj-1")).toEqual([]);
});

test("a character that stopped under a minute ago has just stopped, later for how long", () => {
  const t = copyFor("zh").taskmap;
  expect(statusText({ status: "idle", idleMin: 0.1 }, t)).toBe(t.status.rested);
  expect(statusText({ status: "idle", idleMin: 27 }, t)).toBe(t.status.idle(t.minutes(27)));
});

function aSessionReplay(): SessionReplay {
  const c = (id: string, bot: string, sec: number, path: string) => ({ id, at: iso(sec), bot_id: bot, turn_id: "t", task_id: null, tool: "write_file", place: project(path), model: "deepseek-chat", file: null, ok: true, duration_ms: 100, decision: null });
  return {
    session_id: "g-1", bots: ["b-1", "b-2"], truncated: false,
    calls: [c("c3", "b-2", 30, "jobs/b/x.md"), c("c1", "b-1", 10, "jobs/a/x.md"), c("c2", "b-1", 20, "jobs/a/y.md")],
    said: [{ kind: "answer", at: iso(40), asked_at: iso(35), questions: ["几个？"], answers: ["三个"], bot_id: "b-2" }],
  };
}

test("a Bot conversation's replay: every Bot a lead in the order it worked, a question its own Bot's", () => {
  const data = fromSessionReplay(aSessionReplay());
  expect(data.source).toEqual({ kind: "bots" });
  expect(data.characters.map((c) => [c.key, c.lead, c.calls])).toEqual([["b-1", true, 2], ["b-2", true, 1]]);
  expect(data.calls.map((c) => [c.id, c.who])).toEqual([["c1", 0], ["c2", 0], ["c3", 1]]);
  const map = buildDistricts(data.calls.map((c) => c.place));
  const tl = buildTimeline(data, map);
  expect(tl.moments.filter((m) => m.kind === "spawn")).toEqual([]);
  expect(tl.moments.find((m) => m.kind === "ask")?.who).toBe(1);
  // A Bot that has not worked yet waits at the root; every Bot is drawn full size, by its own name.
  const t = copyFor("zh").taskmap;
  const frame = buildFrame({ data, map, tl, v: 0, phi: 0, zoom: 1, now: 0, speed: 4, light: { w: 0, n: 0 } as never, cache: new Map(), walk: { lastTile: [], until: [] }, hover: -1, sel: -1, t, names: ["导演", "审片员"] });
  expect(frame.actors.map((a) => [a.short, a.lead, a.present, a.scale])).toEqual([["导演", true, true, 1], ["审片员", true, true, 1]]);
  expect(frame.actors[1]!.tile).toBe(map.indexOf({ zone: "none" }));
});

test("a Bot's live call is logged under its Bot, and a Bot first seen live joins as a lead", () => {
  const log = new AgentCallLog();
  log.applyTool({ type: "tool", turn_id: "t", id: "c9", name: "shell", phase: "started", bot_call: { session_id: "g-1", bot_id: "b-3", place: project("jobs/c"), model: "m", at: iso(50) } } as ToolFrame);
  const [live] = log.callsOf("g-1");
  expect(live!.actor).toBe("b-3");
  const merged = mergeLive(fromSessionReplay(aSessionReplay()), log.callsOf("g-1"));
  expect(merged.characters.map((c) => [c.key, c.lead])).toEqual([["b-1", true], ["b-2", true], ["b-3", true]]);
  expect(merged.calls.at(-1)).toMatchObject({ id: "c9", who: 2, running: true });
});

test("a long MCP call reads as a call to a service, not by its tool's name", () => {
  const data = fromAgentReplay(aReplay([aCall({ s: 0, tool: "mcp__westlake-cpa__generate_video", place: { zone: "service", server: "westlake-cpa" }, duration_ms: 40_000 })]), "claude_code");
  const map = buildDistricts(data.calls.map((c) => c.place));
  const long = buildTimeline(data, map).moments.find((m) => m.kind === "long")!;
  const t = copyFor("zh").taskmap;
  expect(momentText(long, t, () => "", () => "", () => "").title).toBe(t.moments.long(t.verbs.service, 40));
});
