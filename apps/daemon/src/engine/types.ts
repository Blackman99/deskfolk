/**
 * Shared shapes for the turn engine's modules: the live turn's working state, and the credentials
 * and routing types that flow from `credentials()` through to a billed call. Nothing here runs
 * anything; it is the vocabulary the other files share.
 */
import type { ApiFormat, AskAnswer, Locale, Message, ThinkingLevel } from "@real-bot/protocol";
import type { ToolResult } from "../collab-tools";
import type { ChatMessage } from "../completions";
import type { RouteDecision } from "../route-decision";
import type { ToolFailure } from "../store/routing";
import type { HeardItem } from "../turn-inbox";
import type { TroubleCount } from "./trouble";

/** A line a live turn has not read yet: a Bot naming it, or its own check-back coming due. */
export type InboxEntry = {
  /** The `inbox_items` row, once the line is persisted (ADR 0040 P4a). */
  seq?: number;
  item: HeardItem;
  message: Message;
  /** Set for a check-back: where the turn it would have opened lands, should it need opening. */
  checkBack?: { taskId: string | null; ticketId: string | null };
  /**
   * Your line from another session about this turn's job. It is answered where you said it, so a
   * turn that ends before reading it does not open another here for it.
   */
  elsewhere?: true;
};

export type Live = {
  abort: AbortController;
  loop: ChatMessage[];
  /**
   * What was said to this Bot while this turn worked, read out at the start of the next hop. A
   * turn that ends before reading it opens one more turn on the last line, so nothing is lost.
   */
  inbox: InboxEntry[];
  /** The turn has been seen working on its ticket (moved it from todo to doing); it happens once. */
  ticketWorking?: boolean;
  interrupt: boolean;
  burned: boolean;
  partial: string;
  /** The tool call running now, from its start frame until it exits. */
  runningTool?: import("@real-bot/protocol").TurnRunningTool | null;
  parentId: string | null;
  writtenPaths: string[];
  /**
   * Every file the turn wrote, cited or not, for the supervisor's progress (ADR 0045): hashed when
   * the turn ends, a new content hash in the job's folder is progress. `writtenPaths` forgets what
   * a message has cited; this does not.
   */
  producedPaths?: string[];
  /** The plan dir this turn belongs to, for what is reserved at either level; null on turns from before work dirs. */
  planDir: string | null;
  /** This turn's work dir — its ticket's when it has one — looked up once: neither can change under a live turn. */
  workDir: string | null;
  /** Unknown `@token`s send_message already rejected once this turn. */
  mentionWarned: Set<string>;
  /** Tool names in the current hop's tools array; read_skill flags `mcp_` names a body cites that are missing. */
  toolNames: Set<string>;
  /** The current hop's MCP tools by model-facing name: which server, its own name there, and whether it only reads. */
  mcpTools: Map<string, { server: string; tool: string; readOnly: boolean; params?: string[] }>;
  /** What this turn runs on, once routed: whether it can be shown a picture is read from its catalog entry (ADR 0049). */
  target?: { providerId: string; model: string };
  spoke: boolean;
  drainRejection: boolean;
  /** The closing check ran (or was skipped for good) this turn; it never runs twice. */
  closingChecked: boolean;
  /**
   * The app's plan call-back opened this turn. A reply that only says again what this Bot already
   * said in the plan is dropped: the call-back exists to move a ticket, and the same answer moves
   * nothing. A turn that only heard the call-back keeps this unset, so its own work still posts.
   */
  planNudge?: boolean;
  /** The default endpoint's default model, for the closing check; null when none is configured. */
  routing: {
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiFormat;
    providerId: string;
    providerName: string;
    model: string;
    thinkingLevel: ThinkingLevel | null;
  } | null;
  /** The turn's locale, so a note handed back mid-loop reads like the rest of the prompt. */
  locale: Locale;
  /** Completion hops this turn has started. Written onto the route row when the turn closes. */
  hops: number;
  /** The hop limit's note is in the loop: it goes in once, and the tools stay away after it. */
  lastHopNoted?: boolean;
  /** An empty reply was answered with one note; the next empty one ends the turn as it would. */
  emptyNudged?: boolean;
  /** A completion is in flight. Its own time limit bounds it, so the stale sweep leaves the turn alone meanwhile. */
  streaming?: boolean;
  /**
   * 直接插入 (ADR 0069): a line of yours waiting for this turn is to be read now. On the app's own
   * loop `step` cuts the completion in flight, and `readNow` postpones the calls of the hop still
   * waiting to run (one already running finishes); the next hop reads the line and clears it.
   */
  step?: AbortController;
  readNow?: boolean;
  /**
   * Set by a Claude Agent segment while it runs: stops what Claude Code is doing — a command it
   * runs included — and hands it the lines waiting for this turn, once the stop went through.
   * False when there is nothing to stop or nothing to hand over.
   */
  sendNow?: () => boolean;
  /** A Claude Agent turn (ADR 0061): Claude Code runs it, not the hop loop; no model ladder applies. */
  agent?: boolean;
  /** The last hop failed and went again with a note (hop-limits.ts); failing again in a row ends the turn. */
  retried?: boolean;
  /** The last reply was cut off at the output cap and the turn carried on from it; cut again in a row, it fails. */
  continued?: boolean;
  /** Bytes of the largest request a hop of this turn went through with: what is known to fit (ADR 0068). */
  fitBytes?: number;
  /** Bytes per token the last hop that reported its usage was read at. */
  bytesPerToken?: number;
  /** The loop was compacted since the last hop that went through; over the context again, the turn fails. */
  compacted?: boolean;
  /** The note the latest compaction left at the head of the loop, folded into the next summary. */
  summary?: ChatMessage;
  toolCalls: number;
  toolErrors: number;
  /** Failed calls whose name and arguments match an earlier failure in this turn. */
  repeatedFailures: number;
  /** `${name}\n${arguments}` of calls that already failed, so a repeat can be recognised. */
  failedCalls: Set<string>;
  /** Malformed arguments and same-tool failures in a row (ADR 0054): enough of either steps the job up. */
  trouble: TroubleCount;
  /** After a step up mid-turn: the rest of the turn runs at the thinking level its job is on now. */
  restep?: () => void;
  /** The first few distinct failed calls, written onto the route row for the learning hop. */
  failures: ToolFailure[];
  ask?: {
    id: string;
    toolCallId: string;
    waiter: (answer: AskAnswer) => void;
  };
  approval?: {
    id: string;
    toolCallId: string;
    run: (opts?: { api_key?: string; approval_id?: string; message_id?: string | null }) => Promise<ToolResult> | ToolResult;
    waiter: (result: ToolResult) => void;
    requiresApiKey?: boolean;
  };
};

export type Creds = {
  locale: Locale;
  defaultProviderId: string | null;
  providers: Array<{
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiFormat;
    models: string[];
    defaultModel: string | null;
  }>;
};

export type ResolvedTarget = {
  baseUrl: string;
  apiKey: string;
  apiFormat: ApiFormat;
  providerId: string;
  providerName: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  locale: Locale;
};

/** What one billed call actually ran on. Frozen before the call so a later delete cannot move it. */
export type CallTarget = {
  providerId: string;
  providerName: string;
  model: string;
  thinkingLevel: ThinkingLevel | null;
};

/** A call's target with the endpoint it goes to. */
export type EndpointTarget = CallTarget & { baseUrl: string; apiKey: string; apiFormat: ApiFormat };

/** Session and Bot as they are before the call. Names are snapshotted here; a delete during the call cannot rewrite them. */
export type SpendOwner = {
  sessionId: string;
  sessionName: string | null;
  botId: string | null;
  botName: string | null;
};

export type Routed = { target: ResolvedTarget; decision: RouteDecision };
