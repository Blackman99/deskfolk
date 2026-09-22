<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { USER_MEMBER, type Attachment, type Bot, type Message, type SessionSummary } from '@real-bot/protocol';
	import Composer from './Composer.svelte';
	import MessageAttachments from './MessageAttachments.svelte';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import CommandActivity from './CommandActivity.svelte';
	import BotDmEntry from './BotDmEntry.svelte';
	import { indexBotDmsByOrigin } from './bot-dm-entries.ts';
	import SessionAvatar from '../SessionAvatar.svelte';
	import {
		approvalForMessage,
		approvalNeedsSecret,
		approvalSecretRequired,
		canAlwaysAllow,
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
		isDifferentDay
	} from './chat-view.ts';
	import { composerLocked } from './composer-mode.ts';
	import type { Copy } from '../copy.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import type { RenderMarkdownOptions } from '../markdown.ts';
	import { classifySession, presentBotIds, youBotPeer } from '../sidebar/session-groups.ts';
	import { canQuoteReply, draftWithQuoteMention, quotePreview, quotedBotName } from './quote-reply.ts';
	import MessageContextMenu from './MessageContextMenu.svelte';
	import { extractAssociatedFiles } from './message-context-menu.ts';
	import { handedOverPaths, withoutAttachmentDeclarations } from '../overlays/artifacts.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import { getStarterOptions } from './starter-prompts.ts';
	import { distanceFromBottom, isNearBottom, maxScrollTop, stickAfterScroll } from './stream-scroll.ts';
	import { composeTranscript, isLiveStatus, isPendingAsk, transcriptItemKey } from './transcript.ts';
	import { HISTORY_WINDOW_INITIAL, HISTORY_WINDOW_STEP, windowForIndex, windowedItems } from './history-window.ts';
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
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	const connected = $derived(runtime.connection === 'connected');
	const selectedKind = $derived(selected ? classifySession(selected) : null);
	const showMessageAvatars = $derived(selectedKind !== 'you-bot');
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(selectedPeer ? (botsById.get(selectedPeer) ?? null) : null);
	const sessionSettingsLabel = $derived(
		selectedKind === 'group' ? t.top.groupSettings : t.top.botSettings
	);
	const lockedComposer = $derived(composerLocked(selected, botsById));
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived });
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
	const groupPresent = $derived(selected ? presentBotIds(selected) : []);

	let composer = $state<{ focus: () => void } | null>(null);

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
		const error = await runtime.resolveApproval(card.id, action, key);
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
				)
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
	 * Growing the window prepends content, and the browser keeps `scrollTop`, so the view would
	 * slide down by whatever was added. Anchoring on the distance to the bottom keeps the message
	 * the person was reading exactly where it was.
	 */
	async function showEarlier(): Promise<void> {
		const el = streamContainer;
		const anchor = el ? el.scrollHeight - el.scrollTop : null;
		stickToBottom = false;
		if (hiddenOlder > 0) historyWindow += HISTORY_WINDOW_STEP;
		else if (runtime.hasOlderMessages) {
			await runtime.loadOlderMessages();
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
		liveTurnsHere.find((turn) => turn.id === runtime.focusedTurnId) ?? liveTurnsHere[0]
	);

	function getDraft(askId: string): string {
		return runtime.getAskDraft(askId)?.body ?? '';
	}

	function updateDraft(askId: string, val: string): void {
		runtime.setAskDraft(askId, val);
	}

	async function replyAsk(askId: string): Promise<void> {
		const record = runtime.getAskDraft(askId);
		const body = (record?.body ?? '').trim();
		if (!body) return;
		const submittedVersion = record?.version ?? 1;
		stickToBottom = true;
		const res = await runtime.sendAsk(askId, body);
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
		const sId = runtime.selectedId;
		const lastMsgId = lastMessageId;
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
			if (runtime.selectedId === sId && lastMsgId) {
				void runtime.submitBoundedRead(sId, lastMsgId);
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

	$effect(() => {
		void runtime.selectedId;
		cancelJumpToBottom();
		historyWindow = HISTORY_WINDOW_INITIAL;
		if (runtime.highlightedMessageId) {
			stickToBottom = false;
			return () => cancelJumpToBottom();
		}
		stickToBottom = true;
		showScrollBottom = false;
		void tick().then(() => pinStreamToBottom());
		return () => cancelJumpToBottom();
	});

	$effect(() => {
		const id = runtime.highlightedMessageId;
		const token = runtime.searchHighlightToken;
		if (!id) return;
		stickToBottom = false;
		void snapshot.messages;
		void runtime.selectedId;
		void token;
		const at = stream.findIndex((item) => item.type === 'message' && item.message.id === id);
		historyWindow = windowForIndex(stream.length, at, untrack(() => historyWindow));
		void tick().then(() => {
			if (runtime.highlightedMessageId !== id) return;
			scrollHighlightedMessage();
		});
	});

	$effect(() => {
		const outer = streamContainer;
		const inner = streamInner;
		if (!outer || !inner) return;
		void stickToBottom;
		const follow = () => {
			if (jumpToBottom) return;
			if (stickToBottom) {
				pinStreamToBottom();
				return;
			}
			showScrollBottom = !isNearBottom(outer.scrollHeight, outer.scrollTop, outer.clientHeight);
		};
		const ro = new ResizeObserver(follow);
		ro.observe(inner);
		ro.observe(outer);
		window.addEventListener('resize', follow);
		follow();
		return () => {
			ro.disconnect();
			window.removeEventListener('resize', follow);
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

	function who(message: Message): string {
		if (message.author === USER_MEMBER) return t.common.you;
		return botsById.get(message.author)?.name ?? t.top.deleted;
	}

	function whoAuthor(author: string): string {
		if (author === USER_MEMBER) return t.common.you;
		return botsById.get(author)?.name ?? t.top.deleted;
	}

	function scrollHighlightedMessage(): void {
		const id = runtime.highlightedMessageId;
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
		return messageShowsAttachments(message) ? withoutAttachmentDeclarations(message.body) : message.body;
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
		runtime.draft = prompt;
		void tick().then(() => composer?.focus());
	}

	/** The composer hands the files over; scrolling to the new message is the stage's job. */
	async function sendFromComposer(files: File[]): Promise<void> {
		stickToBottom = true;
		await runtime.send({ attachments: files.length > 0 ? files : undefined });
		await tick();
		scrollToBottom(false);
	}

	function onStreamScroll(e: Event): void {
		const el = e.currentTarget as HTMLElement;
		if (!el) return;
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
		runtime.replyingToId = message.id;
		const name = quotedBotName(message, botsById);
		if (name) runtime.draft = draftWithQuoteMention(runtime.draft, name);
		void tick().then(() => composer?.focus());
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
	} | null>(null);
	const selectedMessageId = $derived(messageContextMenu?.message.id ?? null);

	let lastTouchTimestamp = 0;

	function handleMessageMouseDown(e: MouseEvent): void {
		// WebKit selects the word on secondary mousedown, before contextmenu fires.
		if (e.button === 2 || (e.button === 0 && e.ctrlKey)) e.preventDefault();
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
			selectedText: isSelectionInside ? (selection ?? null) : null
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
</script>

<div class="stream-stage flex-1 min-h-0 relative flex flex-col bg-pane overflow-hidden">
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
	{#if !selected}
		<div class="empty-state m-auto flex flex-col items-center justify-center text-center py-20 px-10 max-w-[360px]">
			<div class="empty-icon" aria-hidden="true">
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
				</svg>
			</div>
			<h2>{t.top.pickSession}</h2>
			<p class="muted">{t.top.pickSession}</p>
		</div>
	{:else if stream.length === 0 && runtime.historyLoading}
		<!-- A remote transcript arrives over the relay; saying so beats an empty room that fills
		     without warning. -->
		<div class="history-loading m-auto flex flex-col items-center gap-3 text-center py-20" role="status">
			<svg class="history-spinner" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
				<path d="M12 3a9 9 0 1 0 9 9" />
			</svg>
			<p class="muted">{t.stream.loadingHistory}</p>
		</div>
	{:else if stream.length === 0}
		<div class="empty-chat-welcome m-auto flex flex-col items-center text-center py-16 px-10 max-w-[460px]">
			{#if selectedKind === 'you-bot' && selectedPeerBot}
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
					<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="10"></circle>
						<line x1="8" y1="12" x2="16" y2="12"></line>
					</svg>
				</div>
				<h2>{titleOf(selected)}</h2>
			{/if}
			<p class="muted">{t.stream.empty}</p>
		</div>
	{:else}
		{#if runtime.hasOlderMessages && hiddenOlder === 0}
			<div class="load-earlier flex justify-center py-3">
				<button type="button" class="btn-xs" disabled={runtime.olderLoading} onclick={() => void showEarlier()}>
					{runtime.olderLoading ? t.stream.loadingEarlier : t.stream.loadEarlier}
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
					<div class="replying-list flex flex-col gap-5 self-start pt-2 px-2 pb-1 mt-[-8px]" aria-live="polite">
						<ReplyingIndicator
							entries={block.entries}
							{botsById}
							isUser={false}
							thinkingText={t.chat.thinking}
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
						class:is-search-hit={runtime.highlightedMessageId === singleMsg.message.id}
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
								{#if isPendingAsk(singleMsg.message, snapshot.turns, runtime.notificationCapabilities.pending_ask_v1) && !lockedComposer}
									{@const askErr = runtime.getAskDraft(singleMsg.message.id)?.error}
									<div class="ask-reply mt-5 flex gap-4">
										<input
											type="text"
											placeholder={t.stream.reply}
											value={getDraft(singleMsg.message.id)}
											oninput={(ev) =>
												updateDraft(singleMsg.message.id, (ev.currentTarget as HTMLInputElement).value)}
											onkeydown={(ev) => {
												if (ev.key === 'Enter') {
													ev.preventDefault();
													void replyAsk(singleMsg.message.id);
												}
											}}
										/>
										<button type="button" onclick={() => void replyAsk(singleMsg.message.id)}
											>{t.stream.reply}</button
										>
									</div>
									{#if askErr}
										<p class="ask-error text-12 text-danger mt-1.5">{askErr}</p>
									{/if}
								{:else}
									<div class="ask-ended text-12 text-muted mt-2">
										{t.notifications.askEndedReadOnly}
									</div>
								{/if}
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
						class:is-search-hit={runtime.highlightedMessageId === singleMsg.message.id}
					>
						<article class="msg is-approval">
							<div class="who">{t.stream.approval} · {who(singleMsg.message)}</div>
							<div class="body">{singleMsg.message.body}</div>
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
					{@const showContinue = canContinueInterrupt(singleMsg.message, snapshot.turns, {
						locked: lockedComposer,
						hasLiveTurnForBot: liveTurnsHere.some((turn) => turn.bot_id === singleMsg.message.author)
					})}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="msg-wrap is-bot is-system-row"
						data-message-id={singleMsg.message.id}
						class:is-search-hit={runtime.highlightedMessageId === singleMsg.message.id}
						class:is-selected={selectedMessageId === singleMsg.message.id}
						onmousedown={handleMessageMouseDown}
						ontouchstart={handleMessageTouchStart}
						oncontextmenu={(e) => handleMessageContextMenu(e, singleMsg.message)}
					>
						{#if showMessageAvatars}
					<div class="avatar-col">
							{#if sysBot}
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
								{#if sysBot}
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
								<span class="bot-badge">{t.chat.botBadge}</span>
								<span class="msg-time mono" title={formatFullTimestamp(singleMsg.message.created_at)}>
									{formatMessageTime(singleMsg.message.created_at)}
								</span>
							</div>
							<div class="msg-interrupt-row flex items-center gap-4 w-fit max-w-full">
								<article class="msg is-system">
									<div class="who">{who(singleMsg.message)}</div>
									<div class="body">{singleMsg.message.body}</div>
								</article>
								{#if showContinue}
									<button
										type="button"
										class="btn-mini-continue"
										title={t.stream.continueInterruptHint}
										disabled={!connected || runtime.busy}
										onclick={() => void runtime.continueInterrupt(singleMsg.message.id)}
									>
										{t.stream.continueInterrupt}
									</button>
								{/if}
							</div>
							{#if singleMsg.replying && singleMsg.replying.length > 0}
								<div class="msg-attached-replying" aria-live="polite">
									<ReplyingIndicator
										entries={singleMsg.replying}
										{botsById}
										isUser={false}
										thinkingText={t.chat.thinking}
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
										class:is-search-hit={runtime.highlightedMessageId === item.message.id}
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
										<article class="msg is-you">
											<div class="who">{who(item.message)}</div>
											<div class="msg-toolbar">
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
											{#if item.message.parent_id}
												{@const quoted = messageLookup.byId.get(item.message.parent_id)}
												<button
													type="button"
													class="quote-ref"
													onclick={() => quoted && runtime.setHighlightedMessage(quoted.id)}
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
												inverted
												onOpenArtifact={(path) => onOpenArtifact(path, undefined, item.message.id)}
												onOpenProfile={onOpenProfile}
											/>
											{#if messageShowsAttachments(item.message)}
												<MessageAttachments
													attachments={item.message.attachments}
													body={item.message.body}
													api={runtime.client}
													{t}
													onPreview={(att) => onOpenArtifact(att.workspace_relpath, att, item.message.id)}
												/>
											{/if}
										</article>
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
													thinkingText={t.chat.thinking}
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
														? () => runtime.openTrace(item.message.task_id!)
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
							{:else}
								{@const single = group.items[0]}
								{#if single.type === 'streaming'}
									{@const liveElapsed = formatLiveDuration(single.turn.created_at, nowMs)}
									<span class="streaming-status inline-flex items-center gap-2 text-11p5 text-accent font-medium">
										<span class="pulse"></span>
										{t.stream.streaming}
									</span>
									<span class="duration-badge mono live">⏱️ {liveElapsed}</span>
									{#if selected?.kind !== 'group'}
										<button
											type="button"
											class="btn-mini-stop"
											title={t.composer.stop}
											onclick={() => void runtime.stopTurn()}
										>
											<span class="stop-icon-mini">■</span>
											<span>{t.composer.stop}</span>
										</button>
									{/if}
								{:else if single.type === 'message'}
									{@const duration = calculateBotDuration(single.message, snapshot.messages, snapshot.turns, messageLookup)}
									<span class="msg-time mono" title={formatFullTimestamp(single.message.created_at)}>
										{formatMessageTime(single.message.created_at)}
									</span>
									{#if duration}
										<span class="duration-badge mono" title={t.chat.replyTime(duration.formatted)}>
											<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
											{duration.formatted}
										</span>
									{/if}
								{/if}
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
										runtime.highlightedMessageId === item.message.id}
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
											{#if item.type === 'streaming'}
												{@const liveElapsed = formatLiveDuration(item.turn.created_at, nowMs)}
												<span class="streaming-status inline-flex items-center gap-2 text-11p5 text-accent font-medium">
													<span class="pulse"></span>
													{t.stream.streaming}
												</span>
												<span class="duration-badge mono live">⏱️ {liveElapsed}</span>
												{#if selected?.kind !== 'group'}
													<button
														type="button"
														class="btn-mini-stop"
														title={t.composer.stop}
														onclick={() => void runtime.stopTurn()}
													>
														<span class="stop-icon-mini">■</span>
														<span>{t.composer.stop}</span>
													</button>
												{/if}
											{:else if item.type === 'message'}
												{@const duration = calculateBotDuration(item.message, snapshot.messages, snapshot.turns, messageLookup)}
												<span class="msg-time mono" title={formatFullTimestamp(item.message.created_at)}>
													{formatMessageTime(item.message.created_at)}
												</span>
												{#if duration}
													<span class="duration-badge mono" title={t.chat.replyTime(duration.formatted)}>
														<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
														{duration.formatted}
													</span>
												{/if}
											{/if}
										</div>
									{/if}

									{#if item.type === 'streaming'}
										<article class="msg is-stream">
											<div class="who">
												{botAuthor?.name ?? t.top.deleted} · {t.stream.streaming}
												<span class="pulse"></span>
											</div>
											<MarkdownBody
												source={item.turn.partial_text ?? ''}
												options={markdownOpts(undefined, { streaming: true })}
												copyLabel={t.chat.copyCode}
												copiedLabel={t.chat.copied}
												onOpenArtifact={(path) => onOpenArtifact(path)}
												onOpenProfile={onOpenProfile}
											>
												<span class="streaming-cursor"></span>
											</MarkdownBody>
											<!--
												What it is doing while it does it. Ephemeral: the turn's own record is what
												survives a reload, so nothing here is stored and nothing enters the transcript.
											-->
											{#key runtime.activityRevision}
												<CommandActivity rows={runtime.activity.forTurn(item.turn.id)} {t} />
											{/key}
										</article>
									{:else if item.type === 'message'}
										{@const rxGroups = groupReactions(item.message.reactions, USER_MEMBER)}
										<article class="msg">
											<div class="who">{who(item.message)}</div>
											<div class="msg-toolbar">
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
											{#if item.message.parent_id}
												{@const quoted = messageLookup.byId.get(item.message.parent_id)}
												<button
													type="button"
													class="quote-ref"
													onclick={() => quoted && runtime.setHighlightedMessage(quoted.id)}
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
												onOpenProfile={onOpenProfile}
											/>
											{#if messageShowsAttachments(item.message)}
												<MessageAttachments
													attachments={item.message.attachments}
													body={item.message.body}
													api={runtime.client}
													{t}
													onPreview={(att) => onOpenArtifact(att.workspace_relpath, att, item.message.id)}
												/>
											{/if}
										</article>
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
													thinkingText={t.chat.thinking}
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
														? () => runtime.openTrace(item.message.task_id!)
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

	{#if showScrollBottom}
		<button
			type="button"
			class="scroll-bottom-btn"
			title={t.chat.scrollToBottom}
			aria-label={t.chat.scrollToBottom}
			onclick={() => scrollToBottom(true)}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
		</button>
	{/if}

	<Composer
		bind:this={composer}
		{runtime}
		{t}
		{selected}
		onSend={sendFromComposer}
		onPickPrompt={pickStarterPrompt}
	/>

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
			onShowTrace={() => {
				if (activeMenu.message.task_id) runtime.openTrace(activeMenu.message.task_id);
			}}
			onCopyId={() => handleCopyMessageId(activeMenu.message.id)}
			onReaction={(emoji) => void runtime.toggleReaction(activeMenu.message.id, emoji)}
		/>
	{/if}
</div>

<style>
	.msg.is-you :global(.attachment-file-btn),

	.msg.is-you :global(.attachment-bundle-btn) {
		background: rgba(255, 255, 255, 0.9);
		color: #0f172a;
	}

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

	.empty-state :global(h2) {
		font-size: 15px;
		font-weight: 600;
		color: var(--ink);
		margin: 0 0 6px;
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
		background: var(--line);
		z-index: 1;
	}

	.date-pill {
		position: relative;
		z-index: 2;
		padding: 3px 12px;
		border-radius: 9999px;
		background: var(--date-pill-bg);
		border: 1px solid var(--date-pill-border);
		font-size: 11px;
		font-weight: 600;
		color: var(--date-pill-text);
		box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
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
		max-width: 84%;
		align-self: flex-start;
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
		background: #1e293b;
		color: #ffffff;
		border: 1px solid #334155;
		box-shadow: var(--shadow-xs);
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
		font-size: 12.5px;
	}

	button.sender-name.is-clickable {
		background: transparent;
		border: none;
		padding: 0;
		margin: 0;
		font: inherit;
		font-weight: 650;
		color: var(--ink);
		font-size: 12.5px;
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

	.bot-badge {
		font-size: 9.5px;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: 4px;
		background: rgba(37, 99, 235, 0.08);
		color: var(--accent);
		letter-spacing: 0.02em;
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
		font-size: 10.5px;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--muted);
	}

	.segment-count-badge {
		font-size: 10px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--muted);
		letter-spacing: 0.01em;
	}

	.msg-time {
		font-size: 11px;
		color: var(--muted-light);
		margin-left: 2px;
	}

	/* Bot Duration & Response Time Badge */
	.duration-badge {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 11px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--ok-bg);
		border: 1px solid var(--ok-line);
		color: var(--ok);
		letter-spacing: -0.01em;
	}

	.duration-badge.live {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
		animation: pulse 1.2s infinite;
	}

	.btn-mini-stop {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 11px;
		font-weight: 600;
		color: var(--danger);
		background: var(--danger-bg);
		border: 1px solid var(--danger-line);
		border-radius: var(--radius-sm);
		padding: 1px 6px;
		cursor: pointer;
		margin-left: auto;
		transition: all 0.15s ease;
	}

	.btn-mini-stop:hover {
		background: var(--danger-bg);
		border-color: var(--danger);
		filter: brightness(0.95);
	}

	.btn-mini-continue {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		font-size: 11px;
		font-weight: 600;
		color: var(--accent);
		background: var(--accent-tint);
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-sm);
		padding: 1px 8px;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.btn-mini-continue:hover:not(:disabled) {
		filter: brightness(0.97);
	}

	.btn-mini-continue:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.stop-icon-mini {
		font-size: 8px;
		line-height: 1;
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
		border-radius: 10px 16px 16px 16px;
	}

	.msg-wrap.is-group .msg-segment:not(:first-child) .msg.is-you {
		border-radius: 16px 10px 16px 16px;
	}

	.segment-meta.is-right {
		justify-content: flex-end;
	}

	.segment-tag {
		font-size: 10px;
		font-weight: 700;
		padding: 1.5px 6px;
		border-radius: 4px;
		background: rgba(37, 99, 235, 0.08);
		color: var(--accent);
		border: 1px solid rgba(37, 99, 235, 0.18);
		letter-spacing: 0.02em;
		line-height: 1.2;
	}

	/* Message Cards */
	.msg {
		position: relative;
		width: fit-content;
		max-width: 100%;
		padding: 10px 14px;
		border-radius: 4px 16px 16px 16px;
		background: var(--bot);
		border: 1px solid var(--bot-border);
		color: var(--bot-text);
		box-shadow: 0 1px 3px rgba(15, 23, 42, 0.03);
		transition: box-shadow 0.15s ease;
		word-break: break-word;
	}

	/* A definite width so the table wrap can scroll instead of shrinking columns. */
	.msg:has(:global(.md-table-wrap)) {
		width: 100%;
	}

	.msg.is-you {
		background: linear-gradient(135deg, #2563eb, #1d4ed8);
		color: #ffffff;
		border: 1px solid transparent;
		border-radius: 16px 4px 16px 16px;
		box-shadow: 0 2px 8px rgba(37, 99, 235, 0.18);
	}

	/* Message Toolbar on Hover */
	.msg-toolbar {
		position: absolute;
		top: -14px;
		right: 8px;
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 2px 5px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: 9999px;
		box-shadow: 0 3px 10px rgba(15, 23, 42, 0.08);
		opacity: 0;
		transform: translateY(2px);
		pointer-events: none;
		transition: all 0.15s ease;
		z-index: 10;
	}

	.msg:hover .msg-toolbar,
	.msg-segment:hover .msg-toolbar {
		opacity: 1;
		transform: translateY(0);
		pointer-events: auto;
	}

	.msg-wrap.is-user .msg-toolbar {
		right: auto;
		left: 8px;
	}

	.act-btn {
		padding: 3px 6px;
		color: var(--muted);
		border-radius: 4px;
		display: flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;
		transition: all 0.12s ease;
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
		border-radius: 0 8px 8px 0;
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
		border-radius: 9999px;
		font-size: 12px;
		background: var(--reaction-bg);
		border: 1px solid var(--line);
		box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
		cursor: pointer;
		transition: all 0.15s ease;
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
		font-size: 13.5px;
	}

	/* Streaming Active Turn */
	.msg.is-stream {
		border-left: 3.5px solid var(--accent);
		background: var(--bot);
		box-shadow: var(--shadow-sm);
	}

	.pulse {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--ok);
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
	}

	.msg-attached-replying.is-user {
		align-items: flex-end;
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

	/* Scroll to Bottom Floating Button */
	.scroll-bottom-btn {
		position: absolute;
		bottom: 140px;
		right: 24px;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: var(--input-bg);
		border: 1px solid var(--line);
		box-shadow: var(--shadow-md);
		color: var(--muted);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		pointer-events: auto;
		transition: all 0.18s ease;
		z-index: 10;
	}

	.scroll-bottom-btn:hover {
		color: var(--accent);
		background: var(--line-subtle);
		transform: translateY(-2px);
		box-shadow: 0 6px 18px rgba(15, 23, 42, 0.16);
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
		transition: all 0.15s ease;
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

	/* Ask Card */
	.msg.is-ask {
		background: var(--pane);
		border: 1.5px solid var(--accent);
		max-width: 480px;
		box-shadow: 0 4px 16px var(--accent-glow);
		border-radius: var(--radius-lg);
		padding: 14px 16px;
	}

	.msg.is-ask .who {
		color: var(--accent);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.ask-reply :global(input) {
		flex: 1;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		padding: 7px 11px;
		background: var(--chip);
		font-size: 13px;
		transition: all 0.15s ease;
	}

	.ask-reply :global(input:focus) {
		background: var(--input-bg);
		border-color: var(--accent);
	}

	.ask-reply :global(button) {
		background: var(--accent);
		color: #ffffff;
		border-radius: var(--radius-sm);
		padding: 7px 13px;
		font-weight: 600;
		font-size: 12.5px;
		box-shadow: var(--shadow-xs);
	}

	.ask-reply :global(button:hover) {
		background: var(--accent-hover);
	}

	/* Approval Card */
	.msg.is-approval {
		align-self: stretch;
		max-width: none;
		background: var(--card);
		border: 1.5px solid var(--card-line);
		border-radius: var(--radius-lg);
		padding: 16px 18px;
		box-shadow: 0 4px 14px rgba(217, 119, 6, 0.08);
	}

	.msg.is-approval .who {
		color: var(--warn-text);
		font-size: 11.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
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
		color: #ffffff;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		padding: 7px 14px;
		font-size: 13px;
		font-weight: 600;
		box-shadow: var(--shadow-xs);
		transition: all 0.15s ease;
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
		background: var(--chip);
		border: 1px dashed var(--line);
		color: var(--muted);
		padding: 8px 12px;
		font-size: 13px;
		border-radius: 4px 16px 16px 16px;
		box-shadow: none;
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
	}

	@media (max-width: 680px) {
	.msg-wrap.is-bot {
	max-width: 100%;
	}
	}
	@media (max-width: 680px) {
	.msg-wrap.is-user {
	max-width: 100%;
	}
	}
	@media (max-width: 680px) {
		.stream-inner {
			padding: 14px 12px 120px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
	.pulse {
	animation: none;
	}
	}
	@media (max-width: 680px) {
		.scroll-bottom-btn {
			bottom: 120px;
			right: 16px;
		}
	}

	@media (max-width: 680px) {
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
		.msg-header .segment-count-badge,
		.msg-header .duration-badge,
		.msg-header .msg-time,
		.msg-header .streaming-status {
			flex-shrink: 0;
		}

		.msg-header .msg-time {
			margin-left: auto;
		}

		/* Long-press opens the same copy and reply actions, so the hover pill has no job here —
		   and it used to sit on top of the line above the bubble. */
		.msg-toolbar {
			display: none;
		}

		/* Your own portrait next to a name that already says 你 costs 42px of every line. */
		.msg-wrap.is-user .avatar-col {
			display: none;
		}

		.msg {
			padding: 9px 12px;
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
