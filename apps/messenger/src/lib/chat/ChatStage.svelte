<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { USER_MEMBER, type Attachment, type Bot, type Message, type MessageVersion, type SessionSummary, type Turn,
		type Annotation, type ControlOffer,
	} from '@real-bot/protocol';
	import Composer from './Composer.svelte';
	import MessageAttachments from './MessageAttachments.svelte';
	import MessageImageLightbox, { type ImageOrigin } from './MessageImageLightbox.svelte';
	import MessageFileOverlay from './MessageFileOverlay.svelte';
	import { copyableImageAt } from '../image-context.ts';
	import { desktopPlatform } from '../platform.ts';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import AskCard from './AskCard.svelte';
	import PromptEditCard from './PromptEditCard.svelte';
	import WorkQuestionCard from './WorkQuestionCard.svelte';
	import CommandActivity from './CommandActivity.svelte';
	import TurnStepList from './TurnStepList.svelte';
	import { whenVisible } from '../when-visible.ts';
	import type { CommandRow } from './command-activity.ts';
	import BotDmEntry from './BotDmEntry.svelte';
	import ControlActions from './ControlActions.svelte';
	import MessageAttribution from './MessageAttribution.svelte';
	import AttributionDialog from './AttributionDialog.svelte';
	import { attributable, attributionChipIds, planUsage } from './attribution.ts';
	import DelegationRecords from './DelegationRecords.svelte';
	import AnnotationCards from '../annotations/AnnotationCards.svelte';
	import { annotationsByMessage } from '../annotations/model.ts';
	import { indexBotDmsByOrigin } from './bot-dm-entries.ts';
	import SessionAvatar from '../SessionAvatar.svelte';
	import EmptyState from '../EmptyState.svelte';
	import BrandMark from '../BrandMark.svelte';
	import {
		approvalForMessage,
		approvalNeedsSecret,
		approvalSecretRequired,
		canAlwaysAllow,
		isPromptEdit,
		isHttpMcpApproval
	} from './approval-card.ts';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import {
		buildMessageLookup,
		calculateBotDuration,
		canContinueInterrupt,
		formatDateDivider,
		formatFullTimestamp,
		formatLiveDuration,
		formatMessageTime,
		groupReactions,
		groupTranscript,
		isAppLine,
		isDifferentDay,
		isInterruptNote,
		isUnreachableNote,
		restartAnnounced
	} from './chat-view.ts';
	import { composerLocked } from './composer-mode.ts';
	import type { Copy } from '../copy.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import type { RenderMarkdownOptions } from '../markdown.ts';
	import { classifySession, isFileDropSession, presentBotIds, youBotPeer } from '../sidebar/session-groups.ts';
	import { canQuoteReply, draftWithQuoteMention, quotePreview, quotedBotName } from './quote-reply.ts';
	import MessageContextMenu from './MessageContextMenu.svelte';
	import MessageTextSheet from './MessageTextSheet.svelte';
	import MessageEditor from './MessageEditor.svelte';
	import { canEditMessage, lastEditableLine } from './message-edit.ts';
	import { extractAssociatedFiles } from './message-context-menu.ts';
	import { handedOverPaths } from '../overlays/artifacts.ts';
	import { messageDisplayBody } from './message-body.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import { getStarterOptions } from './starter-prompts.ts';
	import { distanceFromBottom, isNearBottom, maxScrollTop, stickAfterScroll } from './stream-scroll.ts';
	import { composeTranscript, isLiveStatus, isPendingAsk, transcriptItemKey } from './transcript.ts';
	import { describeStep, stepRow, type StepLine, type StepRow } from './turn-activity.ts';
	import { HISTORY_WINDOW_INITIAL, HISTORY_WINDOW_STEP, windowForIndex, windowedItems } from './history-window.ts';
	import { deferWhileDragging } from '../workbench/pane-resize.svelte.ts';
	import { INDEX_MIN_MARKS, activeIndexMark, messageIndexMarks, type IndexMark } from './message-index.ts';
	import MessageIndex from './MessageIndex.svelte';
	import {
		transcriptReadingReady,
		desktopReadingMode,
		TRANSCRIPT_VISIBLE_MS
	} from '../notifications/reading.ts';

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
	const showMessageAvatars = $derived(selectedKind !== 'you-bot');
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(selectedPeer ? (botsById.get(selectedPeer) ?? null) : null);
	const sessionSettingsLabel = $derived(
		selectedKind === 'group' ? t.top.groupSettings : t.top.botSettings
	);
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

	async function resolveApprovalCard(card: {
		id: string;
		kind_key: string | null;
		target: string | null;
		requires_api_key: boolean;
	}, action: 'allow_once' | 'deny' | 'always_allow'): Promise<void> {
		const key = approvalKeys[card.id] ?? '';
		if (action === 'allow_once' && approvalSecretRequired(card) && key.trim().length === 0) {
			approvalKeyErrors = { ...approvalKeyErrors, [card.id]: true };
			return;
		}
		const error = await runtime.resolveApproval(card.id, action, key, selected?.id);
		if (error && error.status === 422 && approvalNeedsSecret(card)) {
			approvalKeyErrors = { ...approvalKeyErrors, [card.id]: true };
			return;
		}
		if (!error) {
			const nextKeys = { ...approvalKeys };
			delete nextKeys[card.id];
			approvalKeys = nextKeys;
			const nextErrors = { ...approvalKeyErrors };
			delete nextErrors[card.id];
			approvalKeyErrors = nextErrors;
		}
	}

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
	 * Only the tail of a long conversation is mounted; see history-window.ts for why. The window
	 * grows when the person scrolls into it, and the runtime fetches another page once the window
	 * has reached the oldest message it holds.
	 */
	let historyWindow = $state(HISTORY_WINDOW_INITIAL);
	const windowedStream = $derived(windowedItems(stream, historyWindow));
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
	let activeIndexId = $state<string | null>(null);
	/** Held while a tick is being brought into view, so sticking to the bottom cannot undo the jump. */
	let indexJumpSequence = 0;
	let indexJumping = false;

	/**
	 * Growing the window prepends content, and the browser keeps `scrollTop`, so the view would
	 * slide down by whatever was added. Anchoring on the distance to the bottom keeps the message
	 * the person was reading exactly where it was.
	 */
	async function showEarlier(): Promise<void> {
		const el = streamContainer;
		const anchor = el ? el.scrollHeight - el.scrollTop : null;
		stickToBottom = false;
		if (hiddenOlder > 0) historyWindow += HISTORY_WINDOW_STEP;
		else if (view?.hasOlderMessages) {
			await runtime.loadOlderMessages(view.sessionId);
			historyWindow += HISTORY_WINDOW_STEP;
		}
		await tick();
		if (el && anchor !== null) {
			ignoreStreamScroll = true;
			el.scrollTop = el.scrollHeight - anchor;
		}
	}

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
		stickToBottom = true;
		const res = await runtime.sendAsk(askId, { selected: picks, custom: body }, selected?.id);
		if (res.status === 'accepted') {
			runtime.clearAskDraft(askId, submittedVersion);
			await tick();
			scrollToBottom(false);
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
				void runtime.reportDesktopNotificationView(stickToBottom);
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
			if (runtime.isDesktopShell) void runtime.reportDesktopNotificationView(windowVisible && stickToBottom);
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
		if (!ready || !stickToBottom) {
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

	const starterOptions = $derived(
		selectedPeerBot
			? getStarterOptions({
					name: selectedPeerBot.name,
					duties: selectedPeerBot.duties,
					boundaries: selectedPeerBot.boundaries,
					locale
				})
			: []
	);

	let copiedMessageId = $state<string | null>(null);

	let streamContainer = $state<HTMLElement | null>(null);

	let streamInner = $state<HTMLElement | null>(null);

	let showScrollBottom = $state(false);

	let stickToBottom = $state(true);

	let ignoreStreamScroll = false;

	let jumpToBottom = false;

	let jumpToBottomTimer: ReturnType<typeof setTimeout> | null = null;

	let nowMs = $state(Date.now());

	function pinStreamToBottom(): void {
		const el = streamContainer;
		if (!el) return;
		ignoreStreamScroll = true;
		el.scrollTop = maxScrollTop(el.scrollHeight, el.clientHeight);
		showScrollBottom = false;
	}

	function cancelJumpToBottom(): void {
		if (jumpToBottomTimer !== null) {
			clearTimeout(jumpToBottomTimer);
			jumpToBottomTimer = null;
		}
		jumpToBottom = false;
	}

	function finishJumpToBottom(): void {
		cancelJumpToBottom();
		pinStreamToBottom();
	}

	// Another conversation in this stage starts it over. Clicking into another pane is not that.
	$effect(() => {
		void selected?.id;
		indexJumpSequence++;
		indexJumping = false;
		activeIndexId = null;
		cancelJumpToBottom();
		historyWindow = HISTORY_WINDOW_INITIAL;
		if (untrack(() => highlightedId)) {
			stickToBottom = false;
			return () => cancelJumpToBottom();
		}
		stickToBottom = true;
		showScrollBottom = false;
		void tick().then(() => { if (stickToBottom) pinStreamToBottom(); });
		return () => cancelJumpToBottom();
	});

	$effect(() => {
		const id = highlightedId;
		const token = view?.searchHighlightToken ?? 0;
		if (!id) return;
		stickToBottom = false;
		void snapshot.messages;
		void selected?.id;
		void token;
		const at = stream.findIndex((item) => item.type === 'message' && item.message.id === id);
		historyWindow = windowForIndex(stream.length, at, untrack(() => historyWindow));
		void tick().then(() => {
			if (highlightedId !== id) return;
			scrollHighlightedMessage();
		});
	});

	$effect(() => {
		const outer = streamContainer;
		const inner = streamInner;
		if (!outer || !inner) return;
		void stickToBottom;
		const follow = () => {
			if (jumpToBottom || indexJumping) return;
			if (stickToBottom) pinStreamToBottom();
			else showScrollBottom = !isNearBottom(outer.scrollHeight, outer.scrollTop, outer.clientHeight);
			refreshActiveIndex();
		};
		// Measuring every mounted bubble on each size change is what makes a divider drag
		// stutter once several transcripts are on screen. One run when the pointer is released.
		const deferred = deferWhileDragging(follow);
		const ro = new ResizeObserver(deferred.run);
		ro.observe(inner);
		ro.observe(outer);
		window.addEventListener('resize', deferred.run);
		deferred.run();
		return () => {
			ro.disconnect();
			window.removeEventListener('resize', deferred.run);
			deferred.cancel();
		};
	});

	$effect(() => {
		if (liveTurnsHere.length > 0) {
			const timer = setInterval(() => {
				nowMs = Date.now();
			}, 250);
			return () => clearInterval(timer);
		}
	});

	/** What a working turn is doing, once it has started a step: see turn-activity.ts. */
	function stepLineOf(turnId: string): StepLine | null {
		const step = runtime.stepOf(turnId);
		return step ? describeStep(step, t.chat.activity, nowMs) : null;
	}

	/** What one of its commands has printed, if this conversation was watching when it ran. */
	function commandOutput(turnId: string, callId: string): string | null {
		void runtime.activityRevision;
		const id = `${turnId}:${callId}`;
		return runtime.activity.forTurn(turnId).find((row) => row.id === id)?.text || null;
	}

	/**
	 * A running turn's commands. Reading the revision is what brings new output in, without
	 * remounting the list: a remount folded it again on every frame.
	 */
	function commandRows(turnId: string): CommandRow[] {
		void runtime.activityRevision;
		return runtime.activity.forTurn(turnId);
	}

	/** The working bubble whose steps are open: one at a time, and it goes with its turn. */
	let openStepsTurn = $state<string | null>(null);

	/**
	 * What a working bubble's last line opens onto: only what is going on now. What has finished is
	 * in the command card above it, or done with; listing the whole turn there repeated the card.
	 */
	function liveSteps(turnId: string): StepRow[] | null {
		const rows = runtime.stepsOf(turnId).filter((step) => step.running).map((step) => stepRow(step, t.chat.activity, nowMs));
		return rows.length ? rows : null;
	}

	/**
	 * Whether opening the line shows more than it says: another step going on beside it, or what a
	 * running command is printing. A lone step with nothing to show is just a line.
	 */
	function opensMore(turnId: string): boolean {
		const running = runtime.stepsOf(turnId).filter((step) => step.running);
		return running.length > 1 || running.some((step) => step.name === 'shell' && Boolean(commandOutput(turnId, step.id)));
	}

	function toggleSteps(turnId: string): void {
		openStepsTurn = openStepsTurn === turnId ? null : turnId;
	}

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

	function scrollHighlightedMessage(): void {
		const id = highlightedId;
		const root = streamContainer;
		if (!id || !root) return;
		const el = root.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
		if (!(el instanceof HTMLElement)) return;
		stickToBottom = false;
		el.scrollIntoView({ block: 'center', behavior: 'smooth' });
		window.setTimeout(() => {
			if (!streamContainer) return;
			showScrollBottom = !isNearBottom(
				streamContainer.scrollHeight,
				streamContainer.scrollTop,
				streamContainer.clientHeight
			);
		}, 320);
	}

	function refreshActiveIndex(): void {
		const root = streamContainer;
		if (!root || indexJumping) return;
		const rootTop = root.getBoundingClientRect().top;
		const positions = new Map<string, number>();
		for (const el of root.querySelectorAll<HTMLElement>('[data-message-id]')) {
			positions.set(el.dataset.messageId!, el.getBoundingClientRect().top - rootTop + root.scrollTop);
		}
		activeIndexId = activeIndexMark(indexMarks, positions, root.scrollTop,
			isNearBottom(root.scrollHeight, root.scrollTop, root.clientHeight));
	}

	async function jumpToIndexMark(mark: IndexMark): Promise<void> {
		const sessionId = selected?.id;
		const sequence = ++indexJumpSequence;
		cancelJumpToBottom();
		stickToBottom = false;
		ignoreStreamScroll = false;
		indexJumping = true;
		const at = stream.findIndex((item) => item.type === 'message' && item.message.id === mark.id);
		historyWindow = windowForIndex(stream.length, at, historyWindow);
		await tick();
		if (sequence !== indexJumpSequence || selected?.id !== sessionId) return;
		const root = streamContainer;
		const el = root?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(mark.id)}"]`);
		if (root && el) {
			const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 24;
			root.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
			showScrollBottom = !isNearBottom(root.scrollHeight, root.scrollTop, root.clientHeight);
			activeIndexId = mark.id;
		}
		indexJumping = false;
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
		stickToBottom = true;
		const sent = await runtime.send({
			attachments: files.length > 0 ? files : undefined,
			paths: paths.length > 0 ? paths : undefined,
			sessionId: selected?.id
		});
		await tick();
		scrollToBottom(false);
		return sent;
	}

	function onStreamScroll(e: Event): void {
		const el = e.currentTarget as HTMLElement;
		if (!el || indexJumping) return;
		refreshActiveIndex();
		const near = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
		const next = stickAfterScroll(ignoreStreamScroll, near, jumpToBottom);
		ignoreStreamScroll = next.ignore;
		if (next.ignore) {
			if (jumpToBottom && distanceFromBottom(el.scrollHeight, el.scrollTop, el.clientHeight) <= 1) {
				finishJumpToBottom();
			}
			return;
		}
		showScrollBottom = !next.stick;
		stickToBottom = next.stick;
		// Already-fetched messages come back seamlessly; a page that needs the Mac waits for the
		// button, so scrolling never blocks on the network. Only for someone who has actually
		// scrolled up: a transcript shorter than its pane sits at the top and would otherwise
		// keep asking for more.
		if (hiddenOlder > 0 && !next.stick && el.scrollTop < 240) void showEarlier();
	}

	function onStreamScrollEnd(): void {
		if (!jumpToBottom) return;
		finishJumpToBottom();
	}

	function scrollToBottom(smooth = true): void {
		if (!streamContainer) return;
		stickToBottom = true;
		showScrollBottom = false;
		const reduceMotion =
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (!smooth || reduceMotion) {
			finishJumpToBottom();
			return;
		}
		jumpToBottom = true;
		ignoreStreamScroll = true;
		const el = streamContainer;
		el.scrollTo({
			top: maxScrollTop(el.scrollHeight, el.clientHeight),
			behavior: 'smooth'
		});
		if (jumpToBottomTimer !== null) clearTimeout(jumpToBottomTimer);
		jumpToBottomTimer = setTimeout(() => {
			jumpToBottomTimer = null;
			finishJumpToBottom();
		}, 800);
	}

	function fallbackCopyText(text: string): void {
		try {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.left = '-9999px';
			document.body.appendChild(ta);
			ta.focus();
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
		} catch {
			// ignore
		}
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

	const editErrorText = $derived(
		view?.editError === 'not_editable'
			? t.chat.editNotEditable
			: view?.editError === 'empty'
				? t.chat.editEmpty
				: view?.editError === 'failed'
					? t.chat.editFailed
					: null
	);

	/** What a changed line said before, under its bubble once you open it: read for the change it now carries. */
	type VersionsShown = { at: string; loading: boolean; failed: boolean; versions: MessageVersion[] };
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
		fallbackCopyText(text);
		if (navigator.clipboard?.writeText) {
			void navigator.clipboard.writeText(text).catch(() => {});
		}
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

	function approvalStatusCopy(status: 'allowed_once' | 'denied' | 'voided' | 'pending'): string {
		if (status === 'allowed_once') return t.stream.allowed;
		if (status === 'denied') return t.stream.denied;
		if (status === 'voided') return t.stream.voided;
		return t.stream.approval;
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
		fallbackCopyText(id);
		if (navigator.clipboard?.writeText) {
			void navigator.clipboard.writeText(id).catch(() => {});
		}
	}

	/** Open this message's job with the board already on its card. */
	function showMessageTrace(message: Message): void {
		if (!message.task_id) return;
		runtime.openTrace(message.task_id, { messageId: message.id, turnId: message.turn_id });
	}
</script>

{#snippet editedMark(message: Message)}
	<button
		type="button"
		class="msg-edited"
		aria-expanded={versionsShown[message.id]?.at === (message.edited_at ?? '')}
		title={t.chat.editedAt(formatFullTimestamp(message.edited_at ?? message.created_at))}
		onclick={() => void toggleVersions(message)}
	>{t.chat.edited}</button>
{/snippet}

<div class:has-message-index={showMessageIndex} class="stream-stage flex-1 min-h-0 relative flex flex-col bg-pane overflow-hidden">
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="stream"
		bind:this={streamContainer}
		onscroll={onStreamScroll}
		onscrollend={onStreamScrollEnd}
		onclick={(e) => {
			if (e.target === streamContainer || e.target === streamInner) {
				messageContextMenu = null;
			}
		}}
	>
		<div class="stream-inner" bind:this={streamInner}>
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
		<div class="empty-chat-welcome m-auto flex flex-col items-center text-center py-16 px-10 max-w-[460px]">
			{#if fileDrop}
				<div class="empty-icon" aria-hidden="true">
					<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
						<polyline points="14 2 14 8 20 8"></polyline>
					</svg>
				</div>
				<h2>{t.sidebar.fileDrop}</h2>
				<p class="muted">{t.sidebar.fileDropEmpty}</p>
			{:else if selectedKind === 'you-bot' && selectedPeerBot}
				{@const pal = botAvatarColor(selectedPeerBot.id)}
				<button
					type="button"
					class="welcome-identity-btn"
					onclick={() => onOpenProfile(selectedPeerBot.id)}
					title={sessionSettingsLabel}
				>
					<span
						class="welcome-avatar"
						style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
					>
						{#if avatarSrc(selectedPeerBot.avatar)}
							<img src={avatarSrc(selectedPeerBot.avatar)} alt={selectedPeerBot.name} class="avatar-img" />
						{:else}
							{rosterLetter(selectedPeerBot.name)}
						{/if}
					</span>
					<span class="welcome-title">{selectedPeerBot.name}</span>
				</button>
				<div class="welcome-badges flex items-center gap-3 mb-6">
					<span class="bot-badge">{t.chat.botBadge}</span>
					{#if selectedPeerBot.model}
						<span class="model-badge mono">{selectedPeerBot.model}</span>
					{/if}
				</div>
				{#if selectedPeerBot.duties}
					<div class="welcome-duties">
						<p class="duties-text m-0 text-13 text-ink-secondary leading-normal text-left">{selectedPeerBot.duties}</p>
					</div>
				{/if}
				{#if starterOptions.length > 0}
					<div class="welcome-starters flex flex-col gap-4 w-full mb-6">
						{#each starterOptions as starter (starter.id)}
							<button
								type="button"
								class="starter-chip"
								disabled={lockedComposer}
								onclick={() => pickStarterPrompt(starter.prompt)}
							>
								{starter.icon} {starter.label}
							</button>
						{/each}
					</div>
				{/if}
			{:else}
				<div class="empty-icon" aria-hidden="true">
					<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="10"></circle>
						<line x1="8" y1="12" x2="16" y2="12"></line>
					</svg>
				</div>
				<h2>{titleOf(selected)}</h2>
			{/if}
			<p class="muted">{t.stream.empty}</p>
		</div>
	{:else}
		{#if view?.hasOlderMessages && hiddenOlder === 0}
			<div class="load-earlier flex justify-center py-3">
				<button type="button" class="btn-xs" disabled={view?.olderLoading} onclick={() => void showEarlier()}>
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
				{@const singleMsg = group.items[0]}
				{#if singleMsg.type === 'message'}
					{@const askBot = botsById.get(singleMsg.message.author)}
					{@const pal = botAvatarColor(singleMsg.message.author)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="msg-wrap is-bot"
						data-message-id={singleMsg.message.id}
						class:is-search-hit={highlightedId === singleMsg.message.id}
						class:is-selected={selectedMessageId === singleMsg.message.id}
						onmousedown={handleMessageMouseDown}
						ontouchstart={handleMessageTouchStart}
						oncontextmenu={(e) => handleMessageContextMenu(e, singleMsg.message)}
					>
						{#if showMessageAvatars}
					<div class="avatar-col">
							{#if askBot}
								<button
									type="button"
									class="bot-avatar is-clickable"
									style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
									title={t.top.botSettings}
									onclick={() => onOpenProfile(askBot.id)}
								>
									{#if avatarSrc(askBot.avatar)}
										<img src={avatarSrc(askBot.avatar)} alt={askBot.name} class="avatar-img" />
									{:else}
										{rosterLetter(askBot.name)}
									{/if}
								</button>
							{:else}
								<div class="bot-avatar" style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};">
									?
								</div>
							{/if}
						</div>
						{/if}
						<div class="msg-content">
							<div class="msg-header">
								{#if askBot}
									<button
										type="button"
										class="sender-name is-clickable"
										onclick={() => onOpenProfile(askBot.id)}
										title={t.top.botSettings}
									>
										{who(singleMsg.message)}
									</button>
								{:else}
									<span class="sender-name">{who(singleMsg.message)}</span>
								{/if}
								<span class="ask-badge">?</span>
								<span class="msg-time mono" title={formatFullTimestamp(singleMsg.message.created_at)}>
									{formatMessageTime(singleMsg.message.created_at)}
								</span>
							</div>
							<article class="msg is-ask">
								<div class="who">{t.stream.ask} · {who(singleMsg.message)}</div>
								<div class="body">{singleMsg.message.body}</div>
								<AskCard
									message={singleMsg.message}
									answerable={isPendingAsk(singleMsg.message, snapshot.turns, runtime.notificationCapabilities.pending_ask_v1) && !lockedComposer}
									draft={runtime.getAskDraft(singleMsg.message.id)}
									sending={view?.sending ?? false}
									{t}
									onDraft={(body) => runtime.setAskDraft(singleMsg.message.id, body)}
									onSelect={(picks) => runtime.setAskSelection(singleMsg.message.id, picks)}
									onSubmit={() => void replyAsk(singleMsg.message.id)}
								/>
							</article>
						</div>
					</div>
				{/if}
			{:else if group.kind === 'approval'}
				{@const singleMsg = group.items[0]}
				{#if singleMsg.type === 'message'}
					{@const card = approvalForMessage(snapshot.approvals, singleMsg.message)}
					<div
						class="msg-wrap is-card-wrap"
						data-message-id={singleMsg.message.id}
						class:is-search-hit={highlightedId === singleMsg.message.id}
					>
						<article class="msg is-approval">
							<div class="who">{t.stream.approval} · {who(singleMsg.message)}</div>
							{#if isPromptEdit(card?.kind_key)}
								<!-- A Bot's change to a built-in prompt (ADR 0064): the change itself, and once allowed, its Undo. -->
								<PromptEditCard body={singleMsg.message.body} {t} approval={card ?? null} api={runtime.client} onOpenSettings={() => runtime.openSettings()} />
							{:else}
								<div class="body">{singleMsg.message.body}</div>
							{/if}
							{#if card?.status === 'pending'}
								{#if approvalNeedsSecret(card)}
									{@const mcpAuth = isHttpMcpApproval(card.kind_key, card.target) || card.kind_key === 'mcp-add' || card.kind_key === 'mcp-edit'}
									<label class="approval-key" for={`approval-key-${card.id}`}>
										<span>{mcpAuth ? t.stream.mcpAuth : t.stream.endpointKey}</span>
										<input
											id={`approval-key-${card.id}`}
											type="password"
											autocomplete="off"
											value={approvalKeys[card.id] ?? ''}
											oninput={(e) => {
												approvalKeys = {
													...approvalKeys,
													[card.id]: e.currentTarget.value
												};
												if (approvalKeyErrors[card.id]) {
													approvalKeyErrors = { ...approvalKeyErrors, [card.id]: false };
												}
											}}
										/>
										{#if approvalKeyErrors[card.id]}
											<p class="field-error">{mcpAuth ? t.stream.mcpAuthEmpty : t.stream.endpointKeyEmpty}</p>
										{:else}
											<p class="hint">
												{mcpAuth
													? card.kind_key === 'mcp-add'
														? t.stream.mcpAuthHintAdd
														: t.stream.mcpAuthHintEdit
													: card.kind_key === 'endpoint-add'
														? t.stream.endpointKeyHintAdd
														: t.stream.endpointKeyHintEdit}
											</p>
										{/if}
									</label>
								{/if}
								<div class="approval-acts flex gap-4 mt-7 flex-wrap">
									<button
										type="button"
										onclick={() => void resolveApprovalCard(card, 'allow_once')}
										>{t.stream.allowOnce}</button
									>
									{#if canAlwaysAllow(card.kind_key)}
										<button
											type="button"
											onclick={() => void resolveApprovalCard(card, 'always_allow')}
											>{t.stream.alwaysAllow}</button
										>
									{/if}
									<button
										type="button"
										class="deny"
										onclick={() => void resolveApprovalCard(card, 'deny')}
										>{t.stream.deny}</button
									>
								</div>
							{:else if card}
								<p class="muted">{approvalStatusCopy(card.status)}</p>
							{/if}
						</article>
					</div>
				{/if}
			{:else if group.kind === 'system'}
				{@const singleMsg = group.items[0]}
				{#if singleMsg.type === 'message'}
					{@const sysBot = botsById.get(singleMsg.message.author)}
					{@const pal = botAvatarColor(singleMsg.message.author)}
					{@const showContinue = singleMsg.message.control?.kind !== 'work_question' && canContinueInterrupt(singleMsg.message, snapshot.turns, {
						locked: lockedComposer,
						readOnly: selectedKind === 'bot-bot',
						hasLiveTurnForBot: liveTurnsHere.some((turn) => turn.bot_id === singleMsg.message.author),
						announced
					})}
					{@const isUnreachable = isUnreachableNote(singleMsg.message)}
					{@const isInterrupt = isInterruptNote(singleMsg.message)}
					{@const appLine = isAppLine(singleMsg.message)}
					{@const continueHint = isInterrupt
						? t.stream.continueInterruptHint
						: isUnreachable
							? t.stream.continueUnreachableHint
							: t.stream.continueFailedHint}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="msg-wrap is-bot is-system-row"
						data-message-id={singleMsg.message.id}
						class:is-search-hit={highlightedId === singleMsg.message.id}
						class:is-selected={selectedMessageId === singleMsg.message.id}
						onmousedown={handleMessageMouseDown}
						ontouchstart={handleMessageTouchStart}
						oncontextmenu={(e) => handleMessageContextMenu(e, singleMsg.message)}
					>
						{#if showMessageAvatars}
					<div class="avatar-col">
							{#if appLine}
								<div class="app-avatar" aria-hidden="true">
									<BrandMark size={20} />
								</div>
							{:else if sysBot}
								<button
									type="button"
									class="bot-avatar is-clickable"
									style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
									title={t.top.botSettings}
									onclick={() => onOpenProfile(sysBot.id)}
								>
									{#if avatarSrc(sysBot.avatar)}
										<img src={avatarSrc(sysBot.avatar)} alt={sysBot.name} class="avatar-img" />
									{:else}
										{rosterLetter(sysBot.name)}
									{/if}
								</button>
							{:else}
								<div class="bot-avatar" style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};">
									?
								</div>
							{/if}
						</div>
						{/if}
						<div class="msg-content">
							<div class="msg-header">
								{#if appLine}
									<span class="sender-name">{t.chat.appName}</span>
									<span class="app-badge">{t.chat.appBadge}</span>
								{:else if sysBot}
									<button
										type="button"
										class="sender-name is-clickable"
										onclick={() => onOpenProfile(sysBot.id)}
										title={t.top.botSettings}
									>
										{who(singleMsg.message)}
									</button>
								{:else}
									<span class="sender-name">{who(singleMsg.message)}</span>
								{/if}
								{#if !appLine}
									<span class="bot-badge">{t.chat.botBadge}</span>
								{/if}
								<span class="msg-time mono" title={formatFullTimestamp(singleMsg.message.created_at)}>
									{formatMessageTime(singleMsg.message.created_at)}
								</span>
							</div>
							<article
								class="msg is-system"
								class:has-continue={showContinue}
								class:is-unreachable={isUnreachable}
								class:is-interrupt={isInterrupt}
								aria-label={appLine ? t.chat.appLineLabel : undefined}
							>
								<div class="who">{appLine ? t.chat.appName : who(singleMsg.message)}</div>
								{#if singleMsg.message.control?.kind === 'work_question'}
									{@const question = singleMsg.message.control}
									{@const plan = runtime.attributionPlans[singleMsg.message.session_id]?.find((row) => row.id === question.task_id)}
									<WorkQuestionCard
										control={question}
										botName={sysBot?.name ?? singleMsg.message.author}
										planName={plan?.title ?? question.task_id}
										ticketName={question.ticket_id ? (plan?.tickets.find((row) => row.id === question.ticket_id)?.title ?? question.ticket_id) : null}
										{t}
										disabled={!connected || lockedComposer}
										readOnly={selectedKind === 'bot-bot' || Boolean(selected?.archived_at)}
										onAnswer={(body) => runtime.answerWorkQuestion(singleMsg.message.id, body)}
									/>
								{:else}
								<div class="system-msg-content flex items-center gap-2">
									{#if isUnreachable}
										<span class="system-msg-icon is-unreachable" aria-hidden="true">
											<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<circle cx="12" cy="12" r="10" />
												<line x1="12" y1="8" x2="12" y2="12" />
												<line x1="12" y1="16" x2="12.01" y2="16" />
											</svg>
										</span>
									{:else if isInterrupt}
										<span class="system-msg-icon is-interrupt" aria-hidden="true">
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
												<rect x="6" y="6" width="12" height="12" rx="2" />
											</svg>
										</span>
									{/if}
									<span class="body">{singleMsg.message.body}</span>
								</div>
								<!-- A card about a hand-over carries its files: what you approve is right there to open. -->
								{#if messageShowsAttachments(singleMsg.message)}
									<MessageAttachments
										attachments={singleMsg.message.attachments}
										body={singleMsg.message.body}
										api={runtime.client}
										{t}
										onPreview={(att) => onOpenArtifact(att.workspace_relpath, att, singleMsg.message.id)}
										onOpenImage={(att, from) => openInlineImage(att, att.workspace_relpath, from)}
										onOpenFile={appLine ? (att) => openInlineFile(att, singleMsg.message.id) : undefined}
										cards={appLine}
									/>
								{/if}
								{#if singleMsg.message.control}
									<ControlActions
										control={singleMsg.message.control}
										holds={snapshot.holds}
										botName={botNameOf}
										{t}
										disabled={!connected}
										onAct={(action, taskId, note) => pressControl(singleMsg.message, action, taskId, note)}
									/>
								{/if}
								{/if}
								{#if showContinue}
									<div class="system-msg-actions">
										<button
											type="button"
											class="btn-continue-turn"
											title={continueHint}
											disabled={!connected || view?.sending}
											onmousedown={(e) => e.stopPropagation()}
											onclick={() => void runtime.continueInterrupt(singleMsg.message.id, selected?.id)}
										>
											<svg class="continue-icon" viewBox="0 0 24 24" width="11" height="11" fill="currentColor">
												<polygon points="6 4 20 12 6 20 6 4" />
											</svg>
											<span>{t.stream.continueInterrupt}</span>
										</button>
									</div>
								{/if}
							</article>
							{#if singleMsg.replying && singleMsg.replying.length > 0}
								<div class="msg-attached-replying" aria-live="polite">
									<ReplyingIndicator
										entries={singleMsg.replying}
										{botsById}
										isUser={false}
										thinkingText={statusLabels.running}
										deletedText={t.top.deleted}
										{onOpenProfile}
									/>
								</div>
							{/if}
						</div>
					</div>
				{/if}
			{:else if group.kind === 'user'}
				{@const isMulti = group.items.length > 1}
				<div class="msg-wrap is-user" class:is-group={isMulti}>
					<div class="msg-content">
						<div class="msg-header is-right">
							{#if isMulti}
								<span class="segment-count-badge mono">{t.chat.messageCount(group.items.length)}</span>
								<span class="sender-name">{t.common.you}</span>
							{:else}
								{@const single = group.items[0]}
								{#if single.type === 'message'}
									<span class="msg-time mono" title={formatFullTimestamp(single.message.created_at)}>
										{formatMessageTime(single.message.created_at)}
									</span>
								{/if}
								<span class="sender-name">{t.common.you}</span>
							{/if}
						</div>
						<div class="msg-segments is-user-segments flex flex-col gap-4 w-full">
							{#each group.items as item (transcriptItemKey(item))}
								{#if item.type === 'message'}
									{@const rxGroups = groupReactions(item.message.reactions, USER_MEMBER)}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="msg-segment is-user-segment flex flex-col relative w-fit max-w-full"
										data-message-id={item.message.id}
										class:is-search-hit={highlightedId === item.message.id}
										class:is-selected={selectedMessageId === item.message.id}
										onmousedown={handleMessageMouseDown}
										ontouchstart={handleMessageTouchStart}
										oncontextmenu={(e) => handleMessageContextMenu(e, item.message)}
									>
										{#if isMulti}
											<div class="segment-meta is-right flex items-center gap-3 mt-[1px] mb-[5px] py-0 px-2 text-11 leading-none">
												<span class="msg-time mono" title={formatFullTimestamp(item.message.created_at)}>
													{formatMessageTime(item.message.created_at)}
												</span>
											</div>
										{/if}
										<article class="msg is-you" class:is-editing={editingHere(item.message)}>
											<div class="who">{who(item.message)}</div>
											<div class="msg-toolbar">
												<div class="msg-toolbar-pill">
													{#if canQuoteReply(item.message) && !lockedComposer}
														<button
															type="button"
															class="act-btn"
															title={t.chat.replyMessage}
															onclick={() => startQuoteReply(item.message)}
														>
															<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
														</button>
													{/if}
													{#if editable(item.message)}
														<button
															type="button"
															class="act-btn"
															title={t.chat.editMessage}
															aria-label={t.chat.editThisLine}
															onclick={() => startEdit(item.message)}
														>
															<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
														</button>
													{/if}
													<button
														type="button"
														class="act-btn"
														class:is-copied={copiedMessageId === item.message.id}
														title={t.chat.copyMessage}
														onclick={(e) => copyMessageBody(item.message.id, item.message.body, e)}
													>
														{#if copiedMessageId === item.message.id}
															<span class="copied-badge text-11 font-semibold text-ok">✓ {t.chat.copied}</span>
														{:else}
															<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
														{/if}
													</button>
												</div>
											</div>
											{#if item.message.parent_id}
												{@const quoted = messageLookup.byId.get(item.message.parent_id)}
												<button
													type="button"
													class="quote-ref"
													onclick={() => quoted && runtime.setHighlightedMessage(quoted.id, selected?.id)}
												>
													<span class="quote-ref-who">{quoted ? who(quoted) : t.top.deleted}</span>
													<span class="quote-ref-body">{quotePreview(quoted?.body ?? '')}</span>
												</button>
											{/if}
											{#if editingHere(item.message) && view && selected}
												{@const editingIn = selected.id}
												<MessageEditor
													{t}
													value={view.editDraft}
													saving={view.editSaving}
													error={editErrorText}
													onInput={(value) => {
														if (view) {
															view.editDraft = value;
															view.editError = null;
														}
													}}
													onSave={() => void runtime.saveEdit(editingIn)}
													onCancel={() => runtime.cancelEdit(editingIn)}
												/>
											{:else}
												<MarkdownBody
													source={messageBody(item.message)}
													options={markdownOpts(item.message)}
													copyLabel={t.chat.copyCode}
													copiedLabel={t.chat.copied}
													inverted
													onOpenArtifact={(path) => onOpenArtifact(path, undefined, item.message.id)}
													onOpenImage={(path, from) => openBodyImage(item.message, path, from)}
													loadArtifactImage={loadBodyImage}
													onOpenProfile={onOpenProfile}
												/>
											{/if}
											{#if messageShowsAttachments(item.message)}
												<MessageAttachments
													attachments={item.message.attachments}
													body={item.message.body}
													api={runtime.client}
													{t}
													onPreview={(att) => onOpenArtifact(att.workspace_relpath, att, item.message.id)}
													onOpenImage={(att, from) => openInlineImage(att, att.workspace_relpath, from)}
												/>
											{/if}
											{#if annotationIndex.get(item.message.id)}
												<AnnotationCards
													annotations={annotationIndex.get(item.message.id) ?? []}
													{t}
													{locale}
													bots={botsById}
													onOpen={openAnnotation}
													onToggleStatus={lockedComposer ? undefined : (row, status) => void toggleAnnotation(item.message.id, row, status)}
													error={cardErrors[item.message.id] ?? null}
													sourceLabel={annotationSourceLabel(item.message)}
													onOpenSource={() => openAnnotationSource(item.message)}
												/>
											{/if}
										</article>
										{#if item.message.edited_at}
											<!-- Under the bubble, where what it said before opens: the hover bar above it would cover a mark by the time. -->
											<div class="msg-edited-row">{@render editedMark(item.message)}</div>
										{/if}
										{#if versionsShown[item.message.id] && versionsShown[item.message.id]!.at === (item.message.edited_at ?? '')}
											{@const shown = versionsShown[item.message.id]!}
											<div class="msg-versions" role="region" aria-label={t.chat.earlierVersions}>
												<div class="msg-versions-title">{t.chat.earlierVersions}</div>
												{#if shown.loading}
													<div class="msg-versions-note">{t.chat.versionsLoading}</div>
												{:else if shown.failed}
													<div class="msg-versions-note">{t.chat.versionsFailed}</div>
												{:else}
													{#each [...shown.versions].reverse() as version (version.created_at + version.body)}
														<div class="msg-version">
															<span class="msg-version-time mono" title={formatFullTimestamp(version.created_at)}>{formatMessageTime(version.created_at)}</span>
															<span class="msg-version-body">{version.body}</span>
														</div>
													{/each}
												{/if}
											</div>
										{/if}
										{#if !fileDrop && !item.message.control && attributionChips.has(item.message.id)}
											<MessageAttribution
												message={item.message} {t}
												plans={runtime.attributionPlans[item.message.session_id] ?? []}
												disabled={!connected || lockedComposer}
												onOpen={() => { attributionEditId = item.message.id; }}
											/>
										{/if}
										{#if item.message.control?.kind === 'possible_control' && !lockedComposer}
											<ControlActions
												control={item.message.control}
												holds={snapshot.holds}
												botName={botNameOf}
												{t}
												align="end"
												disabled={!connected}
												onAct={(action, taskId) => runtime.controlAction(item.message.id, action, taskId)}
											/>
										{/if}
										{#if rxGroups.length > 0}
											<div class="rx-row is-right flex flex-wrap gap-2 mt-2">
												{#each rxGroups as rx}
													{#if lockedComposer}
														<span class="rx-chip is-static" class:is-active={rx.userReacted}>
															<span class="rx-emoji">{rx.emoji}</span>
															<span class="rx-count mono text-11 font-semibold">{rx.count}</span>
														</span>
													{:else}
														<button
															type="button"
															class="rx-chip"
															class:is-active={rx.userReacted}
															onclick={() => void runtime.toggleReaction(item.message.id, rx.emoji)}
														>
															<span class="rx-emoji">{rx.emoji}</span>
															<span class="rx-count mono text-11 font-semibold">{rx.count}</span>
														</button>
													{/if}
												{/each}
											</div>
										{/if}
										{#if item.replying && item.replying.length > 0}
											<div class="msg-attached-replying is-user" aria-live="polite">
												<ReplyingIndicator
													entries={item.replying}
													{botsById}
													isUser={true}
													thinkingText={statusLabels.running}
													deletedText={t.top.deleted}
													{onOpenProfile}
												/>
											</div>
										{/if}
										{#if botDmIndex.get(item.message.id)}
											<div class="msg-attached-botdm is-user">
												<BotDmEntry
													sessions={botDmIndex.get(item.message.id) ?? []}
													{botsById}
													turns={snapshot.turns}
													approvals={snapshot.approvals}
													pendingJudgements={snapshot.pendingJudgements}
													isUser={true}
													{statusLabels}
													{rosterLabels}
													openedText={t.chat.botDmOpened}
													onOpen={(id) => void runtime.selectSession(id)}
													traceLabel={item.message.task_id ? t.chat.showTrace : undefined}
													onShowTrace={item.message.task_id
														? () => showMessageTrace(item.message)
														: undefined}
												/>
											</div>
										{/if}
									</div>
								{/if}
							{/each}
						</div>
					</div>
					{#if showMessageAvatars}
					<div class="avatar-col">
						<div class="user-avatar" title={t.common.you}>
							{rosterLetter(t.common.you)}
						</div>
					</div>
					{/if}
				</div>
			{:else}
				{@const botAuthor = botsById.get(group.author)}
				{@const pal = botAvatarColor(group.author)}
				{@const isMulti = group.items.length > 1}
				{@const hasStreaming = group.items.some((i) => i.type === 'streaming')}
				<div
					class="msg-wrap is-bot"
					class:is-group={isMulti}
					class:is-streaming-wrap={hasStreaming}
				>
					{#if showMessageAvatars}
					<div class="avatar-col">
						{#if botAuthor}
							<button
								type="button"
								class="bot-avatar is-clickable"
								class:is-streaming-avatar={hasStreaming}
								style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
								title={t.top.botSettings}
								onclick={() => onOpenProfile(botAuthor.id)}
							>
								{#if avatarSrc(botAuthor.avatar)}
									<img src={avatarSrc(botAuthor.avatar)} alt={botAuthor.name} class="avatar-img" />
								{:else}
									{rosterLetter(botAuthor.name)}
								{/if}
							</button>
						{:else}
							<div
								class="bot-avatar"
								class:is-streaming-avatar={hasStreaming}
								style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
								title={t.top.deleted}
							>
								{rosterLetter('?')}
							</div>
						{/if}
					</div>
					{/if}
					<div class="msg-content">
						<div class="msg-header">
							{#if botAuthor}
								<button
									type="button"
									class="sender-name is-clickable"
									onclick={() => onOpenProfile(botAuthor.id)}
									title={t.top.botSettings}
								>
									{botAuthor.name}
								</button>
							{:else}
								<span class="sender-name">{whoAuthor(group.author)}</span>
							{/if}
							<span class="bot-badge">{t.chat.botBadge}</span>
							{#if botAuthor?.model}
								<span class="model-badge mono">{botAuthor.model}</span>
							{/if}
							{#if isMulti}
								<span class="segment-count-badge mono">{t.chat.segmentCount(group.items.length)}</span>
							{/if}
						</div>

						<div class="msg-segments flex flex-col gap-4 w-full">
							{#each group.items as item, sIdx (transcriptItemKey(item))}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="msg-segment flex flex-col relative w-fit max-w-full"
									class:is-streaming={item.type === 'streaming'}
									data-message-id={item.type === 'message' ? item.message.id : undefined}
									class:is-search-hit={item.type === 'message' &&
										highlightedId === item.message.id}
									class:is-selected={item.type === 'message' && selectedMessageId === item.message.id}
									onmousedown={(e) => {
										if (item.type === 'message') handleMessageMouseDown(e);
									}}
									ontouchstart={() => {
										if (item.type === 'message') handleMessageTouchStart();
									}}
									oncontextmenu={(e) => {
										if (item.type === 'message') handleMessageContextMenu(e, item.message);
									}}
								>
									{#if isMulti}
										<div class="segment-meta flex items-center gap-3 mt-[1px] mb-[5px] py-0 px-2 text-11 leading-none">
											<span class="segment-tag">{t.chat.segmentPart(sIdx + 1)}</span>
										</div>
									{/if}

									{#if item.type === 'streaming'}
										{@const step = stepLineOf(item.turn.id)}
										{@const said = Boolean(item.turn.partial_text?.trim())}
										<article class="msg is-stream is-reply">
											<div class="who">{botAuthor?.name ?? t.top.deleted}</div>
											{#if said}
											<MarkdownBody
												source={item.turn.partial_text ?? ''}
												options={markdownOpts(undefined, { streaming: true })}
												copyLabel={t.chat.copyCode}
												copiedLabel={t.chat.copied}
												onOpenArtifact={(path) => onOpenArtifact(path)}
												onOpenImage={(path, from) => openInlineImage(null, path, from)}
												onOpenProfile={onOpenProfile}
											>
												<span class="streaming-cursor"></span>
											</MarkdownBody>
											{/if}
											<!--
												What it is doing while it does it. Ephemeral: the turn's own record is what
												survives a reload, so nothing here is stored and nothing enters the transcript.
											-->
											<CommandActivity rows={commandRows(item.turn.id)} {t} />
											<!--
												Where it is and for how long, after all it has said and run — the end of the
												bubble is where the work is going on. Every running turn has it, whatever runs
												the Bot; its step opens the list of steps, as the thinking line under your
												message used to.
											-->
											<div class="stream-foot">
												<span class="pulse"></span>
												{#if step}
													{#if opensMore(item.turn.id)}
														<button
															type="button"
															class="stream-step is-toggle"
															aria-live="off"
															aria-expanded={openStepsTurn === item.turn.id}
															aria-controls={`turn-steps-${item.turn.id}`}
															title={`${step.full}\n${t.chat.activity.showSteps}`}
															onclick={() => toggleSteps(item.turn.id)}
														><span class="toggle-label">{step.text}</span></button>
													{:else}
														<span class="stream-step" aria-live="off" title={step.full}>{step.text}</span>
													{/if}
													{#if step.elapsed}<span class="stream-step-elapsed mono" aria-hidden="true">{step.elapsed}</span>{/if}
												{:else}
													<span class="stream-step" aria-live="off">{said ? t.stream.streaming : statusLabels.running}</span>
												{/if}
												<span class="duration-badge mono">
													<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
													{formatLiveDuration(item.turn.created_at, nowMs)}
												</span>
											</div>
											{#if openStepsTurn === item.turn.id}
												{@const rows = liveSteps(item.turn.id)}
												{#if rows}
													<TurnStepList
														id={`turn-steps-${item.turn.id}`}
														title={t.chat.activity.nowTitle(botAuthor?.name ?? t.top.deleted, rows.length)}
														{rows}
														outputOf={(callId) => commandOutput(item.turn.id, callId)}
														onClose={() => (openStepsTurn = null)}
													/>
												{/if}
											{/if}
										</article>
									{:else if item.type === 'message'}
										{@const rxGroups = groupReactions(item.message.reactions, USER_MEMBER)}
										<article class="msg is-reply">
											<div class="who">{who(item.message)}</div>
											<div class="msg-toolbar">
												<div class="msg-toolbar-pill">
													{#if canQuoteReply(item.message) && !lockedComposer}
														<button
															type="button"
															class="act-btn"
															title={t.chat.replyMessage}
															onclick={() => startQuoteReply(item.message)}
														>
															<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
														</button>
													{/if}
													<button
														type="button"
														class="act-btn"
														class:is-copied={copiedMessageId === item.message.id}
														title={t.chat.copyMessage}
														onclick={(e) => copyMessageBody(item.message.id, item.message.body, e)}
													>
														{#if copiedMessageId === item.message.id}
															<span class="copied-badge text-11 font-semibold text-ok">✓ {t.chat.copied}</span>
														{:else}
															<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
														{/if}
													</button>
												</div>
											</div>
											{#if item.message.parent_id}
												{@const quoted = messageLookup.byId.get(item.message.parent_id)}
												<button
													type="button"
													class="quote-ref"
													onclick={() => quoted && runtime.setHighlightedMessage(quoted.id, selected?.id)}
												>
													<span class="quote-ref-who">{quoted ? who(quoted) : t.top.deleted}</span>
													<span class="quote-ref-body">{quotePreview(quoted?.body ?? '')}</span>
												</button>
											{/if}
											<MarkdownBody
												source={messageBody(item.message)}
												options={markdownOpts(item.message)}
												copyLabel={t.chat.copyCode}
												copiedLabel={t.chat.copied}
												onOpenArtifact={(path) => onOpenArtifact(path, undefined, item.message.id)}
												onOpenImage={(path, from) => openBodyImage(item.message, path, from)}
												loadArtifactImage={loadBodyImage}
												onOpenProfile={onOpenProfile}
											/>
											{#if messageShowsAttachments(item.message)}
												<MessageAttachments
													attachments={item.message.attachments}
													body={item.message.body}
													api={runtime.client}
													{t}
													onPreview={(att) => onOpenArtifact(att.workspace_relpath, att, item.message.id)}
													onOpenImage={(att, from) => openInlineImage(att, att.workspace_relpath, from)}
												/>
											{/if}
											{#if annotationIndex.get(item.message.id)}
												<AnnotationCards
													annotations={annotationIndex.get(item.message.id) ?? []}
													{t}
													{locale}
													bots={botsById}
													onOpen={openAnnotation}
													onToggleStatus={lockedComposer ? undefined : (row, status) => void toggleAnnotation(item.message.id, row, status)}
													error={cardErrors[item.message.id] ?? null}
													sourceLabel={annotationSourceLabel(item.message)}
													onOpenSource={() => openAnnotationSource(item.message)}
												/>
											{/if}
										</article>
										{@const tagged = !fileDrop && item.message.kind === 'bot' && !item.message.control && attributionChips.has(item.message.id)}
										{@const ranIn = item.message.turn_id && commandHosts.has(item.message.id) ? item.message.turn_id : null}
										{@const duration = calculateBotDuration(item.message, snapshot.messages, snapshot.turns, messageLookup)}
										{#snippet tail()}
											{#if tagged}
												<MessageAttribution
													message={item.message} {t}
													plans={runtime.attributionPlans[item.message.session_id] ?? []}
													disabled={!connected || lockedComposer}
													onOpen={() => { attributionEditId = item.message.id; }}
												/>
											{/if}
											<!-- On the right: how long it took, then when it came, last. -->
											<span class="msg-when">
												{#if duration}
													<span class="duration-badge mono" title={t.chat.replyTime(duration.formatted)}>
														<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
														{duration.formatted}
													</span>
												{/if}
												<span class="msg-time mono" title={formatFullTimestamp(item.message.created_at)}>
													{formatMessageTime(item.message.created_at)}
												</span>
											</span>
										{/snippet}
										<!--
											The end of the message says what it ran, what it is filed under, when it came and how
											long it took: one line while they fit, wrapping where they do not. What a finished turn
											ran stays under its last reply, read when it comes near.
										-->
										<div class="msg-foot" use:whenVisible={() => { if (ranIn) runtime.loadTurnCommands(ranIn); }}>
											{#if ranIn && runtime.commandsOf(ranIn).length}
												<CommandActivity rows={runtime.commandsOf(ranIn)} {t} beside={tail} />
											{:else}
												<div class="msg-foot-line">{@render tail()}</div>
											{/if}
										</div>
										{#if rxGroups.length > 0}
											<div class="rx-row flex flex-wrap gap-2 mt-2">
												{#each rxGroups as rx}
													{#if lockedComposer}
														<span class="rx-chip is-static" class:is-active={rx.userReacted}>
															<span class="rx-emoji">{rx.emoji}</span>
															<span class="rx-count mono text-11 font-semibold">{rx.count}</span>
														</span>
													{:else}
														<button
															type="button"
															class="rx-chip"
															class:is-active={rx.userReacted}
															onclick={() => void runtime.toggleReaction(item.message.id, rx.emoji)}
														>
															<span class="rx-emoji">{rx.emoji}</span>
															<span class="rx-count mono text-11 font-semibold">{rx.count}</span>
														</button>
													{/if}
												{/each}
											</div>
										{/if}
										{#if item.replying && item.replying.length > 0}
											<div class="msg-attached-replying" aria-live="polite">
												<ReplyingIndicator
													entries={item.replying}
													{botsById}
													isUser={false}
													thinkingText={statusLabels.running}
													deletedText={t.top.deleted}
													{onOpenProfile}
												/>
											</div>
										{/if}
										{#if botDmIndex.get(item.message.id)}
											<div class="msg-attached-botdm">
												<BotDmEntry
													sessions={botDmIndex.get(item.message.id) ?? []}
													{botsById}
													turns={snapshot.turns}
													approvals={snapshot.approvals}
													pendingJudgements={snapshot.pendingJudgements}
													{statusLabels}
													{rosterLabels}
													openedText={t.chat.botDmOpened}
													onOpen={(id) => void runtime.selectSession(id)}
													traceLabel={item.message.task_id ? t.chat.showTrace : undefined}
													onShowTrace={item.message.task_id
														? () => showMessageTrace(item.message)
														: undefined}
												/>
											</div>
										{/if}
									{/if}
								</div>
							{/each}
						</div>
					</div>
				</div>
			{/if}
		{/each}
	{/if}
		</div>
	</div>

	{#if showMessageIndex}
		{#key selected?.id}
		<MessageIndex
			marks={indexMarks}
			activeId={activeIndexId}
			{locale}
			label={t.stream.messageIndex}
			emptyLabel={t.stream.messageIndexEmpty}
			sender={(mark) => mark.kind === 'system' ? (locale === 'zh' ? '系统' : 'System') : whoAuthor(mark.author)}
			hasEarlier={Boolean(view?.hasOlderMessages)}
			loading={Boolean(view?.olderLoading)}
			earlierLabel={view?.olderLoading ? t.stream.loadingEarlier : t.stream.loadEarlier}
			onLoadEarlier={() => void runtime.loadOlderMessages(selected?.id)}
			onJump={jumpToIndexMark}
		/>
		{/key}
	{/if}

	<Composer
		bind:this={composer}
		{runtime}
		{t}
		{selected}
		{showScrollBottom}
		onScrollToBottom={() => scrollToBottom(true)}
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
			onShowTrace={() => showMessageTrace(activeMenu.message)}
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


	.empty-icon {
		width: 60px;
		height: 60px;
		border-radius: 50%;
		background: var(--line-subtle);
		border: 1px solid var(--line);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted-light);
		margin-bottom: 14px;
	}




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

	/* Message Wrappers */
	.msg-wrap {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		width: 100%;
		position: relative;
	}

	.msg-wrap.is-bot {
		max-width: 100%;
		align-self: stretch;
	}

	/* A reply takes the column's full width, so its hover toolbar sits at the column's far edge. */
	.msg-wrap.is-bot:not(.is-system-row) .msg-segment {
		width: 100%;
	}

	.msg-wrap.is-user {
		max-width: 80%;
		align-self: flex-end;
		justify-content: flex-end;
	}

	.msg-wrap.is-card-wrap {
		max-width: 100%;
		align-self: stretch;
	}

	.msg-wrap.is-system-row {
		max-width: 84%;
		align-self: flex-start;
	}

	.avatar-col {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.bot-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		font-size: 13px;
		border: 1px solid;
		box-shadow: var(--shadow-xs);
		user-select: none;
		overflow: hidden;
	}

	button.bot-avatar {
		background: transparent;
		padding: 0;
		margin: 0;
		font: inherit;
		color: inherit;
	}

	button.bot-avatar.is-clickable {
		cursor: pointer;
		outline: none;
		transition: transform 0.15s ease, box-shadow 0.15s ease;
	}

	button.bot-avatar.is-clickable:hover {
		transform: scale(1.06);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
	}

	button.bot-avatar.is-clickable:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.user-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		font-size: 13px;
		/* The mark's white teammate: the pane's colour ringed in the accent, not a solid black disc. */
		background: var(--pane);
		color: var(--accent);
		border: 1.5px solid var(--accent);
		user-select: none;
	}

	.msg-content {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.msg-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 4px;
		padding: 0 2px;
		font-size: 12px;
		line-height: 1;
	}

	.msg-header.is-right {
		justify-content: flex-end;
	}

	.sender-name {
		font-weight: 650;
		color: var(--ink);
		font-size: 13px;
	}

	button.sender-name.is-clickable {
		background: transparent;
		border: none;
		padding: 0;
		margin: 0;
		font: inherit;
		font-weight: 650;
		color: var(--ink);
		font-size: 13px;
		cursor: pointer;
		text-align: left;
		line-height: inherit;
		transition: color 0.15s ease;
	}

	button.sender-name.is-clickable:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	button.sender-name.is-clickable:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/*
	 * The app's own line sits under the mark instead of a Bot's face (the mark is the one place its
	 * mustard belongs), on the pane like your portrait, so a receipt never reads as the Bot talking.
	 */
	.app-avatar {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--pane);
		border: 1px solid var(--line);
		box-shadow: var(--shadow-xs);
		user-select: none;
	}

	/* A quiet tag beside the name: the accent is kept for what you can act on. */
	.bot-badge,
	.app-badge {
		font-size: 10px;
		font-weight: 600;
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		border: 1px solid var(--line);
		color: var(--muted);
		line-height: 1.2;
	}

	.ask-badge {
		font-size: 10px;
		font-weight: 700;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--accent-tint);
		border: 1px solid var(--accent-border);
		color: var(--accent);
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.model-badge {
		font-size: 11px;
		padding: 1px 6px;
		border-radius: var(--radius-xs);
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--muted);
	}

	.segment-count-badge {
		font-size: 10px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--muted);
		letter-spacing: 0.01em;
	}

	.msg-time {
		font-size: 11px;
		color: var(--muted);
		margin-left: 2px;
	}

	/* 「已编辑」 under the bubble: as quiet as the time, and it opens what the line said before. */
	.msg-edited-row {
		display: flex;
		justify-content: flex-end;
		margin-top: 3px;
		padding: 0 2px;
	}

	.msg-edited {
		padding: 0;
		border: 0;
		background: none;
		font-size: 11px;
		line-height: inherit;
		color: var(--muted);
		cursor: pointer;
		transition-property: color;
		transition-duration: 0.15s;
	}

	.msg-edited:hover,
	.msg-edited[aria-expanded='true'] {
		color: var(--ink);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	/* A line being changed is a field, not a bubble: the column's width, neutral, with the focus colour. */
	.msg.is-you.is-editing {
		width: 100%;
		background: var(--pane);
		color: var(--ink);
		border-color: var(--accent-border);
		box-shadow: none;
	}

	.msg.is-editing .msg-toolbar {
		display: none;
	}

	.msg-versions {
		display: grid;
		gap: 6px;
		align-self: flex-end;
		max-width: 100%;
		margin-top: 6px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--ink);
	}

	.msg-versions-title,
	.msg-versions-note {
		font-size: 11px;
		color: var(--muted);
	}

	.msg-version {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 8px;
		align-items: baseline;
		font-size: 13px;
		line-height: 1.5;
	}

	.msg-version-time {
		font-size: 11px;
		color: var(--muted);
	}

	.msg-version-body {
		color: var(--ink-secondary);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* Bot Duration & Response Time Badge */
	.duration-badge {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 11px;
		font-weight: 400;
		color: var(--muted);
		letter-spacing: -0.01em;
	}

	.msg-segments.is-user-segments {
		align-items: flex-end;
	}

	.msg-segment.is-user-segment {
		align-items: flex-end;
	}

	.msg-wrap.is-group .msg-segment:not(:first-child) {
		margin-top: 4px;
		padding-top: 8px;
		border-top: 1px dashed var(--line-subtle);
	}

	.msg-wrap.is-group .msg-segment:not(:first-child) .msg:not(.is-you) {
		border-radius: var(--radius-md) var(--radius-lg) var(--radius-lg) var(--radius-lg);
	}

	.msg-wrap.is-group .msg-segment:not(:first-child) .msg.is-you {
		border-radius: var(--radius-lg) var(--radius-md) var(--radius-lg) var(--radius-lg);
	}

	.segment-meta.is-right {
		justify-content: flex-end;
	}

	.segment-tag {
		font-size: 10px;
		font-weight: 700;
		padding: 1.5px 6px;
		border-radius: var(--radius-xs);
		background: color-mix(in srgb, var(--accent) 8%, transparent);
		color: var(--accent);
		border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
		letter-spacing: 0.02em;
		line-height: 1.2;
	}

	/* Message Cards */
	.msg {
		position: relative;
		width: fit-content;
		max-width: 100%;
		padding: 10px 14px;
		border-radius: var(--radius-xs) 16px 16px 16px;
		background: var(--bot);
		border: 1px solid var(--bot-border);
		color: var(--bot-text);
		box-shadow: 0 1px 3px rgba(18, 28, 32, 0.03);
		transition: box-shadow 0.15s ease;
		word-break: break-word;
	}

	/* A definite width so the table wrap can scroll instead of shrinking columns. */
	.msg:has(:global(.md-table-wrap)) {
		width: 100%;
	}

	.msg.is-you {
		background: var(--you);
		color: var(--you-text);
		border: 1px solid transparent;
		/* The corner nearest your avatar is the mark's bubble tail. */
		border-radius: var(--radius-lg) var(--radius-xs) var(--radius-lg) var(--radius-lg);
		box-shadow: var(--shadow-xs);
	}

	/*
	 * A Bot's reply is read rather than glanced at — reports, lists, tables, file links — so it sits
	 * on the page like a document: no bubble, the column's full width. The bubble stays for what
	 * you said, and cards (a question, an approval) keep theirs.
	 */
	.msg.is-reply,
	.msg.is-reply.is-stream {
		width: 100%;
		padding: 0 2px;
		background: none;
		border: 0;
		border-radius: 0;
		box-shadow: none;
	}

	/* Message Toolbar on Hover. The strip spans the bubble and the pill sits in its far corner; on a
	   bubble narrower than the pill the strip grows to fit, away from the avatar rather than over it. */
	.msg-toolbar {
		position: absolute;
		top: -14px;
		left: 8px;
		width: calc(100% - 16px);
		min-width: max-content;
		display: flex;
		justify-content: flex-end;
		opacity: 0;
		transform: translateY(2px);
		pointer-events: none;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		z-index: 10;
	}

	.msg-toolbar-pill {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 2px 5px;
		/* Shrunk to a one-word bubble, "✓ 已复制" used to break after every character. */
		white-space: nowrap;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		box-shadow: 0 3px 10px rgba(18, 28, 32, 0.08);
		pointer-events: none;
	}

	.msg:hover .msg-toolbar,
	.msg-segment:hover .msg-toolbar {
		opacity: 1;
		transform: translateY(0);
	}

	.msg:hover .msg-toolbar-pill,
	.msg-segment:hover .msg-toolbar-pill {
		pointer-events: auto;
	}

	.msg-wrap.is-user .msg-toolbar {
		left: auto;
		right: 8px;
		justify-content: flex-start;
	}

	.act-btn {
		padding: 3px 6px;
		color: var(--muted);
		border-radius: var(--radius-xs);
		display: flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;
		transition: 0.12s ease;
		transition-property: var(--transition-props);
	}

	.act-btn:hover {
		color: var(--accent);
		background: var(--line-subtle);
	}

	.quote-ref {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		margin: 0 0 8px;
		padding: 6px 10px;
		border: none;
		border-left: 2px solid color-mix(in srgb, currentColor 45%, transparent);
		border-radius: 0 var(--radius-md) var(--radius-md) 0;
		background: color-mix(in srgb, currentColor 8%, transparent);
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.quote-ref-who {
		font-size: 11px;
		font-weight: 650;
		opacity: 0.85;
	}

	.quote-ref-body {
		font-size: 12px;
		line-height: 1.35;
		opacity: 0.72;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.msg.is-you .quote-ref {
		background: rgba(255, 255, 255, 0.14);
		border-left-color: rgba(255, 255, 255, 0.55);
	}

	.rx-row.is-right {
		justify-content: flex-end;
	}

	.rx-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 12px;
		background: var(--reaction-bg);
		border: 1px solid var(--line);
		box-shadow: 0 1px 2px rgba(18, 28, 32, 0.04);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.rx-chip:hover {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.rx-chip.is-active {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	/* Hide duplicate .who when .msg-header is available */
	.msg-wrap .msg .who {
		display: none;
	}

	/*
	 * Kept visible on the cards that need a speaker line. `.stream-inner > .msg .who` was here
	 * too and never matched — messages sit inside a group wrapper, never directly under
	 * `.stream-inner`. Scoping the sheet is what finally said so.
	 */
	.msg.is-approval .who,
	.msg.is-ask .who {
		display: block;
	}

	.msg .who {
		font-size: 11px;
		font-weight: 700;
		margin-bottom: 4px;
		letter-spacing: 0.03em;
		color: var(--muted);
	}

	.msg.is-you .who {
		color: rgba(255, 255, 255, 0.8);
	}

	.msg :global(.body) {
		white-space: pre-wrap;
		line-height: 1.55;
		font-size: 14px;
	}

	/* Streaming Active Turn */
	.msg.is-stream {
		border-left: 3.5px solid var(--accent);
		background: var(--bot);
		box-shadow: var(--shadow-sm);
	}

	/* Working is the accent everywhere — the sidebar row, the portrait dot and this. */
	.pulse {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		margin-left: 4px;
		vertical-align: middle;
		animation: pulse 1.2s ease-in-out infinite;
	}


	/* Attached replying / thinking indicator under trigger message */
	.msg-attached-botdm {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 5px;
	}

	.msg-attached-botdm.is-user {
		align-items: flex-end;
	}

	.msg-attached-replying {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 5px;
		/* The line names a path or a command: it clips inside the message's width, never past it. */
		max-width: 100%;
	}

	.msg-attached-replying.is-user {
		align-items: flex-end;
	}

	/* A Bot message's last line: its commands, its tag, its time and how long it took. */
	.msg-foot {
		margin-top: 6px;
	}

	.msg-foot-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 14px;
		max-width: 100%;
	}

	/* Pushed to the line's right end, on whichever line it lands. */
	.msg-when {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 8px;
		margin-left: auto;
		white-space: nowrap;
	}

	.msg-foot :global(.command-activity) {
		margin-top: 0;
	}

	/* The tag's own spacing was for a line of its own. */
	.msg-foot :global(.message-attribution) {
		margin-top: 0;
	}

	/* The working bubble's last line: its step, that step's time and the whole turn's. */
	.stream-foot {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		margin-top: 8px;
		color: var(--accent);
		font-size: 12px;
		font-weight: 500;
	}

	.stream-foot .pulse {
		flex-shrink: 0;
		margin-left: 0;
	}

	/* A long command clips; the times beside it never do. */
	.stream-step {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.stream-step-elapsed,
	.stream-foot .duration-badge {
		flex-shrink: 0;
	}

	/* The whole turn's time sits at the right end, where a finished message has its time. */
	.stream-foot .duration-badge {
		margin-left: auto;
		padding-left: 8px;
	}

	.stream-step.is-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 0;
		border: 0;
		background: transparent;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.stream-step.is-toggle .toggle-label {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.stream-step.is-toggle::after {
		content: '';
		flex-shrink: 0;
		width: 4px;
		height: 4px;
		margin: 0 1px 2px 1px;
		border-right: 1.5px solid currentColor;
		border-bottom: 1.5px solid currentColor;
		transform: rotate(45deg);
		opacity: 0.6;
		transition: transform 0.15s ease;
	}

	.stream-step.is-toggle[aria-expanded='true']::after {
		margin-bottom: -2px;
		transform: rotate(-135deg);
	}

	.stream-step.is-toggle:hover .toggle-label {
		color: var(--ink);
	}

	.stream-step.is-toggle:focus-visible {
		border-radius: var(--radius-xs);
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* Streaming Blinking Cursor */
	.streaming-cursor {
		display: inline-block;
		width: 7px;
		height: 14px;
		background: var(--accent);
		margin-left: 3px;
		vertical-align: -2px;
		animation: cursorBlink 0.8s infinite;
	}

	.welcome-identity-btn {
		background: transparent;
		border: none;
		padding: 8px 16px;
		margin: -8px 0 0;
		border-radius: var(--radius-lg);
		cursor: pointer;
		display: flex;
		flex-direction: column;
		align-items: center;
		transition: background 0.15s ease;
		color: inherit;
		font: inherit;
	}

	.welcome-identity-btn:hover {
		background: var(--line-subtle);
	}

	.welcome-identity-btn:hover .welcome-avatar {
		transform: scale(1.04);
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08);
	}

	.welcome-identity-btn:hover .welcome-title {
		color: var(--accent);
	}

	.welcome-identity-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.welcome-avatar {
		width: 58px;
		height: 58px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		font-size: 24px;
		font-weight: 700;
		border: 2px solid;
		margin-bottom: 10px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
		transition: transform 0.15s ease, box-shadow 0.15s ease;
	}

	.welcome-title {
		margin: 0 0 6px;
		font-size: 18px;
		font-weight: 700;
		color: var(--ink);
		transition: color 0.15s ease;
	}

	.welcome-duties {
		background: var(--chip);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 10px 16px;
		margin-bottom: 14px;
		width: 100%;
	}

	.starter-chip {
		padding: 9px 14px;
		border-radius: var(--radius-md);
		background: var(--pane);
		border: 1px solid var(--line);
		color: var(--ink);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		box-shadow: var(--shadow-xs);
	}

	.starter-chip:hover {
		border-color: var(--accent);
		background: var(--accent-tint);
		color: var(--accent);
		transform: translateX(3px);
	}

	.starter-chip:disabled {
		opacity: 0.5;
		cursor: not-allowed;
		transform: none;
		box-shadow: none;
		border-color: var(--line);
		background: var(--pane);
		color: var(--ink-secondary);
	}

	/* Ask Card: one steady width, since it is a form — choices and your answer are laid out in it. */
	.msg.is-ask {
		width: min(100%, 440px);
		background: var(--pane);
		border: 1px solid var(--accent-border);
		max-width: 480px;
		box-shadow: var(--shadow-sm);
		border-radius: var(--radius-lg);
		padding: 14px 16px;
	}

	.msg.is-ask .who {
		color: var(--accent);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	/* Approval Card */
	.msg.is-approval {
		align-self: stretch;
		max-width: none;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		padding: 16px 18px;
		box-shadow: var(--shadow-sm);
	}

	/* The card is plain; what says it is waiting on you is this label in the warn colour. */
	.msg.is-approval .who {
		color: var(--warn-text);
		font-size: var(--text-caption);
		font-weight: 650;
		margin-bottom: 6px;
	}

	.approval-key {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 12px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.approval-key :global(input[type="password"]) {
		width: 100%;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 8px 11px;
		background: var(--input-bg);
		color: var(--ink);
		font-size: 13px;
		font-weight: 400;
		box-shadow: var(--shadow-xs);
	}

	.approval-key :global(input[type="password"]:focus) {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
		outline: none;
	}

	.approval-key :global(.hint) {
		margin: 0;
		font-size: 12px;
		font-weight: 400;
		color: var(--muted);
	}

	.approval-key :global(.field-error) {
		margin: 0;
		font-size: 12px;
		font-weight: 400;
		color: var(--danger);
	}

	.approval-acts :global(button) {
		background: var(--accent);
		color: var(--on-accent);
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		padding: 7px 14px;
		font-size: 13px;
		font-weight: 600;
		box-shadow: var(--shadow-xs);
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.approval-acts :global(button:hover) {
		background: var(--accent-hover);
	}

	.approval-acts :global(.deny) {
		background: var(--btn-secondary-bg);
		color: var(--danger);
		border: 1px solid var(--danger-line);
	}

	.approval-acts :global(.deny:hover) {
		background: var(--danger-bg);
		border-color: var(--danger);
	}

	/* System Messages */
	.msg.is-system {
		background: var(--line-subtle);
		border: 1px solid var(--line);
		color: var(--ink-secondary);
		padding: 8px 12px;
		font-size: 13px;
		border-radius: var(--radius-md);
		box-shadow: none;
		display: inline-flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
	}

	.msg.is-system.has-continue {
		background: var(--pane);
		border-style: solid;
		border-color: var(--line);
		padding: 10px 14px;
		box-shadow: var(--shadow-xs);
	}

	.msg.is-system.is-unreachable {
		border-color: var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
	}

	.system-msg-content {
		line-height: 1.4;
		/* A 进度询问 status line is several lines long; a one-line unreachable/interrupt notice still
		   reads fine top-aligned with its icon. */
		align-items: flex-start;
	}

	.system-msg-content .body {
		white-space: pre-wrap;
	}

	.system-msg-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.system-msg-icon.is-unreachable {
		color: var(--warn);
	}

	.system-msg-icon.is-interrupt {
		color: var(--muted);
	}

	.system-msg-actions {
		display: flex;
		align-items: center;
		margin-top: 2px;
	}

	.btn-continue-turn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		padding: 0 12px;
		font-size: 12px;
		font-weight: 500;
		color: var(--accent);
		background: var(--accent-tint);
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		user-select: none;
	}

	.btn-continue-turn:hover:not(:disabled) {
		background: var(--accent);
		color: var(--on-accent);
		border-color: var(--accent);
		box-shadow: 0 1px 4px var(--accent-glow);
	}

	.btn-continue-turn:active:not(:disabled) {
		background: var(--accent-active);
		color: var(--on-accent);
		border-color: var(--accent-active);
	}

	.btn-continue-turn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.btn-continue-turn .continue-icon {
		flex-shrink: 0;
	}

	.msg-wrap.is-system-row .msg.is-system .who {
		display: none;
	}

	.msg-wrap.is-search-hit {
		scroll-margin-top: 28px;
		scroll-margin-bottom: 28px;
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		box-shadow: 0 0 0 2px var(--accent-border);
		animation: search-hit-pulse 1.1s ease-out;
	}

	.msg-segment.is-search-hit {
		scroll-margin-top: 28px;
		scroll-margin-bottom: 28px;
		border-radius: 16px;
		background: var(--accent-tint);
		box-shadow: 0 0 0 2px var(--accent-border);
		animation: search-hit-pulse 1.1s ease-out;
	}

	.msg-wrap.is-selected {
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		box-shadow: 0 0 0 2px var(--accent-border);
		transition: background 0.15s ease, box-shadow 0.15s ease;
	}

	.msg-segment.is-selected {
		border-radius: 16px;
		background: var(--accent-tint);
		box-shadow: 0 0 0 2px var(--accent-border);
		transition: background 0.15s ease, box-shadow 0.15s ease;
	}

	.is-streaming-avatar {
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	@keyframes cursorBlink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0; }
	}

	@keyframes search-hit-pulse {
		0% {
		box-shadow: 0 0 0 0 var(--accent-glow);
		}
		45% {
		box-shadow: 0 0 0 6px var(--accent-glow);
		}
		100% {
		box-shadow: 0 0 0 2px var(--accent-border);
		}
	}

	@media (max-width: 680px), (pointer: coarse) {
		.msg-wrap,
		.msg-segment,
		.msg,
		.msg :global(*) {
			-webkit-touch-callout: none;
			-webkit-user-select: none;
			user-select: none;
		}

		/* Words being changed select, and paste, like any field's (ADR 0063). */
		.msg :global(.msg-editor),
		.msg :global(.msg-editor *) {
			-webkit-touch-callout: default;
			-webkit-user-select: text;
			user-select: text;
		}
	}

	/*
	 * The phone layout follows the conversation's width (the `conversation` container), so a
	 * workbench pane narrower than a phone gets it in a wide window too. What only a touch screen
	 * needs — no text selection on long-press, no hover pill — still asks the window.
	 */
	@container conversation (max-width: 680px) {
		.msg-wrap.is-bot,
		.msg-wrap.is-user {
			max-width: 100%;
		}

		/* The composer docks below the stream here instead of floating over it (see Composer), so
		   the transcript needs no room kept for it. */
		.stream-inner,
		.has-message-index .stream-inner {
			padding: 14px 12px 16px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
	.pulse {
	animation: none;
	}
	}
	@container conversation (max-width: 680px) {
		/*
		 * A phone leaves a bubble about 340px wide, so the line above each message has to earn
		 * its place. It used to wrap twice over: the Bot's name broke across lines and the model
		 * chip broke mid-token, and the hover toolbar landed on top of both. Now the name takes
		 * what it needs and truncates, the model is left to the conversation header that already
		 * shows it, and the time and duration sit together against the right edge.
		 */
		.msg-header {
			flex-wrap: nowrap;
			gap: 5px;
			min-width: 0;
		}

		.sender-name,
		button.sender-name.is-clickable {
			min-width: 0;
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
		}

		.msg-header .model-badge {
			display: none;
		}

		.msg-header .bot-badge,
		.msg-header .app-badge,
		.msg-header .segment-count-badge,
		.msg-header .msg-time {
			flex-shrink: 0;
		}

		.msg-header .msg-time {
			margin-left: auto;
		}

		/* Your own portrait next to a name that already says 你 costs 42px of every line. */
		.msg-wrap.is-user .avatar-col {
			display: none;
		}

		.msg {
			padding: 9px 12px;
		}
	}

	@media (max-width: 680px) {
		/* Long-press opens the same copy and reply actions, so the hover pill has no job here —
		   and it used to sit on top of the line above the bubble. A narrow pane under a mouse
		   keeps it. */
		.msg-toolbar {
			display: none;
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
