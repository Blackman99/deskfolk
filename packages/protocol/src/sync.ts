import type { AllowRule, Approval, McpServer, Memory, Routine, Skill } from "./admin.ts";
import type { Bot } from "./bots.ts";
import type { ClientEvent } from "./events.ts";
import type { Hold } from "./holds.ts";
import type { Provider } from "./providers.ts";
import type { Judgement } from "./routing.ts";
import type { SessionDetail, SessionSummary } from "./sessions.ts";
import type { Settings } from "./settings.ts";

export type EventCursor = {
  event_instance_id: string;
  watermark_seq: number;
};

export type CredentialOperation = { id: string; kind: string; entity_id: string; request_id: string | null; can_repair: boolean };

/** A STUN or TURN server the Mac's settings name for the remote screen's direct connection. */
export type RemoteScreenIceServer = { urls: string[]; username?: string; credential?: string };

/**
 * The remote screen as the Mac's own window sees it (`GET/PUT /v1/remote/screen`, loopback only):
 * whether paired devices may view and control this Mac through macOS Screen Sharing, which ICE
 * servers a direct connection may use, whether Screen Sharing answered, and who is connected now.
 */
export type RemoteScreenStatus = {
  enabled: boolean;
  iceServers: RemoteScreenIceServer[];
  /** Null before anything looked. */
  sharing: boolean | null;
  /** Whether this Mac can take a direct connection at all (its WebRTC helper is in place). */
  direct: boolean;
  sessions: Array<{
    deviceId: string;
    deviceName: string;
    mode: "connecting" | "direct" | "relay";
    since: number;
    /** Bytes carried so far each way; a direct session's come from its helper every couple of seconds. */
    toPhone: number;
    fromPhone: number;
    /**
     * What Screen Sharing announced, read off a relayed session's plain RFB after its sign-in: the
     * framebuffer and how the first update is encoded (RFB encoding number).
     */
    framebuffer?: { width: number; height: number; firstEncoding?: number };
  }>;
  /** Pixel sizes while a smooth session has the display lowered, and what it is otherwise. */
  lowered?: { width: number; height: number; fromWidth: number; fromHeight: number };
};

export type RuntimeSnapshot = EventCursor & {
  remoteStatus?: { state: "off" | "native_unavailable" | "activation_gated" | "connecting" | "online" | "disconnected" | "trust_mismatch"; diagnostic: string | null; devices: number };
  credentialOperations?: CredentialOperation[];
  settings: Settings;
  bots: Bot[];
  sessions: SessionSummary[];
  // No `spend`: 3,700 usage rows were 1.4 MB of every snapshot and nothing on screen read them.
  // `GET /v1/spend` serves them to whatever view needs them, when it opens.
  approvals: Approval[];
  mcpServers: McpServer[];
  providers: Provider[];
  skills: Skill[];
  memories: Memory[];
  routines: Routine[];
  allowRules: AllowRule[];
  notificationSummary?: import("./notifications.ts").NotificationSummary;
  notificationPolicy?: import("./notifications.ts").NotificationPolicy;
  notificationCapabilities?: import("./notifications.ts").NotificationCapabilities;
  /**
   * The holds in force, newest first; `hold.upsert` keeps them current. Absent from a daemon that
   * predates holds or has not reached their engine level, so a client offers stops only when it is here.
   */
  holds?: Hold[];
  /**
   * Present from a daemon whose working Bot hears a line of yours in a direct at its next step
   * (ADR 0040 P4a). Absent from an older one, where that line would cut the turn off, so a client
   * keeps the direct's composer to Stop while the Bot works.
   */
  turnInbox?: true;
  /**
   * Present from a daemon that takes your lines in a conversation in the order they came (ADR 0063):
   * one sent while the last is still being read waits for it, so a direct's Send stays open then.
   */
  linesInOrder?: true;
  /** Present from a daemon that lets you change a line of yours after sending it (ADR 0063). */
  messageEdits?: true;
  /**
   * Present from a daemon that lets you take back a line of yours still waiting for a Bot to read
   * it, or have the working Bot read it now (ADR 0069).
   */
  queuedLineActions?: true;
};

