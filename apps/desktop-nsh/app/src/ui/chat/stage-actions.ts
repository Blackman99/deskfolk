/**
 * What the stage's rows ask it to do (the handlers in `ChatStage.svelte`'s script): annotations,
 * a picture or file opened over the app, replying to a question, a button under the app's line,
 * quoting, changing and taking back a line, earlier versions, copying, and the message's menu.
 * Their state lives here, not in the rows: the list recycles rows, and a row that remounts finds it again.
 */
import { Clipboard, computed, effect, platform, signal, type Point, type ViewRef } from "nsh";
import type { Annotation, Attachment, ControlOffer, Message, SessionSummary } from "@real-bot/protocol";
import { canEditMessage, lastEditableLine } from "../../m/chat/message-edit.ts";
import { extractAssociatedFiles } from "../../m/chat/message-context-menu.ts";
import { canQuoteReply, draftWithQuoteMention, quotedBotName } from "../../m/chat/quote-reply.ts";
import { queuedLine as queuedLineOf, type QueuedLine } from "../../m/chat/queued-line.ts";
import type { VersionsShown } from "../../m/chat/transcript-stage.ts";
import { showToast } from "../../m/toast.svelte.ts";
import { copy, runtime } from "../../runtime";
import { imageOrigin } from "./image-origin";
import type { ImageOrigin } from "./MessageImageLightbox";
import type { StageContext } from "./stage-context";

type OpenArtifact = (relpath: string, att?: Attachment, messageId?: string, forceTree?: boolean) => void;

export type OpenImage = { sessionId: string | null; attachment: Attachment | null; relpath: string | null; origin: ImageOrigin | null };
export type OpenFile = { sessionId: string | null; attachment: Attachment | null; relpath: string; messageId: string };
export type MessageMenu = { message: Message; x: number; y: number; selectedText: string | null; touch: boolean };

