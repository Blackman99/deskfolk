import type { StreamFrame, ToolFrame } from "@real-bot/protocol";
import { parseStreamFrame, parseToolFrame } from "../ephemeral-frames.ts";
import type { MessengerApi } from "../messenger-api.ts";
import type { Snapshot } from "../snapshot.ts";
import { CommandActivity, type CommandRow } from "./command-activity.ts";
import { TurnActivity, type ToolStep } from "./turn-activity.ts";

/**
 * What this sub-store reaches back into the runtime for, read at call time: the client a watch or
 * a read rides on, the turns a step falls back to, and the conversation on screen, whose commands
 * are the only ones worth streaming.
 */
export interface ChatActivityHost {
  readonly api: MessengerApi | null;
  readonly snapshot: Snapshot;
  readonly selectedId: string | null;
}

/**
 * What the Bots are doing right now, off the ephemeral frames that ride beside the events: each
 * live stream's readers, the commands running and the ones a finished turn ran, and the step each
 * turn is in — plain maps, each with the revision counter the view watches. `MessengerRuntime`
 * forwards every field and method here under the same names, and reaches back in through
 * {@link ChatActivityHost}.
 */
export class ChatActivity {
  constructor(private readonly host: ChatActivityHost) {}

  /**
   * The readers of each live stream id — a terminal session, or a Bot's running command. A set
   * rather than one sink: the same terminal can be shown in two places at once, and a second
   * reader used to replace the first silently instead of joining it.
   */
  private readonly streamSinks = new Map<string, Set<(frame: StreamFrame) => void>>();
  /**
   * What the Bots' commands are printing right now. Not `$state` itself — it is a plain map that
   * a frame mutates many times a second; {@link activityRevision} is what the view watches.
   */
  readonly activity = new CommandActivity();
  activityRevision = $state(0);
  /**
   * What finished turns ran, for the command card under each one's reply: read from the Mac when
   * the reply comes near the screen, and filled from the live rows the moment a turn ends so the
   * card does not blink out while that read is out. A plain map; {@link keptCommandsRevision} is
   * what the view watches.
   */
  readonly keptCommands = new Map<string, CommandRow[]>();
  readonly keptCommandsRead = new Set<string>();
  keptCommandsRevision = $state(0);
  /**
   * The step each running turn is in, or last finished — the line that replaces a bare "思考中".
   * Its own revision: command output moves {@link activityRevision} many times a second, and the
   * lines under every message need not follow that.
   */
  readonly turnActivity = new TurnActivity();
  toolRevision = $state(0);

  /** The commands a finished turn ran, as its reply's card shows them; empty until read. */
  commandsOf(turnId: string): CommandRow[] {
    void this.keptCommandsRevision;
    return this.keptCommands.get(turnId) ?? [];
  }

  /**
   * Reads a finished turn's commands from the Mac, once. A Mac from before the record, or a turn
   * since cleared, answers with an error: the card then stays as it was, empty or what was seen.
   */
  loadTurnCommands(turnId: string): void {
    const api = this.host.api;
    if (!api || this.keptCommandsRead.has(turnId)) return;
    this.keptCommandsRead.add(turnId);
    void api.turnCommands(turnId).then(
      (items) => {
        this.keptCommands.set(turnId, items.map((item) => ({
          id: `${turnId}:${item.id}`,
          turnId,
          name: "shell",
          command: item.command,
          running: false,
          exitCode: item.exit_code,
          ok: item.ok,
          durationMs: item.duration_ms,
          text: item.output ?? "",
        })));
        this.keptCommandsRevision += 1;
      },
      () => {},
    );
  }

  /**
   * Receive one stream's bytes until the caller lets go. Watching is asked for over HTTP; this
   * only says where the frames should land once they arrive.
   */
  /**
   * Take a stream or tool frame off the socket. True means it was one and the sequenced reader
   * must not see it.
   */
  acceptEphemeral(value: unknown): value is StreamFrame | ToolFrame {
    const stream = parseStreamFrame(value);
    if (stream) {
      // A copy: a reader that lets go while the frame is being delivered must not skip its peers.
      for (const sink of [...(this.streamSinks.get(stream.id) ?? [])]) sink(stream);
      this.activity.applyStream(stream);
      this.activityRevision += 1;
      return true;
    }
    const tool = parseToolFrame(value);
    if (!tool) return false;
    this.activity.applyTool(tool);
    this.activityRevision += 1;
    this.turnActivity.applyTool(tool);
    this.toolRevision += 1;
    // A command's bytes are only worth carrying while someone can see them run — and only for
    // the conversation that is open. A phone on a radio should not receive the output of a
    // build happening in a session nobody is looking at.
    const streamId = `${tool.turn_id}:${tool.id}`;
    if (tool.phase === "started" && this.watchesTurn(tool.turn_id)) void this.watchCommand(streamId);
    if (tool.phase === "exited") void this.unwatchCommand(streamId);
    return true;
  }

  /**
   * The step this turn is in or last finished; reading it follows the next tool frame. A window
   * that saw no frame of it (opened after the call started, a phone back from the background)
   * has the call the daemon said the turn was running when this conversation was read.
   */
  stepOf(turnId: string): ToolStep | null {
    void this.toolRevision;
    const seen = this.turnActivity.latestFor(turnId);
    if (seen) return seen;
    const running = this.host.snapshot.turns.find((turn) => turn.id === turnId)?.running_tool;
    if (!running) return null;
    return {
      id: running.id,
      name: running.name,
      target: running.target ?? null,
      mcp: running.mcp_server && running.mcp_tool ? { server: running.mcp_server, tool: running.mcp_tool } : null,
      running: true,
      startedAt: Date.parse(running.started_at),
      exitCode: null,
      durationMs: null,
    };
  }

  /** Every step this client has seen the turn take, oldest first. */
  stepsOf(turnId: string): readonly ToolStep[] {
    void this.toolRevision;
    return this.turnActivity.stepsFor(turnId);
  }

  /** Whether this turn belongs to the conversation on screen. */
  private watchesTurn(turnId: string): boolean {
    if (!this.host.selectedId) return false;
    return this.host.snapshot.turns.some((turn) => turn.id === turnId && turn.session_id === this.host.selectedId);
  }

  /** Ask the daemon to send a command's bytes. Nothing is sent to a client that never asks. */
  private async watchCommand(id: string): Promise<void> {
    try {
      await this.host.api?.watchCommand(id, 0);
    } catch {
      // A command whose output cannot be followed still runs; the turn is what matters.
    }
  }

  private async unwatchCommand(id: string): Promise<void> {
    try {
      await this.host.api?.unwatchCommand(id);
    } catch {
      // Nothing to undo: the stream ends with the command either way.
    }
  }

  onStream(id: string, sink: (frame: StreamFrame) => void): () => void {
    let sinks = this.streamSinks.get(id);
    if (!sinks) {
      sinks = new Set();
      this.streamSinks.set(id, sinks);
    }
    sinks.add(sink);
    return () => {
      const current = this.streamSinks.get(id);
      if (!current?.delete(sink)) return;
      // The id is dropped only once nobody is left, so a second reader keeps the entry alive.
      if (current.size === 0) this.streamSinks.delete(id);
    };
  }
}
