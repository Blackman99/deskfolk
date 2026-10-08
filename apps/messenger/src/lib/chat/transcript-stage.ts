import type { Annotation, Attachment, Bot, ControlOffer, Message, MessageVersion, SessionSummary, Turn } from "@real-bot/protocol";
import type { QueuedLine } from "./queued-line.ts";
import type { MessengerRuntime } from "../runtime.svelte.ts";
import type { SessionView } from "../session-view.svelte.ts";
import type { RenderMarkdownOptions } from "../markdown.ts";
import type { SessionGroup } from "../sidebar/session-groups.ts";
import type { StatusLabels } from "../sidebar/session-status.ts";
import type { BotDmIndex } from "./bot-dm-entries.ts";
import type { MessageLookup } from "./chat-view.ts";

/** What a changed line said before, under its bubble once you open it: read for the change it now carries. */
export type VersionsShown = { at: string; loading: boolean; failed: boolean; versions: MessageVersion[] };

/**
 * What the transcript's rows read from the stage, as one object: the stage's derived context
 * (getters, so a row reading one stays live), the state several rows share (one open step list,
 * one copied line, the versions and keys typed so far — kept on the stage, so a row that remounts
 * finds them again) and the stage's own handlers.
 */
export type TranscriptStage = {
  readonly snapshot: MessengerRuntime["snapshot"];
  readonly view: SessionView | null;
  readonly selected: SessionSummary | null;
  readonly selectedKind: SessionGroup | null;
  readonly botsById: Map<string, Bot>;
  readonly locale: "en" | "zh";
  readonly connected: boolean;
  readonly lockedComposer: boolean;
  readonly fileDrop: boolean;
  readonly showOwnAvatar: boolean;
  readonly highlightedId: string | null;
  readonly selectedMessageId: string | null;
  readonly copiedMessageId: string | null;
  readonly statusLabels: StatusLabels;
  readonly rosterLabels: { deleted: string; archived: string; fileDrop: string };
  readonly liveTurnsHere: Turn[];
  readonly announced: Set<string>;
  readonly messageLookup: MessageLookup;
  readonly commandHosts: Set<string>;
  readonly annotationIndex: Map<string, Annotation[]>;
  readonly botDmIndex: BotDmIndex;
  readonly attributionChips: Set<string>;
  readonly cardErrors: Record<string, string>;
  readonly versionsShown: Record<string, VersionsShown>;
  readonly editErrorText: string | null;
  readonly nowMs: number;

  approvalKeys: Record<string, string>;
  approvalKeyErrors: Record<string, boolean>;
  attributionEditId: string | null;
  openStepsTurn: string | null;

  readonly onOpenProfile: (botId: string) => void;
  readonly onOpenArtifact: (relpath: string, att?: Attachment, messageId?: string, forceTree?: boolean) => void;

  who: (message: Message) => string;
  whoAuthor: (author: string) => string;
  botNameOf: (id: string) => string;
  markdownOpts: (message?: Message, extra?: { streaming?: boolean }) => RenderMarkdownOptions;
  messageBody: (message: Message) => string;
  messageShowsAttachments: (message: Message) => boolean;
  loadBodyImage: (relpath: string, signal: AbortSignal) => Promise<Blob>;
  openBodyImage: (message: Message, path: string, from?: HTMLElement | null) => void;
  openInlineImage: (attachment: Attachment | null, relpath: string | null, from?: HTMLElement | null) => void;
  openInlineFile: (att: Attachment, messageId: string) => void;
  openAnnotation: (row: Annotation) => void;
  toggleAnnotation: (messageId: string, row: Annotation, status: "open" | "resolved") => Promise<void>;
  annotationSourceLabel: (message: Message) => string | null;
  openAnnotationSource: (message: Message) => void;
  editable: (message: Message) => boolean;
  editingHere: (message: Message) => boolean;
  startEdit: (message: Message) => void;
  /** A line of yours no Bot has read yet (ADR 0069): the row under it, taking it back, reading it now. */
  queuedLine: (message: Message) => QueuedLine | null;
  withdrawLine: (message: Message) => Promise<void>;
  reEditLine: (message: Message) => void;
  insertLine: (message: Message) => void;
  lineBusy: (message: Message) => boolean;
  insertTitle: (message: Message) => string;
  lineNoteText: (message: Message) => string | null;
  toggleVersions: (message: Message) => Promise<void>;
  copyMessageBody: (id: string, text: string, event?: MouseEvent) => void;
  startQuoteReply: (message: Message) => void;
  handleMessageMouseDown: (e: MouseEvent) => void;
  handleMessageTouchStart: () => void;
  handleMessageContextMenu: (e: MouseEvent, message: Message) => void;
  pressControl: (message: Message, action: ControlOffer, taskId?: string, note?: string) => Promise<unknown>;
  replyAsk: (askId: string) => Promise<void>;
  showMessageTrace: (message: Message) => void;
};
