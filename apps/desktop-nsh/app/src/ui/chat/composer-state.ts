/**
 * What the composer works out from the runtime's snapshot and the conversation it is on
 * (`Composer.svelte`'s `$derived`s), as plain functions: which turn is live, why the box is shut,
 * what to type, what the editor's description says, whether Send is the main button, and what the
 * ✨ button does. `Composer.tsx` calls them inside its reactive reads.
 */
import type { Bot, SessionSummary } from "@real-bot/protocol";
import type { Copy } from "../../m/copy";
import { composerAction, lockedReason, type ComposerAction } from "../../m/chat/composer-mode";
import { isLiveStatus } from "../../m/chat/transcript";
import type { MessengerRuntime } from "../../m/runtime.svelte";
import type { SessionView } from "../../m/session-view.svelte";
import { classifySession, isFileDropSession, presentBotIds, youBotPeer } from "../../m/sidebar/session-groups";

type Snapshot = MessengerRuntime["snapshot"];

/** The live turn here: the focused one when it is live, else the first. */
export function liveTurnOf(snapshot: Snapshot, session: SessionSummary | null, focusedTurnId: string | null | undefined) {
  if (!session) return undefined;
  const here = snapshot.turns.filter((turn) => turn.session_id === session.id && isLiveStatus(turn.status));
  return here.find((turn) => turn.id === focusedTurnId) ?? here[0];
}

/** What a shut composer says in place of the box. */
export function lockedNoticeOf(session: SessionSummary | null, bots: ReadonlyMap<string, Bot>, t: Copy): string {
  const reason = lockedReason(session, bots);
  if (reason === "archived") return t.chat.groupLockedNotice;
  if (reason === "bot-bot") return t.chat.botBotLockedNotice;
  return t.chat.lockedNotice;
}

/** What to type here, never the button's own word: an empty box that said 「发送」 read as a label. */
export function placeholderOf(session: SessionSummary | null, peerBot: Bot | null, t: Copy): string {
  if (session && isFileDropSession(session)) return t.sidebar.fileDropPlaceholder;
  const kind = session ? classifySession(session) : null;
  if (kind === "you-bot" && peerBot) return `${t.chat.replyPrompt} ${peerBot.name}...`;
  return kind === "group" ? t.composer.groupPrompt : t.composer.messagePrompt;
}

/**
 * The editor's description, for readers only. In a direct whose Bot is at work, or still reading
 * your last line, what you send reaches it at its next step; only where Send really waits (an older
 * daemon) does it say to wait for the reply. Which key sends is the interface profile's.
 */
export function composerHintOf(input: {
  session: SessionSummary | null;
  liveTurn: boolean;
  pending: boolean;
  modSends: boolean;
  modEnter: string;
  turnInbox: boolean;
  linesInOrder: boolean;
  t: Copy;
}): string {
  const { t } = input;
  if (input.session?.kind === "group" || !(input.liveTurn || input.pending)) return input.modSends ? t.composer.modSendHint(input.modEnter) : t.chat.sendHint;
  const waits = (input.liveTurn && !input.turnInbox) || (input.pending && !input.linesInOrder);
  if (input.modSends) return waits ? t.composer.modWaitingHint : t.composer.modWorkingHint(input.modEnter);
  return waits ? t.composer.waitingHint : t.composer.workingHint;
}

/** Everything the composer's buttons read, from one conversation's state. */
export type ComposerDerived = {
  connected: boolean;
  kind: ReturnType<typeof classifySession> | null;
  fileDrop: boolean;
  peerBot: Bot | null;
  locked: boolean;
  liveTurn: boolean;
  pending: boolean;
  hasContent: boolean;
  primary: ComposerAction;
  directStop: boolean;
  canSuggest: boolean;
  suggestionsShown: boolean;
  suggestWaiting: boolean;
  suggestBlocked: boolean;
};

export function deriveComposer(input: {
  snapshot: Snapshot;
  connected: boolean;
  session: SessionSummary | null;
  view: SessionView | null;
  botsById: ReadonlyMap<string, Bot>;
  staged: number;
}): ComposerDerived {
  const { snapshot, session, view } = input;
  const kind = session ? classifySession(session) : null;
  const fileDrop = session ? isFileDropSession(session) : false;
  const peer = session ? youBotPeer(session) : null;
  const peerBot = peer ? (input.botsById.get(peer) ?? null) : null;
  const locked = lockedReason(session, input.botsById) !== null;
  const live = liveTurnOf(snapshot, session, view?.focusedTurnId);
  const pending = session ? snapshot.pendingJudgements.some((j) => j.session_id === session.id) : false;
  const hasContent = Boolean(view?.draft.trim()) || input.staged > 0;
  const primary = composerAction({
    connected: input.connected,
    hasSession: Boolean(session),
    locked,
    hasLiveTurn: Boolean(live),
    pendingJudgement: pending,
    busy: view?.sending ?? false,
    hasContent,
    sessionKind: fileDrop ? "file-drop" : (session?.kind ?? null),
    turnInbox: snapshot.turnInbox,
    linesInOrder: snapshot.linesInOrder,
  });
  const suggestionsShown = (view?.composerSuggestions.length ?? 0) > 0 || Boolean(view?.suggestionsEmpty);
  // Drafted while a reply is still coming, they would be about the past the moment it landed.
  const suggestWaiting = Boolean(live) || pending;
  return {
    connected: input.connected,
    kind,
    fileDrop,
    peerBot,
    locked,
    liveTurn: Boolean(live),
    pending,
    hasContent,
    primary,
    // A direct's one Stop: beside Send while its Bot has a turn going here.
    directStop: kind === "you-bot" && !locked && Boolean(live) && primary.kind === "send",
    // Somewhere to send what ✨ drafts: not a locked composer, and no Bot reads the file conversation.
    canSuggest: Boolean(session) && !locked && !fileDrop,
    suggestionsShown,
    suggestWaiting,
    // Nothing a press could do now; drafts on the way or out can always be put away.
    suggestBlocked: !view?.suggestionsLoading && !suggestionsShown && (!input.connected || suggestWaiting || Boolean(view?.sending)),
  };
}

/** The ✨ button's name: what one press would do now. */
export function suggestTitleOf(d: ComposerDerived, loading: boolean, t: Copy): string {
  if (loading) return t.composer.suggestStop;
  if (d.suggestionsShown) return t.composer.suggestHide;
  return d.suggestWaiting ? t.composer.suggestWait : t.composer.suggest;
}

/** The Bots an `@` offers: a group's present ones, else the Bots you can write to. */
export function mentionBotsOf(session: SessionSummary | null, botsById: ReadonlyMap<string, Bot>, visible: readonly Bot[]): readonly Bot[] {
  if (session?.kind !== "group") return visible;
  return presentBotIds(session).flatMap((id) => {
    const bot = botsById.get(id);
    return bot ? [bot] : [];
  });
}

/** The name a file dropped by its `file:` URL gets. */
export function nameOfUri(uri: string): string {
  const last = uri.split("/").filter(Boolean).pop() ?? "file";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Reads the local files a drop or a Finder copy names (`file:` URLs) into `File`s; one that cannot be read is left out. */
export async function filesFromUris(uris: readonly string[]): Promise<File[]> {
  const files: File[] = [];
  for (const uri of uris) {
    try {
      const blob = await (await fetch(uri)).blob();
      files.push(new File([blob], nameOfUri(uri), { type: blob.type }));
    } catch {
      // Not readable here (a folder, a file that went away): nothing to stage.
    }
  }
  return files;
}
