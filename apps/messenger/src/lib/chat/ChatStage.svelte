<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { USER_MEMBER, type Attachment, type Bot, type Message, type SessionSummary, type Turn,
		type Annotation, type ControlOffer,
	} from '@real-bot/protocol';
	import Composer from './Composer.svelte';
	import MessageImageLightbox, { type ImageOrigin } from './MessageImageLightbox.svelte';
	import MessageFileOverlay from './MessageFileOverlay.svelte';
	import { copyableImageAt } from '../image-context.ts';
	import { desktopPlatform } from '../platform.ts';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import AttributionDialog from './AttributionDialog.svelte';
	import { attributable, attributionChipIds, planUsage } from './attribution.ts';
	import DelegationRecords from './DelegationRecords.svelte';
	import { annotationsByMessage } from '../annotations/model.ts';
	import { indexBotDmsByOrigin } from './bot-dm-entries.ts';
	import SessionAvatar from '../SessionAvatar.svelte';
	import EmptyState from '../EmptyState.svelte';
	import {
		buildMessageLookup,
		formatDateDivider,
		formatMessageTime,
		groupTranscript,
		isAppLine,
		isDifferentDay,
		restartAnnounced
	} from './chat-view.ts';
	import { composerLocked } from './composer-mode.ts';
	import type { Copy } from '../copy.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import type { RenderMarkdownOptions } from '../markdown.ts';
	import { classifySession, isFileDropSession, presentBotIds, youBotPeer } from '../sidebar/session-groups.ts';
	import { canQuoteReply, draftWithQuoteMention, quotedBotName } from './quote-reply.ts';
	import MessageContextMenu from './MessageContextMenu.svelte';
	import MessageTextSheet from './MessageTextSheet.svelte';
	import { canEditMessage, lastEditableLine } from './message-edit.ts';
	import { queuedLine as queuedLineOf, type QueuedLine } from './queued-line.ts';
	import { extractAssociatedFiles } from './message-context-menu.ts';
	import { handedOverPaths } from '../overlays/artifacts.ts';
	import type { TraceViewKind } from '../overlays/trace-view.ts';
	import { messageDisplayBody } from './message-body.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import { composeTranscript, isLiveStatus } from './transcript.ts';
	import { windowedItems } from './history-window.ts';
	import { INDEX_MIN_MARKS, messageIndexMarks } from './message-index.ts';
	import MessageIndex from './MessageIndex.svelte';
	import {
		transcriptReadingReady,
		desktopReadingMode,
		TRANSCRIPT_VISIBLE_MS
	} from '../notifications/reading.ts';
	import { copyText } from '../clipboard.ts';
	import { ChatScroll } from './chat-scroll.svelte.ts';
	import ChatWelcome from './ChatWelcome.svelte';
	import TranscriptAsk from './TranscriptAsk.svelte';
	import TranscriptApproval from './TranscriptApproval.svelte';
	import TranscriptSystem from './TranscriptSystem.svelte';
	import TranscriptUserGroup from './TranscriptUserGroup.svelte';
	import TranscriptBotGroup from './TranscriptBotGroup.svelte';
	import type { TranscriptStage, VersionsShown } from './transcript-stage.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary | null;
		onOpenProfile: (botId: string) => void;
		onOpenArtifact: (
			relpath: string,
			att?: Attachment,
			messageId?: string,
			forceTree?: boolean
		) => void;
		onCreateBot: () => void;
	};

	let { runtime, t, selected, onOpenProfile, onOpenArtifact, onCreateBot }: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	/**
	 * This conversation's own state: its draft, reply, highlight, history cursor, send in flight.
	 * Not the runtime's forwards, which follow whichever pane has the keyboard — with two
	 * conversations on screen, reading those is reading the other one's.
	 */
	const view = $derived(selected ? runtime.sessionView(selected.id) : null);
	const highlightedId = $derived(view?.highlightedMessageId ?? null);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	const connected = $derived(runtime.connection === 'connected');
	const selectedKind = $derived(selected ? classifySession(selected) : null);
	const fileDrop = $derived(selected ? isFileDropSession(selected) : false);
	const stageSessionId = $derived(selected?.id ?? null);
	// Scalar keys refresh context when a durable question arrives, not on answer updates/tokens.
	const workQuestionContextKey = $derived(snapshot.messages
		.filter((row) => row.session_id === stageSessionId && row.control?.kind === 'work_question')
		.map((row) => `${row.id}:${row.control?.kind === 'work_question' ? row.control.task_id : ''}`).join('|'));
	// The list loads from one of the conversation's lines: opened before its lines have arrived, it
	// waits for them (2026-10-03: a conversation reopened read 「一件事」 on every tag until a reload).
	const hasLines = $derived(snapshot.messages.some((row) => row.session_id === stageSessionId && (row.kind === 'user' || row.kind === 'bot')));
	$effect(() => {
		const id = stageSessionId;
		const questions = workQuestionContextKey;
		const ready = hasLines;
		if (id && connected && !fileDrop && (ready || questions)) void untrack(() => {
			const question = questions ? snapshot.messages.find((row) => row.session_id === id && row.control?.kind === 'work_question') : undefined;
			void runtime.loadAttributionPlans(id, question?.id);
		});
	});
	// Stable scalar dependencies: streaming tokens/session.upsert do not re-read the thread.
	$effect(() => {
		const id = stageSessionId;
		void runtime.delegationSnapshotEpoch;
		if (id && selectedKind === 'bot-bot' && connected) void untrack(() => runtime.loadDelegations(id));
	});
	const delegations = $derived(selectedKind === 'bot-bot'
		? snapshot.delegations.filter((row) => row.thread_session_id === stageSessionId) : []);
	const linkedDelegationMessages = $derived(new Set(delegations.flatMap((row) =>
		[row.request_message_id, row.result_message_id].filter((id): id is string => id !== null))));
	// The other side always shows who is talking: in a direct the app's lines sit among the
	// Bot's, and without the mark beside them a receipt reads as the Bot speaking. Your own side
	// in a direct is only ever you, so your portrait there would just repeat the 你 above it.
	const showOwnAvatar = $derived(selectedKind !== 'you-bot');
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(selectedPeer ? (botsById.get(selectedPeer) ?? null) : null);
	const lockedComposer = $derived(composerLocked(selected, botsById));
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived, fileDrop: t.sidebar.fileDrop });
	const statusLabels = $derived({
		running: t.sidebar.statusRunning,
		replying: t.sidebar.statusReplying,
		waitingApproval: t.sidebar.statusWaitingApproval,
		waitingAsk: t.sidebar.statusWaitingAsk,
		failed: t.sidebar.statusFailed,
		interrupted: t.sidebar.statusInterrupted,
		idle: t.sidebar.statusIdle
	});
	// Depends on the roster, not on turns, so a streaming token does not rebuild it.
	const botDmIndex = $derived(
		indexBotDmsByOrigin(snapshot.sessions, selected?.id ?? null, snapshot.turns, botsById)
	);
	/** Which line's filing is being changed, in the dialog; its tag and its menu both open it. */
	let attributionEditId = $state<string | null>(null);
	const attributionTarget = $derived(attributionEditId ? (snapshot.messages.find((row) => row.id === attributionEditId) ?? null) : null);
	/** Only the first line of a run about the same job shows its tag; the rest are still changeable from their menu. */
	const attributionChips = $derived(attributionChipIds(snapshot.messages.filter((row) => row.session_id === selected?.id)));
	// Keyed by the message that carries them; a separate collection, so a batch's cards never
	// touch the memoized message wrappers.
	const annotationIndex = $derived(annotationsByMessage(snapshot.annotations));

	/** Why a card's status change failed, by the message that carries the batch. */
	let cardErrors = $state<Record<string, string>>({});

	async function toggleAnnotation(messageId: string, row: Annotation, status: 'open' | 'resolved'): Promise<void> {
		const failed = await runtime.patchAnnotation(row.id, { status });
		const { [messageId]: _dropped, ...rest } = cardErrors;
		cardErrors = failed ? { ...rest, [messageId]: t.stream.annotationSaveFailed } : rest;
	}

	function openAnnotation(row: Annotation): void {
		// Through null, so opening the card that already has focus goes to it again.
		runtime.annotationFocusId = null;
		runtime.annotationFocusId = row.id;
		onOpenArtifact(row.relpath, undefined, row.target_message_id);
	}

	/**
	 * Where a routed batch came from: the session of the delivery it quotes. A batch can mix drafts
	 * from several sessions, so it is read off the row written on that delivery (or the delivery
	 * itself when the snapshot holds it), not off whichever row is oldest. Null when neither says —
	 * no link rather than one to the wrong conversation.
	 */
	function annotationSourceSessionId(message: Message): string | null {
		const sourceId = message.annotation_source_message_id;
		if (!sourceId) return null;
		const rows = annotationIndex.get(message.id) ?? [];
		return rows.find((row) => row.target_message_id === sourceId)?.target_session_id
			?? messageLookup.byId.get(sourceId)?.session_id
			?? null;
	}

	/** A batch routed into your direct names the Bot↔Bot session its artifact came from. */
	function annotationSourceLabel(message: Message): string | null {
		const sessionId = annotationSourceSessionId(message);
		if (!sessionId) return null;
		const sourceSession = snapshot.sessions.find((s) => s.id === sessionId);
		return t.chat.annotationSource(sourceSession ? titleOf(sourceSession) : t.top.deleted);
	}

	function openAnnotationSource(message: Message): void {
		const sourceId = message.annotation_source_message_id;
		const sessionId = annotationSourceSessionId(message);
		if (!sourceId || !sessionId) return;
		void runtime.selectSession(sessionId, { messageId: sourceId });
	}

	let composer = $state<{ focus: () => void } | null>(null);
	/** A picture opened from this transcript, enlarged over the whole app. */
	let inlineImage = $state<{
		sessionId: string | null;
		attachment: Attachment | null;
		relpath: string | null;
		origin: ImageOrigin | null;
		placeholder: string | null;
	} | null>(null);
	const shownImage = $derived(
		inlineImage && inlineImage.sessionId === (selected?.id ?? null) ? inlineImage : null
	);
	/** Any other file opened from a card's chip, over the whole app the way a picture is. */
	let inlineFile = $state<{
		sessionId: string | null;
		attachment: Attachment | null;
		relpath: string;
		messageId: string;
	} | null>(null);
	const shownFile = $derived(
		inlineFile && inlineFile.sessionId === (selected?.id ?? null) ? inlineFile : null
	);

	function pictureOrigin(from?: HTMLElement | null): ImageOrigin | null {
		const picture =
			from?.querySelector('img, .attachment-chip-pending, .md-artifact-pending') ?? from;
		if (!(picture instanceof HTMLElement)) return null;
		const box = picture.getBoundingClientRect();
		if (box.width < 2 || box.height < 2) return null;
		return { top: box.top, left: box.left, width: box.width, height: box.height };
	}

	/**
	 * The thumbnail already on screen for this picture, if any: the enlargement shows it at the
	 * picture's own proportions while the real bytes come, instead of growing to a guess first.
	 * The chip keeps owning the object URL; it stays mounted under the enlargement.
	 */
	function pictureStandIn(from?: HTMLElement | null): string | null {
		const img = from instanceof HTMLImageElement ? from : from?.querySelector('img');
		return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0 ? img.currentSrc || img.src : null;
	}

	function openInlineFile(att: Attachment, messageId: string): void {
		inlineFile = {
			sessionId: selected?.id ?? null,
			// A file the card only names has no row of its own; the workspace has the bytes.
			attachment: att.id.startsWith('handoff:') ? null : att,
			relpath: att.workspace_relpath,
			messageId
		};
		closeMessageContextMenu();
	}

	function openInlineImage(attachment: Attachment | null, relpath: string | null, from?: HTMLElement | null): void {
		inlineImage = {
			sessionId: selected?.id ?? null,
			attachment,
			relpath,
			origin: pictureOrigin(from),
			placeholder: pictureStandIn(from)
		};
		closeMessageContextMenu();
	}

	/**
	 * A picture a message names by its path is drawn in the text as a chip, the way an attachment
	 * is: the Mac's 256 px copy, waiting behind anything opened on purpose.
	 */
	async function loadBodyImage(relpath: string, signal: AbortSignal): Promise<Blob> {
		const client = runtime.client;
		if (!client) throw new Error('API unavailable');
		return client.getWorkspaceFileBlob(relpath, undefined, { background: true, signal, size: 'thumb' });
	}

	function openBodyImage(message: Message, path: string, from?: HTMLElement | null): void {
		const attachment =
			message.attachments.find((row) => row.workspace_relpath === path && !row.is_dir) ?? null;
		openInlineImage(attachment, path, from);
	}

	function titleOf(session: SessionSummary): string {
		return sessionTitle(session, botsById, rosterLabels);
	}

	let approvalKeys = $state<Record<string, string>>({});

	let approvalKeyErrors = $state<Record<string, boolean>>({});

	const stream = $derived(
		selected
			? composeTranscript(
					snapshot.messages,
					snapshot.turns,
					selected.id,
					snapshot.pendingJudgements,
				).filter((item) => item.type !== 'message' || !linkedDelegationMessages.has(item.message.id))
			: []
	);

	/**
	 * The newest message, by id alone. Reading the whole transcript to decide what has been read
	 * re-armed the read on every new snapshot object, and a read publishes `session.upsert`, which
	 * is a new snapshot — so the read repeated once a second for as long as the window stayed on
	 * the latest message, rebuilding every pane that hangs off the snapshot with it.
	 */
	const lastMessageId = $derived.by(() => {
		for (let i = stream.length - 1; i >= 0; i--) {
			const item = stream[i];
			if (item.type === 'message') return item.message.id;
		}
		return null;
	});

	/** 「中断」 lines a restart notice here offers 继续 for; they do not offer their own as well. */
	const announced = $derived(
		restartAnnounced(stream.flatMap((item) => (item.type === 'message' ? [item.message] : [])))
	);

	/** Quote targets and "what came before" for the rows on screen, indexed once per message list. */
	const messageLookup = $derived(buildMessageLookup(snapshot.messages));

	/**
	 * The transcript's scroll: stuck to the newest line or not, the jumps to a message, and how much
	 * of the history is mounted. See chat-scroll.svelte.ts; its effects are declared below.
	 */
	const scroll: ChatScroll = new ChatScroll({
		runtime: () => runtime,
		selected: () => selected,
		view: () => view,
		snapshot: () => snapshot,
		highlightedId: () => highlightedId,
		stream: () => stream,
		hiddenOlder: () => hiddenOlder,
		indexMarks: () => indexMarks
	});
	const windowedStream = $derived(windowedItems(stream, scroll.historyWindow));
	const hiddenOlder = $derived(stream.length - windowedStream.length);
	const groupedStream = $derived(groupTranscript(windowedStream));
	/**
	 * The reply each finished turn's commands go under: its last Bot message here. Progress lines it
	 * sent on the way share its turn, and the card would repeat under each of them.
	 */
	const commandHosts = $derived.by(() => {
		// While the turn runs, its commands are in its working bubble: a progress line it sent on the
		// way would only repeat them, and from a record that is already behind.
		const running = new Set(snapshot.turns.filter((turn) => turn.status === 'running').map((turn) => turn.id));
		const last = new Map<string, string>();
		for (const item of windowedStream) {
			if (item.type === 'message' && item.message.kind === 'bot' && item.message.turn_id && !running.has(item.message.turn_id)) {
				last.set(item.message.turn_id, item.message.id);
			}
		}
		return new Set(last.values());
	});

	/** One anchor for each visible message, including the unmounted history. */
	const indexMarks = $derived(messageIndexMarks(stream));
	const showMessageIndex = $derived(indexMarks.length >= INDEX_MIN_MARKS || Boolean(view?.hasOlderMessages));

	const liveTurnsHere = $derived(
		selected
			? snapshot.turns.filter((turn) => turn.session_id === selected.id && isLiveStatus(turn.status))
			: []
	);

	const pendingHere = $derived(
		selected ? snapshot.pendingJudgements.filter((j) => j.session_id === selected.id) : []
	);

	const liveTurn = $derived(
		liveTurnsHere.find((turn) => turn.id === view?.focusedTurnId) ?? liveTurnsHere[0]
	);

	async function replyAsk(askId: string): Promise<void> {
		const record = runtime.getAskDraft(askId);
		const body = (record?.body ?? '').trim();
		const picks = record?.selected ?? [];
		if (!body && picks.length === 0) return;
		const submittedVersion = record?.version ?? 1;
		scroll.stickToBottom = true;
		const res = await runtime.sendAsk(askId, { selected: picks, custom: body }, selected?.id);
		if (res.status === 'accepted') {
			runtime.clearAskDraft(askId, submittedVersion);
			await tick();
			scroll.scrollToBottom(false);
		} else if (res.status === 'rejected') {
			const turn = snapshot.turns.find((trn) => trn.pending_ask_id === askId);
			const stillCurrent = Boolean(turn && turn.status === 'waiting_ask' && turn.pending_ask_id === askId);
			const errText = !stillCurrent
				? t.notifications.askEnded
				: (res.error?.message || t.notifications.executionFailed);
			runtime.setAskError(askId, errText);
		} else if (res.status === 'unknown') {
			runtime.setAskError(askId, res.error?.message || t.disconnected.host);
		}
	}

	let readTimer: ReturnType<typeof setTimeout> | null = null;
	let windowFocused = $state(typeof document !== 'undefined' ? document.hasFocus() : true);
	let windowVisible = $state(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true);

	onMount(() => {
		const onFocus = () => {
			windowFocused = true;
			if (runtime.isDesktopShell) {
				void runtime.pollDesktopNativeState();
				void runtime.reportDesktopNotificationView(scroll.stickToBottom);
			}
		};
		const onBlur = () => {
			windowFocused = false;
			if (readTimer) {
				clearTimeout(readTimer);
				readTimer = null;
			}
			if (runtime.isDesktopShell) void runtime.reportDesktopNotificationView(false);
		};
		const onVisibility = () => {
			windowVisible = document.visibilityState === 'visible';
			if (!windowVisible && readTimer) {
				clearTimeout(readTimer);
				readTimer = null;
			}
			if (runtime.isDesktopShell) void runtime.reportDesktopNotificationView(windowVisible && scroll.stickToBottom);
		};
		window.addEventListener('focus', onFocus);
		window.addEventListener('blur', onBlur);
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			window.removeEventListener('focus', onFocus);
			window.removeEventListener('blur', onBlur);
			document.removeEventListener('visibilitychange', onVisibility);
			if (readTimer) {
				clearTimeout(readTimer);
				readTimer = null;
			}
		};
	});

	$effect(() => {
		// Each visible pane times its own read, whichever of them has the keyboard.
		const sId = selected?.id ?? null;
		const lastMsgId = lastMessageId;
		// A note the conversation does not list has a notification and no line: its arrival is
		// what lets the read of the last line go once more, and read it.
		const noticeMark = sId ? runtime.noticeMark(sId) : 0;
		void windowFocused;
		void windowVisible;
		if (!sId || !lastMsgId) return;
		const facts = {
			visibility: document.visibilityState,
			hasFocus: document.hasFocus(),
			connected: runtime.connection === 'connected',
			snapshotReady: true,
			overlayBlocksTranscript: runtime.settingsOpen || runtime.workspaceOpen
		};
		const mode = desktopReadingMode(runtime.isDesktopShell, runtime.nativeCapabilities);
		const nativeFacts = runtime.isDesktopShell ? runtime.nativeFocusFacts : null;
		const ready = transcriptReadingReady(facts, mode, nativeFacts);
		if (!ready || !scroll.stickToBottom) {
			if (readTimer) {
				clearTimeout(readTimer);
				readTimer = null;
			}
			return;
		}
		if (readTimer) clearTimeout(readTimer);
		readTimer = setTimeout(() => {
			if (typeof document !== 'undefined') {
				if (!document.hasFocus() || document.visibilityState !== 'visible') {
					readTimer = null;
					return;
				}
			}
			if (selected?.id === sId && lastMsgId) {
				void runtime.submitBoundedRead(sId, lastMsgId, noticeMark);
			}
			readTimer = null;
		}, TRANSCRIPT_VISIBLE_MS);
		return () => {
			if (readTimer) {
				clearTimeout(readTimer);
				readTimer = null;
			}
		};
	});

	let copiedMessageId = $state<string | null>(null);

	let nowMs = $state(Date.now());

	// Another conversation in this stage starts it over. Clicking into another pane is not that.
	$effect(() => scroll.startOver());

	$effect(() => scroll.followHighlight());

	$effect(() => scroll.followSize());

	$effect(() => {
		if (liveTurnsHere.length > 0) {
			const timer = setInterval(() => {
				nowMs = Date.now();
			}, 250);
			return () => clearInterval(timer);
		}
	});

	/** The working bubble whose steps are open: one at a time, and it goes with its turn. */
	let openStepsTurn = $state<string | null>(null);

	/** A Bot's name for the buttons under a line about your stops. */
	function botNameOf(id: string): string {
		return botsById.get(id)?.name ?? t.top.deleted;
	}

	function who(message: Message): string {
		if (message.author === USER_MEMBER) return t.common.you;
		return botsById.get(message.author)?.name ?? t.top.deleted;
	}

	function whoAuthor(author: string): string {
		if (author === USER_MEMBER) return t.common.you;
		return botsById.get(author)?.name ?? t.top.deleted;
	}

	/**
	 * Markdown options per bubble, reused as long as nothing in them changed.
	 *
	 * This used to build a fresh object for every bubble on every render. The object is a prop,
	 * so a new one means `renderMarkdown` runs again — marked, sanitize-html and both mention
	 * passes, for the whole transcript, on every streamed token. The roster and the member list
	 * only move when the snapshot says so, so they are derived once and the per-message object is
	 * kept until the message itself is replaced or that signature changes.
	 */
	const mentionMembers = $derived(
		selected
			? presentBotIds(selected)
					.map((id) => botsById.get(id))
					.filter((b): b is Bot => Boolean(b))
			: snapshot.bots
	);
	const markdownSignature = $derived(
		[
			snapshot.bots.map((bot) => `${bot.id}:${bot.name}`).join(','),
			mentionMembers.map((bot) => bot.id).join(','),
			t.stream.mentionUnresolved
		].join('|')
	);
	let markdownOptsCache = new WeakMap<Message, RenderMarkdownOptions>();
	let markdownOptsSignature = '';

	function messageShowsAttachments(message: Message): boolean {
		return handedOverPaths(message.body, message.attachments.map((att) => att.workspace_relpath)).length > 0;
	}

	function messageBody(message: Message): string {
		return messageDisplayBody(message.body, message.attachments.map((att) => att.workspace_relpath));
	}

	function markdownOpts(message?: Message, extra?: { streaming?: boolean }): RenderMarkdownOptions {
		if (markdownOptsSignature !== markdownSignature) {
			markdownOptsCache = new WeakMap();
			markdownOptsSignature = markdownSignature;
		}
		if (!message) {
			return {
				streaming: extra?.streaming,
				extraPaths: [],
				mentionBots: snapshot.bots,
				mentionMembers,
				unresolvedMentionTitle: t.stream.mentionUnresolved
			};
		}
		const cached = markdownOptsCache.get(message);
		if (cached) return cached;
		const opts: RenderMarkdownOptions = {
			streaming: extra?.streaming,
			extraPaths: message.attachments.map((att) => att.workspace_relpath),
			mentionBots: snapshot.bots,
			mentionMembers,
			unresolvedMentionTitle: t.stream.mentionUnresolved
		};
		markdownOptsCache.set(message, opts);
		return opts;
	}

	function pickStarterPrompt(prompt: string): void {
		if (view) view.draft = prompt;
		void tick().then(() => composer?.focus());
	}

	/**
	 * A button under the app's line. 改 on a check offered from your words (ADR 0040 P3) is yours to
	 * say: it starts your line with the words the daemon gave (「片长改成 」) and sends nothing, so the
	 * number you type is what the check stands on. 逐条看 on old rules opens the plan's board, where
	 * each has its own buttons. Every other button goes to the daemon.
	 */
	function pressControl(message: Message, action: ControlOffer, taskId?: string, note?: string): Promise<unknown> {
		if (action === 'edit_check') {
			const draft = message.control?.kind === 'check' ? message.control.edit_draft : undefined;
			if (draft) pickStarterPrompt(draft);
			return Promise.resolve(null);
		}
		if (action === 'review_requirements') {
			if (message.control?.kind === 'requirement') runtime.openTrace(message.control.task_id);
			return Promise.resolve(null);
		}
		// 退回 with what you want changed (a hand-over's card): the words go with the press.
		return note ? runtime.controlAction(message.id, action, taskId, note) : runtime.controlAction(message.id, action, taskId);
	}

	/** The composer hands the files over; scrolling to the new message is the stage's job. */
	async function sendFromComposer(files: File[], paths: string[] = []): Promise<boolean> {
		scroll.stickToBottom = true;
		const sent = await runtime.send({
			attachments: files.length > 0 ? files : undefined,
			paths: paths.length > 0 ? paths : undefined,
			sessionId: selected?.id
		});
		await tick();
		scroll.scrollToBottom(false);
		return sent;
	}

	function startQuoteReply(message: Message): void {
		if (lockedComposer || !canQuoteReply(message)) return;
		if (!view) return;
		view.replyingToId = message.id;
		const name = quotedBotName(message, botsById);
		if (name) view.draft = draftWithQuoteMention(view.draft, name);
		void tick().then(() => composer?.focus());
	}

	/** A line of yours that can be changed from here now (ADR 0063); the daemon decides again on save. */
	function editable(message: Message): boolean {
		return canEditMessage(message, {
			messageEdits: snapshot.messageEdits,
			connected,
			lockedComposer,
			annotated: (annotationIndex.get(message.id)?.length ?? 0) > 0
		});
	}

	function editingHere(message: Message): boolean {
		return view?.editingMessageId === message.id;
	}

	/** Opens the line for changing, in its own bubble. */
	function startEdit(message: Message): void {
		if (!selected || !editable(message)) return;
		runtime.startEdit(selected.id, message);
	}

	/** ↑ in an empty composer: your newest line here that can be changed. True when one opened. */
	function editLastLine(): boolean {
		const line = lastEditableLine(stream.flatMap((item) => (item.type === 'message' ? [item.message] : [])), editable);
		if (!line) return false;
		startEdit(line);
		return true;
	}

	/** Where a line of yours waits while no Bot has read it (ADR 0069), for the row under it. */
	function queuedLine(message: Message): QueuedLine | null {
		return queuedLineOf(message, { queuedLineActions: snapshot.queuedLineActions, connected, lockedComposer, turnsHere: liveTurnsHere });
	}

	/** 撤回: the line taken back; its words wait in the box, ready to send again. */
	async function withdrawLine(message: Message): Promise<void> {
		if (!selected) return;
		if (await runtime.withdrawLine(selected.id, message)) void tick().then(() => composer?.focus());
	}

	/** 重新编辑 on a line you took back: its words in the box again, after whatever is typed there. */
	function reEditLine(message: Message): void {
		if (!selected || lockedComposer) return;
		runtime.refillLine(selected.id, message, { append: true });
		void tick().then(() => composer?.focus());
	}

	/** 直接插入: the working Bot reads the line now. */
	function insertLine(message: Message): void {
		if (!selected) return;
		void runtime.insertLine(selected.id, message);
	}

	function lineBusy(message: Message): boolean {
		return view?.lineAction?.id === message.id;
	}

	/** What 直接插入 cuts depends on who runs the Bot: Claude Code stops a running command too. */
	function insertTitle(message: Message): string {
		if (message.delivery?.state === 'held') return t.chat.insertNowHeldTitle;
		const bot = message.delivery ? botsById.get(message.delivery.bot_id) : undefined;
		return bot?.runner === 'claude_code' ? t.chat.insertNowAgentTitle : t.chat.insertNowLoopTitle;
	}

	function lineNoteText(message: Message): string | null {
		const note = view?.lineNote;
		if (!note || note.id !== message.id) return null;
		return note.code === 'already_read' ? t.chat.lineAlreadyRead : note.code === 'not_now' ? t.chat.lineNotNow : note.code === 'held' ? t.chat.lineHeld : t.chat.lineActionFailed;
	}

	/** What came of taking a line back or reading it now answers the press; it does not stay. */
	$effect(() => {
		const current = view;
		const note = current?.lineNote;
		if (!current || !note) return;
		const timer = setTimeout(() => {
			if (current.lineNote === note) current.lineNote = null;
		}, 6000);
		return () => clearTimeout(timer);
	});

	const editErrorText = $derived(
		view?.editError === 'not_editable'
			? t.chat.editNotEditable
			: view?.editError === 'empty'
				? t.chat.editEmpty
				: view?.editError === 'failed'
					? t.chat.editFailed
					: null
	);

	let versionsShown = $state<Record<string, VersionsShown>>({});

	async function toggleVersions(message: Message): Promise<void> {
		const at = message.edited_at ?? '';
		const open = versionsShown[message.id];
		if (open && open.at === at) {
			const { [message.id]: _closed, ...rest } = versionsShown;
			versionsShown = rest;
			return;
		}
		versionsShown = { ...versionsShown, [message.id]: { at, loading: true, failed: false, versions: [] } };
		const versions = await runtime.messageVersions(message.id, at);
		// Closed, or changed again, while it loaded.
		if (versionsShown[message.id]?.at !== at) return;
		versionsShown = { ...versionsShown, [message.id]: { at, loading: false, failed: versions === null, versions: versions ?? [] } };
	}

	/** An event from inside a bubble's editor: the words being changed keep the browser's own selection and menu. */
	function insideEditor(target: EventTarget | null): boolean {
		return target instanceof Element && Boolean(target.closest('.msg-editor'));
	}

	function copyMessageBody(id: string, text: string, event?: MouseEvent): void {
		copyText(text);
		copiedMessageId = id;
		const target = event?.currentTarget as HTMLElement | undefined;
		if (target) {
			target.classList.add('is-copied');
			setTimeout(() => {
				target.classList.remove('is-copied');
			}, 1800);
		}
		setTimeout(() => {
			if (copiedMessageId === id) copiedMessageId = null;
		}, 1800);
	}

	let messageContextMenu = $state<{
		message: Message;
		x: number;
		y: number;
		selectedText: string | null;
		/** Opened by a touch, where the press could not select: the menu offers the text on a page. */
		touch: boolean;
	} | null>(null);
	const selectedMessageId = $derived(messageContextMenu?.message.id ?? null);
	/** The message whose text is open on a page of its own, to select part of it. */
	let textSheetId = $state<string | null>(null);
	const textSheetMessage = $derived(textSheetId ? (snapshot.messages.find((row) => row.id === textSheetId) ?? null) : null);

	let lastTouchTimestamp = 0;

	function handleMessageMouseDown(e: MouseEvent): void {
		// A rendered picture keeps the secondary press: its own menu copies the pixels.
		if (copyableImageAt(e.target)) return;
		if (insideEditor(e.target)) return;
		// WebKit selects the word on secondary mousedown, before contextmenu fires. Control-click as
		// right-click is a mac habit only — on Windows Ctrl+click is an ordinary modified click.
		if (e.button === 2 || (e.button === 0 && e.ctrlKey && desktopPlatform() === 'mac')) e.preventDefault();
	}

	function handleMessageTouchStart(): void {
		lastTouchTimestamp = Date.now();
	}

	function isMobileOrTouchContext(e: MouseEvent): boolean {
		if ('pointerType' in e && (e as PointerEvent).pointerType === 'touch') return true;
		if (Date.now() - lastTouchTimestamp < 1500) return true;
		if (typeof window !== 'undefined') {
			if (window.matchMedia?.('(max-width: 680px)').matches) return true;
			if (window.matchMedia?.('(pointer: coarse)').matches) return true;
		}
		return false;
	}

	function handleMessageContextMenu(e: MouseEvent, message: Message): void {
		// Words being changed keep the system's own menu: select, cut, copy, paste.
		if (insideEditor(e.target)) return;
		// The picture's menu is mounted on the document and runs first. Leave this one closed.
		if (copyableImageAt(e.target)) {
			messageContextMenu = null;
			return;
		}
		e.preventDefault();
		e.stopPropagation();

		const isMobile = isMobileOrTouchContext(e);
		if (isMobile) {
			window.getSelection()?.removeAllRanges();
		}

		const selection = isMobile ? null : window.getSelection()?.toString().trim();
		const currentEl = e.currentTarget as HTMLElement | null;
		const anchorNode = window.getSelection()?.anchorNode;
		const isSelectionInside = Boolean(
			selection && currentEl && anchorNode && currentEl.contains(anchorNode)
		);
		messageContextMenu = {
			message,
			x: e.clientX,
			y: e.clientY,
			selectedText: isSelectionInside ? (selection ?? null) : null,
			touch: isMobile
		};
	}

	function closeMessageContextMenu(): void {
		messageContextMenu = null;
	}

	function handleOpenFileTree(targetPath: string | null, message: Message): void {
		const files = extractAssociatedFiles(message);
		const path = targetPath ?? files[0];
		if (path) {
			onOpenArtifact(path, undefined, message.id, true);
		}
	}

	function handleCopyMessageId(id: string): void {
		copyText(id);
	}

	/** Open this message's job with the board already on its card. */
	/**
	 * One view of the job a message is in. The trace lands on the message's card; the board picks
	 * the ticket the message was filed under; the plan is the job's.
	 */
	function showMessageTrace(message: Message, view: TraceViewKind = 'trace'): void {
		if (!message.task_id) return;
		if (view === 'trace') {
			runtime.openTrace(message.task_id, { messageId: message.id, turnId: message.turn_id });
			return;
		}
		runtime.openTrace(message.task_id, null, { view, ticket: message.ticket_id ?? null });
	}

	/** What the transcript's rows read from the stage, as one object; see transcript-stage.ts. */
	const stage: TranscriptStage = {
		get snapshot() { return snapshot; },
		get view() { return view; },
		get selected() { return selected; },
		get selectedKind() { return selectedKind; },
		get botsById() { return botsById; },
		get locale() { return locale; },
		get connected() { return connected; },
		get lockedComposer() { return lockedComposer; },
		get fileDrop() { return fileDrop; },
		get showOwnAvatar() { return showOwnAvatar; },
		get highlightedId() { return highlightedId; },
		get selectedMessageId() { return selectedMessageId; },
		get copiedMessageId() { return copiedMessageId; },
		get statusLabels() { return statusLabels; },
		get rosterLabels() { return rosterLabels; },
		get liveTurnsHere() { return liveTurnsHere; },
		get announced() { return announced; },
		get messageLookup() { return messageLookup; },
		get commandHosts() { return commandHosts; },
		get annotationIndex() { return annotationIndex; },
		get botDmIndex() { return botDmIndex; },
		get attributionChips() { return attributionChips; },
		get cardErrors() { return cardErrors; },
		get versionsShown() { return versionsShown; },
		get editErrorText() { return editErrorText; },
		get nowMs() { return nowMs; },
		get approvalKeys() { return approvalKeys; },
		set approvalKeys(value) { approvalKeys = value; },
		get approvalKeyErrors() { return approvalKeyErrors; },
		set approvalKeyErrors(value) { approvalKeyErrors = value; },
		get attributionEditId() { return attributionEditId; },
		set attributionEditId(value) { attributionEditId = value; },
		get openStepsTurn() { return openStepsTurn; },
		set openStepsTurn(value) { openStepsTurn = value; },
		get onOpenProfile() { return onOpenProfile; },
		get onOpenArtifact() { return onOpenArtifact; },
		who,
		whoAuthor,
		botNameOf,
		markdownOpts,
		messageBody,
		messageShowsAttachments,
		loadBodyImage,
		openBodyImage,
		openInlineImage,
		openInlineFile,
		openAnnotation,
		toggleAnnotation,
		annotationSourceLabel,
		openAnnotationSource,
		editable,
		editingHere,
		startEdit,
		queuedLine,
		withdrawLine,
		reEditLine,
		insertLine,
		lineBusy,
		insertTitle,
		lineNoteText,
		toggleVersions,
		copyMessageBody,
		startQuoteReply,
		handleMessageMouseDown,
		handleMessageTouchStart,
		handleMessageContextMenu,
		pressControl,
		replyAsk,
		showMessageTrace
	};
