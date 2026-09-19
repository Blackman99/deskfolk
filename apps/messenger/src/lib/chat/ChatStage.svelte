<script lang="ts">
	import { tick } from 'svelte';
	import { USER_MEMBER, type Attachment, type Bot, type Message, type SessionSummary } from '@real-bot/protocol';
	import Composer from './Composer.svelte';
	import MessageAttachments from './MessageAttachments.svelte';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import SessionAvatar from '../SessionAvatar.svelte';
	import {
		approvalForMessage,
		approvalNeedsSecret,
		approvalSecretRequired,
		canAlwaysAllow,
		isHttpMcpApproval
	} from './approval-card.ts';
	import { avatarSrc } from '../avatar.ts';
	import {
		botAvatarColor,
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
	import { markdownCode } from './code-blocks.ts';
	import { composerLocked } from './composer-mode.ts';
	import { copyText } from '../clipboard.ts';
	import type { Copy } from '../copy.ts';
	import { presentBotIds } from '../panels/group-edit.ts';
	import { renderMarkdown } from '../markdown.ts';
	import { parseMentionHref } from './mention-chips.ts';
	import { canQuoteReply, draftWithQuoteMention, quotePreview, quotedBotName } from './quote-reply.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { classifySession, youBotPeer } from '../sidebar/session-groups.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import { getStarterOptions } from './starter-prompts.ts';
	import { distanceFromBottom, isNearBottom, maxScrollTop, stickAfterScroll } from './stream-scroll.ts';
	import { composeTranscript, isLiveStatus, isPendingAsk, transcriptItemKey } from './transcript.ts';
	import { parseArtifactHref } from '../overlays/artifacts.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		selected: SessionSummary | null;
		onOpenProfile: (botId: string) => void;
		onOpenArtifact: (relpath: string, att?: Attachment) => void;
		onCreateBot: () => void;
	};

	let { runtime, t, selected, onOpenProfile, onOpenArtifact, onCreateBot }: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	const connected = $derived(runtime.connection === 'connected');
	const selectedKind = $derived(selected ? classifySession(selected) : null);
	const selectedPeer = $derived(selected ? youBotPeer(selected) : null);
	const selectedPeerBot = $derived(selectedPeer ? (botsById.get(selectedPeer) ?? null) : null);
	const sessionSettingsLabel = $derived(
		selectedKind === 'group' ? t.top.groupSettings : t.top.botSettings
	);
	const lockedComposer = $derived(composerLocked(selected, botsById));
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived });
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

	const groupedStream = $derived(groupTranscript(stream));

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

	let askDrafts = $state<Record<string, string>>({});

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

	function markdownOpts(message?: Message, extra?: { streaming?: boolean }) {
		const session = message ? snapshot.sessions.find((s) => s.id === message.session_id) : undefined;
		const mentionMembers = session
			? presentBotIds(session)
					.map((id) => botsById.get(id))
					.filter((b): b is Bot => Boolean(b))
			: snapshot.bots;
		return {
			streaming: extra?.streaming,
			extraPaths: message?.attachments.map((att) => att.workspace_relpath) ?? [],
			mentionBots: snapshot.bots,
			mentionMembers,
			unresolvedMentionTitle: t.stream.mentionUnresolved
		};
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

	function markdownLinks(node: HTMLElement) {
		node.addEventListener('click', onMarkdownClick);
		const code = markdownCode(node, { copy: t.chat.copyCode, copied: t.chat.copied });
		return {
			update() {
				code.update({ copy: t.chat.copyCode, copied: t.chat.copied });
			},
			destroy() {
				node.removeEventListener('click', onMarkdownClick);
				code.destroy();
			}
		};
	}

	function onMarkdownClick(ev: MouseEvent): void {
		const target = ev.target;
		if (!(target instanceof Element)) return;
		const a = target.closest('a');
		if (!(a instanceof HTMLAnchorElement)) return;
		ev.preventDefault();
		const raw = a.getAttribute('href') ?? a.href;
		const botId = parseMentionHref(raw);
		if (botId && botId !== 'everyone') {
			onOpenProfile(botId);
			return;
		}
		const artifact = parseArtifactHref(raw);
		if (artifact) {
			onOpenArtifact(artifact);
			return;
		}
		const href = a.href;
		if (
			href.startsWith('https:') ||
			href.startsWith('http:') ||
			href.startsWith('mailto:')
		) {
			window.open(href, '_blank', 'noopener,noreferrer');
		}
	}

	async function replyAsk(askId: string): Promise<void> {
		const body = (askDrafts[askId] ?? '').trim();
		if (!body) return;
		stickToBottom = true;
		await runtime.sendAsk(askId, body);
		const next = { ...askDrafts };
		delete next[askId];
		askDrafts = next;
		await tick();
		scrollToBottom(false);
	}

	function approvalStatusCopy(status: 'allowed_once' | 'denied' | 'voided' | 'pending'): string {
		if (status === 'allowed_once') return t.stream.allowed;
		if (status === 'denied') return t.stream.denied;
		if (status === 'voided') return t.stream.voided;
		return t.stream.approval;
	}
</script>

<div class="stream-stage">
	<div class="stream" bind:this={streamContainer} onscroll={onStreamScroll} onscrollend={onStreamScrollEnd}>
		<div class="stream-inner" bind:this={streamInner}>
	{#if !selected}
		<div class="empty-state">
			<div class="empty-icon" aria-hidden="true">
				<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
				</svg>
			</div>
			<h2>{t.top.pickSession}</h2>
			<p class="muted">{t.top.pickSession}</p>
		</div>
	{:else if stream.length === 0}
		<div class="empty-chat-welcome">
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
				<div class="welcome-badges">
					<span class="bot-badge">{t.chat.botBadge}</span>
					{#if selectedPeerBot.model}
						<span class="model-badge mono">{selectedPeerBot.model}</span>
					{/if}
				</div>
				{#if selectedPeerBot.duties}
					<div class="welcome-duties">
						<p class="duties-text">{selectedPeerBot.duties}</p>
					</div>
				{/if}
				{#if starterOptions.length > 0}
					<div class="welcome-starters">
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
		{#each groupedStream as group, gIdx (group.id)}
			{@const groupDate = group.created_at}
			{@const prevGroup = gIdx > 0 ? groupedStream[gIdx - 1] : null}
			{@const prevDate = prevGroup ? prevGroup.created_at : null}
			{#if !prevDate || isDifferentDay(prevDate, groupDate)}
				<div class="date-divider">
					<span class="date-pill">{formatDateDivider(groupDate, locale)}</span>
				</div>
			{/if}

			{#if group.kind === 'replying'}
				{@const block = group.items[0]}
				{#if block.type === 'replying'}
					<div class="replying-list" aria-live="polite">
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
					<div
						class="msg-wrap is-bot"
						data-message-id={singleMsg.message.id}
						class:is-search-hit={runtime.highlightedMessageId === singleMsg.message.id}
					>
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
								{#if isPendingAsk(singleMsg.message, snapshot.turns)}
									<div class="ask-reply">
										<input
											type="text"
											placeholder={t.stream.reply}
											value={askDrafts[singleMsg.message.id] ?? ''}
											oninput={(ev) =>
												(askDrafts = {
													...askDrafts,
													[singleMsg.message.id]: (ev.currentTarget as HTMLInputElement).value
												})}
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
								<div class="approval-acts">
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
					<div
						class="msg-wrap is-bot is-system-row"
						data-message-id={singleMsg.message.id}
						class:is-search-hit={runtime.highlightedMessageId === singleMsg.message.id}
					>
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
							<div class="msg-interrupt-row">
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
						<div class="msg-segments is-user-segments">
							{#each group.items as item (transcriptItemKey(item))}
								{#if item.type === 'message'}
									{@const rxGroups = groupReactions(item.message.reactions, USER_MEMBER)}
									<div
										class="msg-segment is-user-segment"
										data-message-id={item.message.id}
										class:is-search-hit={runtime.highlightedMessageId === item.message.id}
									>
										{#if isMulti}
											<div class="segment-meta is-right">
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
														<span class="copied-badge">✓ {t.chat.copied}</span>
													{:else}
														<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
													{/if}
												</button>
											</div>
											{#if item.message.parent_id}
												{@const quoted = snapshot.messages.find((m) => m.id === item.message.parent_id)}
												<button
													type="button"
													class="quote-ref"
													onclick={() => quoted && runtime.setHighlightedMessage(quoted.id)}
												>
													<span class="quote-ref-who">{quoted ? who(quoted) : t.top.deleted}</span>
													<span class="quote-ref-body">{quotePreview(quoted?.body ?? '')}</span>
												</button>
											{/if}
											<div class="body is-md" use:markdownLinks>{@html renderMarkdown(item.message.body, markdownOpts(item.message))}</div>
											{#if item.message.attachments && item.message.attachments.length > 0}
												<MessageAttachments
													attachments={item.message.attachments}
													api={runtime.client}
													{t}
													onPreview={(att) => onOpenArtifact(att.workspace_relpath, att)}
												/>
											{/if}
										</article>
										{#if rxGroups.length > 0}
											<div class="rx-row is-right">
												{#each rxGroups as rx}
													<button
														type="button"
														class="rx-chip"
														class:is-active={rx.userReacted}
														onclick={() => void runtime.toggleReaction(item.message.id, rx.emoji)}
													>
														<span class="rx-emoji">{rx.emoji}</span>
														<span class="rx-count mono">{rx.count}</span>
													</button>
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
									</div>
								{/if}
							{/each}
						</div>
					</div>
					<div class="avatar-col">
						<div class="user-avatar" title={t.common.you}>
							{rosterLetter(t.common.you)}
						</div>
					</div>
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
									<span class="streaming-status">
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
									{@const duration = calculateBotDuration(single.message, snapshot.messages, snapshot.turns)}
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

						<div class="msg-segments">
							{#each group.items as item, sIdx (transcriptItemKey(item))}
								<div
									class="msg-segment"
									class:is-streaming={item.type === 'streaming'}
									data-message-id={item.type === 'message' ? item.message.id : undefined}
									class:is-search-hit={item.type === 'message' &&
										runtime.highlightedMessageId === item.message.id}
								>
									{#if isMulti}
										<div class="segment-meta">
											<span class="segment-tag">{t.chat.segmentPart(sIdx + 1)}</span>
											{#if item.type === 'streaming'}
												{@const liveElapsed = formatLiveDuration(item.turn.created_at, nowMs)}
												<span class="streaming-status">
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
												{@const duration = calculateBotDuration(item.message, snapshot.messages, snapshot.turns)}
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
											<div class="body is-md" use:markdownLinks>
												{@html renderMarkdown(item.turn.partial_text ?? '', markdownOpts(undefined, { streaming: true }))}
												<span class="streaming-cursor"></span>
											</div>
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
														<span class="copied-badge">✓ {t.chat.copied}</span>
													{:else}
														<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
													{/if}
												</button>
											</div>
											{#if item.message.parent_id}
												{@const quoted = snapshot.messages.find((m) => m.id === item.message.parent_id)}
												<button
													type="button"
													class="quote-ref"
													onclick={() => quoted && runtime.setHighlightedMessage(quoted.id)}
												>
													<span class="quote-ref-who">{quoted ? who(quoted) : t.top.deleted}</span>
													<span class="quote-ref-body">{quotePreview(quoted?.body ?? '')}</span>
												</button>
											{/if}
											<div class="body is-md" use:markdownLinks>{@html renderMarkdown(item.message.body, markdownOpts(item.message))}</div>
											{#if item.message.attachments && item.message.attachments.length > 0}
												<MessageAttachments
													attachments={item.message.attachments}
													api={runtime.client}
													{t}
													onPreview={(att) => onOpenArtifact(att.workspace_relpath, att)}
												/>
											{/if}
										</article>
										{#if rxGroups.length > 0}
											<div class="rx-row">
												{#each rxGroups as rx}
													<button
														type="button"
														class="rx-chip"
														class:is-active={rx.userReacted}
														onclick={() => void runtime.toggleReaction(item.message.id, rx.emoji)}
													>
														<span class="rx-emoji">{rx.emoji}</span>
														<span class="rx-count mono">{rx.count}</span>
													</button>
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
</div>