export type SessionSnapshot = EventCursor & {
  session: SessionDetail;
  judgements: Judgement[];
};

export type DurableEvent = Exclude<ClientEvent, { event: "turn.token" | "turn.tool" }>;
export type SequencedEvent = {
  type: "event";
  event_instance_id: string;
  seq: number;
  payload: DurableEvent;
};

/**
 * Paths whose writes carry no request receipt, and therefore no in-flight slot on a client.
 *
 * Both ends have to agree, which is why this lives here. A receipt is keyed `(device, request)`
 * and stored in the same transaction as its effect — right for a message, absurd for a keystroke.
 * A client that treats these as ordinary mutations will refuse the second keystroke while the
 * first is still in flight, which looks exactly like a terminal dropping characters.
 *
 * `/v1/workspace/trash` moves files, not rows, so no transaction could hold it together with a
 * receipt; a repeat is harmless instead, since a path already gone is reported as trashed. A speed
 * test (ADR 0067) streams for up to minutes before it records anything, and a repeat only measures
 * again. A transcription (ADR 0073) waits on the speech endpoint and stores nothing; a repeat only
 * transcribes again.
 */
export function isNonReceiptPath(path: string): boolean {
  const withoutQuery = path.split("?")[0] ?? "";
  return withoutQuery === "/v1/models/probe"
    || /^\/v1\/providers\/[^/]+\/speed-test$/.test(withoutQuery)
    || withoutQuery === "/v1/speech/transcribe"
    || withoutQuery === "/v1/workspace/trash"
    || withoutQuery === "/v1/notification-presence"
    || withoutQuery === "/v1/terminals"
    || withoutQuery.startsWith("/v1/terminals/")
    || withoutQuery.startsWith("/v1/streams/");
}

/**
 * A tool call starting and finishing, on the same socket as {@link StreamFrame} and with the same
 * standing: ephemeral, no cursor, no catch-up. It is what turns a stream of bytes into something
 * readable — which command produced them, and how it ended. The record that survives a reload is
 * the turn's, not this.
 */
export type ToolFrame = {
  type: "tool";
  turn_id: string;
  /** The tool call id; with the turn id it is also the output stream's id. */
  id: string;
  name: string;
  phase: "started" | "exited";
  /** The `shell` command line, when that is what ran. */
  command?: string;
  /**
   * What the call is about, in a few words: the path a file tool touches, the name a roster or
   * skill tool acts on, the subject a memory is filed under. Clipped, and never a body — a write's
   * content or a message's text stays in the turn's record. Absent when the arguments name nothing.
   */
  target?: string;
  /** For an MCP tool: its server's name and the tool's own name, not the model-facing `mcp_…` one. */
  mcp_server?: string;
  mcp_tool?: string;
  exit_code?: number | null;
  duration_ms?: number;
};

export type StreamFrame = {
  type: "stream";
  /** A terminal session id, or `<turn_id>:<tool_call_id>` for a command. */
  id: string;
  /** Byte offset of the first byte of `data` within the stream. */
  offset: number;
  /** base64 */
  data: string;
  /** Bytes the ring dropped before `offset`; the reader fell behind. */
  skipped?: number;
  /** The producer is done. No more frames for this id. */
  closed?: boolean;
};

export type SyncFrame = SequencedEvent
  | ({ type: "ready" } & EventCursor)
  | ({ type: "resnapshot" } & EventCursor);
export type CatchupResponse = EventCursor & { events: SequencedEvent[]; resnapshot: boolean };

export type WsAuthMessage = {
  type: "auth";
  token: string;
  /** Omit for the original, unsequenced local event stream. */
  protocol?: "sync-v1";
};