</script>

<div class:has-message-index={showMessageIndex} class="stream-stage flex-1 min-h-0 relative flex flex-col bg-pane overflow-hidden">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="stream"
		class:has-selected-message={selectedMessageId !== null}
		bind:this={scroll.streamContainer}
		onscroll={scroll.onStreamScroll}
		onscrollend={scroll.onStreamScrollEnd}
		onclick={(e) => {
			if (e.target === scroll.streamContainer || e.target === scroll.streamInner) {
				messageContextMenu = null;
			}
		}}
	>
		<div class="stream-inner" bind:this={scroll.streamInner}>
	{#if selected && selectedKind === 'bot-bot' && !runtime.delegationUnsupported[selected.id]}
		<DelegationRecords records={delegations} {botsById} {t}
			onOpenArtifact={(path, messageId) => onOpenArtifact(path, undefined, messageId)} />
		{#if runtime.delegationLoadError[selected.id]}
			<div class="delegation-load-error" role="status">
				{t.delegation.loadFailed}
				<button type="button" class="btn-xs" disabled={!connected || runtime.delegationLoading[selected.id]}
					onclick={() => void runtime.loadDelegations(selected.id)}>{t.delegation.retry}</button>
			</div>
		{/if}
	{/if}
	{#if !selected}
		<EmptyState title={t.top.pickSession} hint={t.top.pickSessionHint} />
	{:else if stream.length === 0 && view?.historyLoading}
		<!-- A remote transcript arrives over the relay; saying so beats an empty room that fills
		     without warning. -->
		<div class="history-loading m-auto flex flex-col items-center gap-3 text-center py-20" role="status">
			<svg class="history-spinner" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
				<path d="M12 3a9 9 0 1 0 9 9" />
			</svg>
			<p class="muted">{t.stream.loadingHistory}</p>
		</div>
	{:else if stream.length === 0 && delegations.length === 0}
		<ChatWelcome {t} {selected} {selectedKind} {selectedPeerBot} {locale} {fileDrop} {lockedComposer} {onOpenProfile} {pickStarterPrompt} {titleOf} />
	{:else}
		{#if view?.hasOlderMessages && hiddenOlder === 0}
			<div class="load-earlier flex justify-center py-3">
				<button type="button" class="btn-xs" disabled={view?.olderLoading} onclick={() => void scroll.showEarlier()}>
					{view?.olderLoading ? t.stream.loadingEarlier : t.stream.loadEarlier}
				</button>
			</div>
		{/if}
		{#each groupedStream as group, gIdx (group.id)}
			{@const groupDate = group.created_at}
			{@const prevGroup = gIdx > 0 ? groupedStream[gIdx - 1] : null}
			{@const prevDate = prevGroup ? prevGroup.created_at : null}
			{#if !prevDate || isDifferentDay(prevDate, groupDate)}
				<div class="date-divider flex items-center justify-center mt-6 mx-0 mb-2 relative">
					<span class="date-pill">{formatDateDivider(groupDate, locale)}</span>
				</div>
			{/if}

			{#if group.kind === 'replying'}
				{@const block = group.items[0]}
				{#if block.type === 'replying'}
					<div class="replying-list flex flex-col gap-5 self-start max-w-full pt-2 px-2 pb-1 mt-[-8px]" aria-live="polite">
						<ReplyingIndicator
							entries={block.entries}
							{botsById}
							isUser={false}
							thinkingText={statusLabels.running}
							deletedText={t.top.deleted}
							{onOpenProfile}
						/>
					</div>
				{/if}
			{:else if group.kind === 'ask'}
				<TranscriptAsk {group} {t} {runtime} {stage} />
			{:else if group.kind === 'approval'}
				<TranscriptApproval {group} {t} {runtime} {stage} />
			{:else if group.kind === 'system'}
				<TranscriptSystem {group} {t} {runtime} {stage} />
			{:else if group.kind === 'user'}
				<TranscriptUserGroup {group} {t} {runtime} {stage} />
			{:else}
				<TranscriptBotGroup {group} {t} {runtime} {stage} />
			{/if}
		{/each}
	{/if}
		</div>
	</div>

	{#if showMessageIndex}
		{#key selected?.id}
		<MessageIndex
			marks={indexMarks}
			activeId={scroll.activeIndexId}
			{locale}
			label={t.stream.messageIndex}
			emptyLabel={t.stream.messageIndexEmpty}
			sender={(mark) => mark.kind === 'system' ? (locale === 'zh' ? '系统' : 'System') : whoAuthor(mark.author)}
			hasEarlier={Boolean(view?.hasOlderMessages)}
			loading={Boolean(view?.olderLoading)}
			earlierLabel={view?.olderLoading ? t.stream.loadingEarlier : t.stream.loadEarlier}
			onLoadEarlier={() => void runtime.loadOlderMessages(selected?.id)}
			onJump={scroll.jumpToIndexMark}
		/>
		{/key}
	{/if}

	<Composer
		bind:this={composer}
		{runtime}
		{t}
		{selected}
		showScrollBottom={scroll.showScrollBottom}
		onScrollToBottom={() => scroll.scrollToBottom(true)}
		onSend={sendFromComposer}
		onPickPrompt={pickStarterPrompt}
		onEditLast={editLastLine}
		/>

	{#if shownImage}
		<MessageImageLightbox
			attachment={shownImage.attachment}
			relpath={shownImage.relpath}
			origin={shownImage.origin}
			placeholder={shownImage.placeholder}
			api={runtime.client}
			{t}
			onClose={() => (inlineImage = null)}
		/>
	{/if}

	{#if shownFile}
		<MessageFileOverlay
			{runtime}
			{t}
			attachment={shownFile.attachment}
			relpath={shownFile.relpath}
			messageId={shownFile.messageId}
			onClose={() => (inlineFile = null)}
		/>
	{/if}

	{#if messageContextMenu}
		{@const activeMenu = messageContextMenu}
		<MessageContextMenu
			message={activeMenu.message}
			x={activeMenu.x}
			y={activeMenu.y}
			{t}
			{lockedComposer}
			selectedText={activeMenu.selectedText}
			onClose={closeMessageContextMenu}
			onReply={() => startQuoteReply(activeMenu.message)}
			onCopy={(text) => copyMessageBody(activeMenu.message.id, text)}
			onOpenFileTree={(path) => handleOpenFileTree(path, activeMenu.message)}
			onShowTrace={(view) => showMessageTrace(activeMenu.message, view)}
			onCopyId={() => handleCopyMessageId(activeMenu.message.id)}
			onReaction={(emoji) => void runtime.toggleReaction(activeMenu.message.id, emoji)}
			onAttribution={!fileDrop && attributable(activeMenu.message) && connected && !lockedComposer
				? () => { attributionEditId = activeMenu.message.id; }
				: undefined}
			onSelectText={activeMenu.touch ? () => { textSheetId = activeMenu.message.id; } : undefined}
			onEdit={editable(activeMenu.message) ? () => startEdit(activeMenu.message) : undefined}
			/>
	{/if}
	{#if textSheetMessage}
		{@const shown = textSheetMessage}
		<MessageTextSheet
			{t}
			subject={`${isAppLine(shown) ? t.chat.appName : who(shown)} · ${formatMessageTime(shown.created_at)}`}
			onClose={() => (textSheetId = null)}
		>
			<!-- As the conversation draws it: a reply or a line of yours as markdown, the rest as it is. -->
			{#if shown.kind === 'user' || shown.kind === 'bot'}
				<MarkdownBody
					source={messageBody(shown)}
					options={markdownOpts(shown)}
					copyLabel={t.chat.copyCode}
					copiedLabel={t.chat.copied}
					onOpenArtifact={(path) => {
						textSheetId = null;
						onOpenArtifact(path, undefined, shown.id);
					}}
					onOpenImage={(path, from) => openBodyImage(shown, path, from)}
					loadArtifactImage={loadBodyImage}
					onOpenProfile={(id) => {
						textSheetId = null;
						onOpenProfile(id);
					}}
				/>
			{:else}
				<div class="whitespace-pre-wrap">{shown.body}</div>
			{/if}
		</MessageTextSheet>
	{/if}
	{#if attributionTarget}
		{@const target = attributionTarget}
		<AttributionDialog
			message={target} {t}
			plans={runtime.attributionPlans[target.session_id] ?? []}
			{locale}
			lastUsed={planUsage(snapshot.messages.filter((row) => row.session_id === target.session_id))}
			disabled={!connected || lockedComposer}
			loading={runtime.attributionLoading[target.session_id] ?? false}
			loadError={runtime.attributionLoadError[target.session_id] ?? false}
			onLoad={() => runtime.loadAttributionPlans(target.session_id, target.id)}
			onSave={(filings) => runtime.patchMessageAttribution(target.id, filings)}
			onNewJob={() => runtime.newJobFromMessage(target.id)}
			onClose={() => { attributionEditId = null; }}
		/>
	{/if}
</div>

<style>
	/* Room for the index; a conversation narrow enough to hide it takes this back below. */
	.has-message-index .stream-inner { padding-left: 40px; padding-right: 40px; }

	.stream {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-anchor: none;
		display: flex;
		flex-direction: column;
		background: var(--pane);
	}

	.stream-inner {
		display: flex;
		flex-direction: column;
		gap: 16px;
		flex: 1 0 auto;
		min-height: 100%;
		width: 100%;
		max-width: calc(var(--chat-max-width) + 48px);
		margin-inline: auto;
		/* Room for the composer floating over this list, as tall as it actually is. */
		padding: 20px 24px calc(var(--composer-height, 140px) + var(--keyboard-inset, 0px) + 16px);
		box-sizing: border-box;
	}

	.date-divider::before {
		content: "";
		position: absolute;
		inset: 50% 0 auto 0;
		height: 1px;
		background: var(--line-subtle);
		z-index: 1;
	}

	/* The date sits on the line itself, on the stream's own ground, instead of in a bordered pill. */
	.date-pill {
		position: relative;
		z-index: 2;
		padding: 0 12px;
		background: var(--pane);
		font-size: var(--text-micro);
		font-weight: 600;
		color: var(--date-pill-text);
	}

	/*
	 * Which reply, or which part of one, the pointer is on. A reply has no bubble, so nothing but
	 * the dashed seam between parts says where one ends: under the pointer that part takes the same
	 * faint ground a row does, not the teal tint a selected or found message wears. The ring is
	 * still what says it was chosen, and the ground steps aside for it: none on the one that has
	 * one, and none at all while a message's menu is open, so the ring alone says which one it is for.
	 */
	@media (hover: hover) {
		.stream:not(.has-selected-message) :global(.msg-wrap.is-bot .msg-segment:hover:not(.is-selected):not(.is-search-hit)) {
			background: var(--row-hover);
			/* The dashed seam between parts stays the pane's colour through its gaps. */
			background-clip: padding-box;
		}
	}

	/*
	 * The phone layout follows the conversation's width (the `conversation` container), so a
	 * workbench pane narrower than a phone gets it in a wide window too. What only a touch screen
	 * needs — no text selection on long-press, no hover pill — still asks the window.
	 */
	@container conversation (max-width: 680px) {
		/* The composer docks below the stream here instead of floating over it (see Composer), so
		   the transcript needs no room kept for it. */
		.stream-inner,
		.has-message-index .stream-inner {
			padding: 14px 12px 16px;
		}
	}

	/* The seams of the mounted window: what it is waiting for, and how to reach further back. */
	.history-spinner {
		color: var(--muted);
		animation: historySpin 0.9s linear infinite;
	}

	@keyframes historySpin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.history-spinner {
			animation: none;
		}
	}
</style>
