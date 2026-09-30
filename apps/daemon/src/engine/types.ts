/**
 * Shared shapes for the turn engine's modules: the live turn's working state, and the credentials
 * and routing types that flow from `credentials()` through to a billed call. Nothing here runs
 * anything; it is the vocabulary the other files share.
 */
import type { AskAnswer, Locale, Message, ThinkingLevel } from "@real-bot/protocol";
import type { ToolResult } from "../collab-tools";
import type { ChatMessage } from "../completions";
import type { RouteDecision } from "../route-decision";
import type { ToolFailure } from "../store/routing";
import type { HeardItem } from "../turn-inbox";

/** A line a live turn has not read yet: a Bot naming it, or its own check-back coming due. */
export type InboxEntry = {
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
  parentId: string | null;
  writtenPaths: string[];
  /** The plan dir this turn belongs to, for what is reserved at either level; null on turns from before work dirs. */
  planDir: string | null;
  /** This turn's work dir — its ticket's when it has one — looked up once: neither can change under a live turn. */
  workDir: string | null;
  /** Unknown `@token`s send_message already rejected once this turn. */
  mentionWarned: Set<string>;
  /** Tool names in the current hop's tools array; read_skill flags `mcp_` names a body cites that are missing. */
  toolNames: Set<string>;
  /** The current hop's MCP tools by model-facing name: which server, its own name there, and whether it only reads. */
  mcpTools: Map<string, { server: string; tool: string; readOnly: boolean }>;
  spoke: boolean;
  drainRejection: boolean;
  /** The closing check ran (or was skipped for good) this turn; it never runs twice. */
  closingChecked: boolean;
  /** The default endpoint's default model, for the closing check; null when none is configured. */
  routing: {
    baseUrl: string;
    apiKey: string;
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
  /** The last hop failed and went again with a note (hop-limits.ts); failing again in a row ends the turn. */
  retried?: boolean;
  /** The last reply was cut off at the output cap and the turn carried on from it; cut again in a row, it fails. */
  continued?: boolean;
  toolCalls: number;
  toolErrors: number;
  /** Failed calls whose name and arguments match an earlier failure in this turn. */
  repeatedFailures: number;
  /** `${name}\n${arguments}` of calls that already failed, so a repeat can be recognised. */
  failedCalls: Set<string>;
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
    run: (opts?: { api_key?: string }) => Promise<ToolResult> | ToolResult;
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
    models: string[];
    defaultModel: string | null;
  }>;
};

export type ResolvedTarget = {
  baseUrl: string;
  apiKey: string;
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

/** Session and Bot as they are before the call. Names are snapshotted here; a delete during the call cannot rewrite them. */
export type SpendOwner = {
  sessionId: string;
  sessionName: string | null;
  botId: string | null;
  botName: string | null;
};

export type Routed = { target: ResolvedTarget; decision: RouteDecision };
