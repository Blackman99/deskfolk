import type { ClientEvent, RuntimeResponse, RuntimeSnapshot, ToolFrame } from "@real-bot/protocol";
import type { Ablation } from "../ablation";
import type { ClaudeCodeProbe } from "../claude-code/probe";
import type { ClaudeUsageProbe } from "../claude-code/usage";
import type { CompletionsClient } from "../completions";
import type { AgentQuery } from "../engine/agent-runner";
import type { RuntimeLifecycle } from "../lifecycle";
import type { McpHost } from "../mcp-host";
import { PresenceManager } from "../notifications";
import { Quiesce, TurnAdmission } from "../quiesce";
import type { ScreenService } from "../remote/screen";
import type { CanonicalEncoder } from "../request-digest";
import type { Scheduler } from "../scheduler";
import { EventStream } from "../session-events";
import type { Store } from "../store";
import type { RequestScope } from "../store/receipts";
import type { SharedInstall } from "../store/schema-gate";
import { StreamHub, type StreamRead } from "../streams";
import { Terminals } from "../terminals";
import type { TurnEngine } from "../turn-engine";
import type { TrashMover } from "../workspace-trash";

export type SocketData = {
  authed: boolean;
  sync?: boolean;
};

export type LocalApiOptions = {
  store: Store;
  token: string;
  onQuit?: () => void;
  engine?: TurnEngine;
  completions?: CompletionsClient;
  /**
   * Which endpoints are model servers on this computer or network (ADR 0067): probed for their
   * models' windows, given local time limits and checked for cut prompts. Tests that stand a fake
   * cloud endpoint up on 127.0.0.1 turn it off.
   */
  localEndpoint?: (baseUrl: string) => boolean;
  /** What a transcription reaches the speech endpoint with (ADR 0073); tests answer for it. */
  speechFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  mcp?: McpHost;
  /** Skip the calendar ticker (tests that drive `engine.fireRoutine` themselves). */
  schedule?: boolean;
  now?: () => Date;
  canonicalEncoder?: CanonicalEncoder;
  admission?: TurnAdmission;
  remoteStatus?: () => NonNullable<RuntimeSnapshot["remoteStatus"]>;
  /** The remote screen's switch and sessions, set from the window only (ADR 0056). */
  screen?: ScreenService;
  /**
   * Dev-only bridge to the pairing side of the setup channel. The packaged window reaches it over
   * its inherited socketpair, which a source build has no way to obtain; absent in production, and
   * the route 404s without it.
   */
  devSetup?: (request: unknown) => Promise<unknown>;
  runtimeInfo?: () => RuntimeResponse;
  lifecycle?: RuntimeLifecycle;
  onHandoff?: () => void;
  onRuntimeStop?: () => void;
  policyV1?: boolean;
  pushSettingsV2?: boolean;
  /** Where Deskfolk's own zsh shell integration is written, for terminals the person opens. */
  dataDir?: string;
  /** How workspace files reach the Trash; the Mac's own Trash when absent. */
  trash?: TrashMover;
  /** Side-calls switched off for a benchmark (see `ablation.ts`); ignored when `engine` is given. */
  ablation?: Ablation;
  /**
   * Runs once the engine is up and before the scheduler starts, whose first tick is immediate: boot
   * tells you what a restart cut off (ADR 0041) before a check-back or routine that fell due while
   * the daemon was down can wake a Bot.
   */
  beforeScheduler?: (engine: TurnEngine) => void;
  /**
   * The installed app that shares this database, as boot reads it for the engine level
   * (`raiseEngineLevel`); null or absent when none does. `POST /v1/capabilities/raise` names it in
   * the log line when a developer's opt-in lets the level past it.
   */
  installedApp?: () => SharedInstall | null;
  /** Where that route writes what it did: daemon.log, as boot does. */
  log?: (line: string) => void;
  /** What the daemon knows of the user's own Claude Code (ADR 0061); one is made when absent. */
  claudeCode?: ClaudeCodeProbe;
  /** Your Claude plan's usage, asked of that Claude Code; one is made when absent. */
  claudeUsage?: ClaudeUsageProbe;
  /** Stands in for the Agent SDK's `query` in tests, so no Claude Code is started. */
  agentQuery?: AgentQuery;
};

export type LocalApi = {
  dispatchBusiness: (request: Request, scope: RequestScope) => Promise<Response>;
  fetch: (request: Request, server: Bun.Server<SocketData>) => Promise<Response | undefined>;
  websocket: {
    data: SocketData;
    open: (ws: Bun.ServerWebSocket<SocketData>) => void;
    message: (ws: Bun.ServerWebSocket<SocketData>, message: string | Buffer) => void;
    close: (ws: Bun.ServerWebSocket<SocketData>) => void;
  };
  publish: (event: ClientEvent) => void;
  engine: TurnEngine;
  scheduler: Scheduler | null;
  quiesce: Quiesce;
  subscribeSync: EventStream["subscribe"];
  syncCursor: EventStream["cursor"];
  terminals: Terminals;
  streams: StreamHub;
  /** Start sending a stream to one watcher, from a byte offset, with its backlog first. */
  watchStream: (id: string, watcher: string, from: number) => void;
  unwatchStream: (id: string, watcher: string) => void;
  /** Stream frames, with the watchers they are meant for; the remote link routes by device id. */
  subscribeStreams: (listener: (id: string, read: StreamRead, watchers: readonly string[]) => void) => () => void;
  subscribeTools: (listener: (frame: ToolFrame) => void) => () => void;
  presence: PresenceManager;
};