export function createStageActions(
  ctx: StageContext,
  deps: {
    selected: () => SessionSummary | null;
    onOpenArtifact: OpenArtifact;
    /** The caret goes to the composer (a quote reply, a starter chip, a line taken back). */
    focusComposer: () => void;
    /** Sending or answering goes to the newest line. */
    toBottom: () => void;
  },
) {
  const t = () => copy();
  const { selected } = deps;
  const view = ctx.view;

  // --- state the rows share ---
  const cardErrors = signal<Record<string, string>>({});
  const versionsShown = signal<Record<string, VersionsShown>>({});
  const approvalKeys = signal<Record<string, string>>({});
  const approvalKeyErrors = signal<Record<string, boolean>>({});
  const openStepsTurn = signal<string | null>(null);
  const copiedMessageId = signal<string | null>(null);
  const menu = signal<MessageMenu | null>(null);
  const textSheetId = signal<string | null>(null);
  const inlineImage = signal<OpenImage | null>(null);
  const inlineFile = signal<OpenFile | null>(null);
  const shownImage = computed(() => (inlineImage() && inlineImage()!.sessionId === (selected()?.id ?? null) ? inlineImage() : null));
  const shownFile = computed(() => (inlineFile() && inlineFile()!.sessionId === (selected()?.id ?? null) ? inlineFile() : null));
  const selectedMessageId = () => menu()?.message.id ?? null;
  const textSheetMessage = computed(() => {
    const id = textSheetId();
    return id ? (ctx.snapshot().messages.find((row) => row.id === id) ?? null) : null;
  });

  const closeMenu = () => menu.set(null);

  // --- annotations ---
  async function toggleAnnotation(messageId: string, row: Annotation, status: "open" | "resolved"): Promise<void> {
    const failed = await runtime.patchAnnotation(row.id, { status });
    const { [messageId]: _dropped, ...rest } = cardErrors();
    cardErrors.set(failed ? { ...rest, [messageId]: t().stream.annotationSaveFailed } : rest);
  }

  function openAnnotation(row: Annotation): void {
    // Through null, so opening the card that already has focus goes to it again.
    runtime.annotationFocusId = null;
    runtime.annotationFocusId = row.id;
    deps.onOpenArtifact(row.relpath, undefined, row.target_message_id);
  }

  /** Where a routed batch came from: the session of the delivery it quotes; null when neither says. */
  function annotationSourceSessionId(message: Message): string | null {
    const sourceId = message.annotation_source_message_id;
    if (!sourceId) return null;
    const rows = ctx.annotationIndex().get(message.id) ?? [];
    return rows.find((row) => row.target_message_id === sourceId)?.target_session_id ?? ctx.messageLookup().byId.get(sourceId)?.session_id ?? null;
  }

  /** A batch routed into your direct names the Bot↔Bot session its artifact came from. */
  function annotationSourceLabel(message: Message): string | null {
    const sessionId = annotationSourceSessionId(message);
    if (!sessionId) return null;
    const source = ctx.snapshot().sessions.find((s) => s.id === sessionId);
    return t().chat.annotationSource(source ? ctx.titleOf(source) : t().top.deleted);
  }

  function openAnnotationSource(message: Message): void {
    const sourceId = message.annotation_source_message_id;
    const sessionId = annotationSourceSessionId(message);
    if (!sourceId || !sessionId) return;
    void runtime.selectSession(sessionId, { messageId: sourceId });
  }

  // --- a picture or a file opened over the app ---
  function openInlineFile(att: Attachment, messageId: string): void {
    inlineFile.set({
      sessionId: selected()?.id ?? null,
      // A file the card only names has no row of its own; the workspace has the bytes.
      attachment: att.id.startsWith("handoff:") ? null : att,
      relpath: att.workspace_relpath,
      messageId,
    });
    closeMenu();
  }

  /** `from`: the view the picture was pressed in; the enlargement grows out of where it sits. */
  function openInlineImage(attachment: Attachment | null, relpath: string | null, from?: ViewRef | null): void {
    void imageOrigin(from).then((origin) => {
      inlineImage.set({ sessionId: selected()?.id ?? null, attachment, relpath, origin });
      closeMenu();
    });
  }

  /** A picture a message names by its path is drawn in the text as a chip: the Mac's 256 px copy. */
  async function loadBodyImage(relpath: string, signal: AbortSignal): Promise<Blob> {
    const client = runtime.client;
    if (!client) throw new Error("API unavailable");
    return client.getWorkspaceFileBlob(relpath, undefined, { background: true, signal, size: "thumb" });
  }

  function openBodyImage(message: Message, path: string, from?: ViewRef | null): void {
    const attachment = message.attachments.find((row) => row.workspace_relpath === path && !row.is_dir) ?? null;
    openInlineImage(attachment, path, from);
  }

  // --- the composer's neighbours ---
  function pickStarterPrompt(prompt: string): void {
    const v = view();
    if (v) v.draft = prompt;
    setTimeout(deps.focusComposer, 0);
  }

  /**
   * A button under the app's line. 改 on a check offered from your words (ADR 0040 P3) is yours to
   * say: it starts your line with the words the daemon gave and sends nothing. 逐条看 on old rules
   * opens the plan's board. Every other button goes to the daemon.
   */
  function pressControl(message: Message, action: ControlOffer, taskId?: string, note?: string): Promise<unknown> {
    if (action === "edit_check") {
      const draft = message.control?.kind === "check" ? message.control.edit_draft : undefined;
      if (draft) pickStarterPrompt(draft);
      return Promise.resolve(null);
    }
    if (action === "review_requirements") {
      if (message.control?.kind === "requirement") runtime.openTrace(message.control.task_id);
      return Promise.resolve(null);
    }
    // 退回 with what you want changed (a hand-over's card): the words go with the press.
    return note ? runtime.controlAction(message.id, action, taskId, note) : runtime.controlAction(message.id, action, taskId);
  }

  async function replyAsk(askId: string): Promise<void> {
    const record = runtime.getAskDraft(askId);
    const body = (record?.body ?? "").trim();
    const picks = record?.selected ?? [];
    if (!body && picks.length === 0) return;
    const submittedVersion = record?.version ?? 1;
    const res = await runtime.sendAsk(askId, { selected: picks, custom: body }, selected()?.id);
    if (res.status === "accepted") {
      runtime.clearAskDraft(askId, submittedVersion);
      deps.toBottom();
    } else if (res.status === "rejected") {
      const turn = ctx.snapshot().turns.find((trn) => trn.pending_ask_id === askId);
      const stillCurrent = Boolean(turn && turn.status === "waiting_ask" && turn.pending_ask_id === askId);
      runtime.setAskError(askId, !stillCurrent ? t().notifications.askEnded : res.error?.message || t().notifications.executionFailed);
    } else if (res.status === "unknown") {
      runtime.setAskError(askId, res.error?.message || t().disconnected.host);
    }
  }

  /** The composer hands the files over; scrolling to the new message is the stage's job. */
  async function sendFromComposer(files: File[], paths: string[] = []): Promise<boolean> {
    deps.toBottom();
    const sent = await runtime.send({
      attachments: files.length > 0 ? files : undefined,
      paths: paths.length > 0 ? paths : undefined,
      sessionId: selected()?.id,
    });
    deps.toBottom();
    return sent;
  }

  function startQuoteReply(message: Message): void {
    const v = view();
    if (ctx.lockedComposer() || !canQuoteReply(message) || !v) return;
    v.replyingToId = message.id;
    const name = quotedBotName(message, ctx.botsById());
    if (name) v.draft = draftWithQuoteMention(v.draft, name);
    setTimeout(deps.focusComposer, 0);
  }

  // --- changing, taking back and reading a line now ---
  /** A line of yours that can be changed from here now (ADR 0063); the daemon decides again on save. */
  const editable = (message: Message): boolean =>
    canEditMessage(message, {
      messageEdits: ctx.snapshot().messageEdits,
      connected: ctx.connected(),
      lockedComposer: ctx.lockedComposer(),
      annotated: (ctx.annotationIndex().get(message.id)?.length ?? 0) > 0,
    });
  const editingHere = (message: Message): boolean => view()?.editingMessageId === message.id;

  function startEdit(message: Message): void {
    const s = selected();
    if (!s || !editable(message)) return;
    runtime.startEdit(s.id, message);
  }

  /** ↑ in an empty composer: your newest line here that can be changed. True when one opened. */
  function editLastLine(): boolean {
    const line = lastEditableLine(ctx.stream().flatMap((item) => (item.type === "message" ? [item.message] : [])), editable);
    if (!line) return false;
    startEdit(line);
    return true;
  }

  /** Where a line of yours waits while no Bot has read it (ADR 0069), for the row under it. */
  const queuedLine = (message: Message): QueuedLine | null =>
    queuedLineOf(message, { queuedLineActions: ctx.snapshot().queuedLineActions, connected: ctx.connected(), lockedComposer: ctx.lockedComposer(), turnsHere: ctx.liveTurnsHere() });

  /** 撤回: the line taken back; its words wait in the box, ready to send again. */
  async function withdrawLine(message: Message): Promise<void> {
    const s = selected();
    if (!s) return;
    if (await runtime.withdrawLine(s.id, message)) setTimeout(deps.focusComposer, 0);
  }

  /** 重新编辑 on a line you took back: its words in the box again, after whatever is typed there. */
  function reEditLine(message: Message): void {
    const s = selected();
    if (!s || ctx.lockedComposer()) return;
    runtime.refillLine(s.id, message, { append: true });
    setTimeout(deps.focusComposer, 0);
  }

  /** 直接插入: the working Bot reads the line now. */
  function insertLine(message: Message): void {
    const s = selected();
    if (s) void runtime.insertLine(s.id, message);
  }

  const lineBusy = (message: Message): boolean => view()?.lineAction?.id === message.id;

  /** What 直接插入 cuts depends on who runs the Bot (ADR 0079). */
  function insertTitle(message: Message): string {
    if (message.delivery?.state === "held") return t().chat.insertNowHeldTitle;
    const bot = message.delivery ? ctx.botsById().get(message.delivery.bot_id) : undefined;
    if (bot?.runner === "antigravity") return t().chat.insertNowWaitsTitle;
    return bot?.runner ? t().chat.insertNowAgentTitle : t().chat.insertNowLoopTitle;
  }

  function lineNoteText(message: Message): string | null {
    const note = view()?.lineNote;
    if (!note || note.id !== message.id) return null;
    return note.code === "already_read" ? t().chat.lineAlreadyRead : note.code === "not_now" ? t().chat.lineNotNow : note.code === "held" ? t().chat.lineHeld : t().chat.lineActionFailed;
  }

  // What came of taking a line back or reading it now answers the press; it does not stay.
  effect(() => {
    const current = view();
    const note = current?.lineNote;
    if (!current || !note) return;
    const timer = setTimeout(() => {
      if (current.lineNote === note) current.lineNote = null;
    }, 6000);
    return () => clearTimeout(timer);
  });

  const editErrorText = (): string | null => {
    const error = view()?.editError;
    return error === "not_editable" ? t().chat.editNotEditable : error === "empty" ? t().chat.editEmpty : error === "failed" ? t().chat.editFailed : null;
  };

  async function toggleVersions(message: Message): Promise<void> {
    const at = message.edited_at ?? "";
    const open = versionsShown()[message.id];
    if (open && open.at === at) {
      const { [message.id]: _closed, ...rest } = versionsShown();
      versionsShown.set(rest);
      return;
    }
    versionsShown.set({ ...versionsShown(), [message.id]: { at, loading: true, failed: false, versions: [] } });
    const versions = await runtime.messageVersions(message.id, at);
    // Closed, or changed again, while it loaded.
    if (versionsShown()[message.id]?.at !== at) return;
    versionsShown.set({ ...versionsShown(), [message.id]: { at, loading: false, failed: versions === null, versions: versions ?? [] } });
  }

  // --- copying and the message's menu ---
  function copyMessageBody(id: string, text: string): void {
    void Clipboard.writeText(text).catch(() => {});
    copiedMessageId.set(id);
    setTimeout(() => {
      if (copiedMessageId() === id) copiedMessageId.set(null);
    }, 1800);
  }

  /** A secondary press, or the pill's "more": the message's menu at the pointer (a sheet where a finger pressed). */
  function openMenu(message: Message, at: Point): void {
    menu.set({ message, x: at.x, y: at.y, selectedText: null, touch: !platform.desktop });
  }

  function openFileTree(targetPath: string | null, message: Message): void {
    const path = targetPath ?? extractAssociatedFiles(message)[0];
    if (path) deps.onOpenArtifact(path, undefined, message.id, true);
  }

  function copyId(id: string): void {
    void Clipboard.writeText(id).catch(() => {});
    showToast(t().chat.copied);
  }

  /** The job a message is in, as its one tab (ADR 0086): the flow lands on the message's card and the ticket it was filed under is picked. */
  function showMessageTrace(message: Message): void {
    // A line in no job: its own flow, what it was read as and whom it woke (ADR 0083).
    if (!message.task_id) {
      runtime.openTrace(null, null, { line: message.id });
      return;
    }
    runtime.openTrace(message.task_id, { messageId: message.id, turnId: message.turn_id }, { ticket: message.ticket_id ?? null });
  }

  return {
    cardErrors,
    versionsShown,
    approvalKeys,
    approvalKeyErrors,
    openStepsTurn,
    copiedMessageId,
    menu,
    textSheetId,
    textSheetMessage,
    inlineImage,
    inlineFile,
    shownImage,
    shownFile,
    selectedMessageId,
    closeMenu,
    toggleAnnotation,
    openAnnotation,
    annotationSourceLabel,
    openAnnotationSource,
    openInlineFile,
    openInlineImage,
    loadBodyImage,
    openBodyImage,
    pickStarterPrompt,
    pressControl,
    replyAsk,
    sendFromComposer,
    startQuoteReply,
    editable,
    editingHere,
    startEdit,
    editLastLine,
    queuedLine,
    withdrawLine,
    reEditLine,
    insertLine,
    lineBusy,
    insertTitle,
    lineNoteText,
    editErrorText,
    toggleVersions,
    copyMessageBody,
    openMenu,
    openFileTree,
    copyId,
    showMessageTrace,
  };
}

export type StageActions = ReturnType<typeof createStageActions>;
