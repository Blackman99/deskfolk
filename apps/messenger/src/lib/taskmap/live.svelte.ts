import type { AgentToolPlace, ToolFrame } from "@real-bot/protocol";
import type { LiveCall } from "./map-data.ts";

/** How many calls a session keeps between replays; an open map refetches the replay long before. */
const KEEP = 3000;

const ZONES = new Set<AgentToolPlace["zone"]>(["project", "outside", "claude_home", "check", "git", "service", "none"]);

/** A frame's place, if it is one the map can stand somewhere (the parser lets `agent_run` through unread). */
function placeOk(place: unknown): place is AgentToolPlace {
  if (!place || typeof place !== "object") return false;
  const zone = (place as { zone?: unknown }).zone;
  if (typeof zone !== "string" || !ZONES.has(zone as AgentToolPlace["zone"])) return false;
  if (zone === "project" || zone === "outside" || zone === "claude_home") return typeof (place as { path?: unknown }).path === "string";
  if (zone === "check") return (place as { check?: unknown }).check === "test" || (place as { check?: unknown }).check === "typecheck";
  if (zone === "service") return typeof (place as { server?: unknown }).server === "string";
  return true;
}

/**
 * The tool calls this window has seen on the event stream for the task map, by session and call id:
 * a project session's (ADR 0095's `ToolFrame.agent_run`) and a Bot's (ADR 0097's `bot_call`). Each
 * call is its own entry, so a subagent's or another Bot's calls running beside each other each get
 * their end; nothing here survives a reload, which is what the replay is for.
 */
export class AgentCallLog {
  revision = $state(0);
  readonly #bySession = new Map<string, Map<string, LiveCall>>();

  /** Take one tool frame; a frame that says nothing of where its call works is ignored. */
  applyTool(frame: ToolFrame): void {
    const info = frame.agent_run ?? frame.bot_call;
    if (!info || typeof info.session_id !== "string" || !placeOk(info.place)) return;
    const actor = frame.agent_run ? frame.agent_run.agent_id : frame.bot_call!.bot_id;
    let calls = this.#bySession.get(info.session_id);
    if (!calls) this.#bySession.set(info.session_id, (calls = new Map()));
    const at = Date.parse(info.at);
    const seen = calls.get(frame.id);
    if (frame.phase === "started") {
      if (seen) return;
      calls.set(frame.id, { id: frame.id, sessionId: info.session_id, actor, tool: frame.name, info, startedAt: Number.isFinite(at) ? at : Date.now(), running: true, ok: null, durationMs: null });
      if (calls.size > KEEP) calls.delete(calls.keys().next().value!);
    } else {
      const started = seen?.startedAt ?? (Number.isFinite(at) ? at - (frame.duration_ms ?? 0) : Date.now());
      calls.set(frame.id, {
        id: frame.id,
        sessionId: info.session_id,
        actor: seen?.actor ?? actor,
        tool: frame.name,
        info: { ...(seen?.info ?? info), ...(info.model ? { model: info.model } : {}) },
        startedAt: started,
        running: false,
        ok: info.ok ?? true,
        durationMs: frame.duration_ms ?? (Number.isFinite(at) ? Math.max(0, at - started) : null),
      });
    }
    this.revision += 1;
  }

  /** A session's calls oldest first; reading it follows the next frame. */
  callsOf(sessionId: string): LiveCall[] {
    void this.revision;
    return [...(this.#bySession.get(sessionId)?.values() ?? [])].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Forget a session's calls once a replay holds them (or the connection was lost and the replay is refetched). */
  forget(sessionId: string): void {
    if (this.#bySession.delete(sessionId)) this.revision += 1;
  }
}
