<script lang="ts">
	/** A line from the app or about a turn (a stop, a failure, a hand-over's card) in the transcript. */
	import MessageAttachments from './MessageAttachments.svelte';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import WorkQuestionCard from './WorkQuestionCard.svelte';
	import ControlActions from './ControlActions.svelte';
	import BrandMark from '../BrandMark.svelte';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import {
		canContinueInterrupt,
		formatFullTimestamp,
		formatMessageTime,
		isAppLine,
		isInterruptNote,
		isUnreachableNote,
		type TranscriptGroup
	} from './chat-view.ts';
	import type { Copy } from '../copy.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { TranscriptStage } from './transcript-stage.ts';

	type Props = {
		group: TranscriptGroup;
		t: Copy;
		runtime: MessengerRuntime;
		stage: TranscriptStage;
	};

	let { group, t, runtime, stage }: Props = $props();

	const singleMsg = $derived(group.items[0]);
</script>

{#if singleMsg.type === 'message'}
	{@const sysBot = stage.botsById.get(singleMsg.message.author)}
	{@const pal = botAvatarColor(singleMsg.message.author)}
	{@const showContinue = singleMsg.message.control?.kind !== 'work_question' && canContinueInterrupt(singleMsg.message, stage.snapshot.turns, {
		locked: stage.lockedComposer,
		readOnly: stage.selectedKind === 'bot-bot',
		hasLiveTurnForBot: stage.liveTurnsHere.some((turn) => turn.bot_id === singleMsg.message.author),
		announced: stage.announced
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
		class:is-search-hit={stage.highlightedId === singleMsg.message.id}
		class:is-selected={stage.selectedMessageId === singleMsg.message.id}
		onmousedown={stage.handleMessageMouseDown}
		ontouchstart={stage.handleMessageTouchStart}
		oncontextmenu={(e) => stage.handleMessageContextMenu(e, singleMsg.message)}
	>
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
					onclick={() => stage.onOpenProfile(sysBot.id)}
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
				{#if appLine}
					<span class="sender-name">{t.chat.appName}</span>
					<span class="app-badge">{t.chat.appBadge}</span>
				{:else if sysBot}
					<button
						type="button"
						class="sender-name is-clickable"
						onclick={() => stage.onOpenProfile(sysBot.id)}
						title={t.top.botSettings}
					>
						{stage.who(singleMsg.message)}
					</button>
				{:else}
					<span class="sender-name">{stage.who(singleMsg.message)}</span>
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
				<div class="who">{appLine ? t.chat.appName : stage.who(singleMsg.message)}</div>
				{#if singleMsg.message.control?.kind === 'work_question'}
					{@const question = singleMsg.message.control}
					{@const plan = runtime.attributionPlans[singleMsg.message.session_id]?.find((row) => row.id === question.task_id)}
					<WorkQuestionCard
						control={question}
						botName={sysBot?.name ?? singleMsg.message.author}
						planName={plan?.title ?? question.task_id}
						ticketName={question.ticket_id ? (plan?.tickets.find((row) => row.id === question.ticket_id)?.title ?? question.ticket_id) : null}
						{t}
						disabled={!stage.connected || stage.lockedComposer}
						readOnly={stage.selectedKind === 'bot-bot' || Boolean(stage.selected?.archived_at)}
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
				{#if stage.messageShowsAttachments(singleMsg.message)}
					<MessageAttachments
						attachments={singleMsg.message.attachments}
						body={singleMsg.message.body}
						api={runtime.client}
						{t}
						onPreview={(att) => stage.onOpenArtifact(att.workspace_relpath, att, singleMsg.message.id)}
						onOpenImage={(att, from) => stage.openInlineImage(att, att.workspace_relpath, from)}
						onOpenFile={appLine ? (att) => stage.openInlineFile(att, singleMsg.message.id) : undefined}
						cards={appLine}
					/>
				{/if}
				{#if singleMsg.message.control}
					<ControlActions
						control={singleMsg.message.control}
						holds={stage.snapshot.holds}
						botName={stage.botNameOf}
						{t}
						disabled={!stage.connected}
						onAct={(action, taskId, note) => stage.pressControl(singleMsg.message, action, taskId, note)}
					/>
				{/if}
				{/if}
				{#if showContinue}
					<div class="system-msg-actions">
						<button
							type="button"
							class="btn-continue-turn"
							title={continueHint}
							disabled={!stage.connected || stage.view?.sending}
							onmousedown={(e) => e.stopPropagation()}
							onclick={() => void runtime.continueInterrupt(singleMsg.message.id, stage.selected?.id)}
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
						botsById={stage.botsById}
						isUser={false}
						thinkingText={stage.statusLabels.running}
						deletedText={t.top.deleted}
						onOpenProfile={stage.onOpenProfile}
					/>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
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

	.msg-time {
		font-size: 11px;
		color: var(--muted);
		margin-left: 2px;
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

	/* Hide duplicate .who when .msg-header is available */
	.msg-wrap .msg .who {
		display: none;
	}

	.msg .who {
		font-size: 11px;
		font-weight: 700;
		margin-bottom: 4px;
		letter-spacing: 0.03em;
		color: var(--muted);
	}

	.msg :global(.body) {
		white-space: pre-wrap;
		line-height: 1.55;
		font-size: 14px;
	}

	.msg-attached-replying {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 5px;
		/* The line names a path or a command: it clips inside the message's width, never past it. */
		max-width: 100%;
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

	.msg-wrap.is-selected {
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		box-shadow: 0 0 0 2px var(--accent-border);
		transition: background 0.15s ease, box-shadow 0.15s ease;
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
		.msg,
		.msg :global(*) {
			-webkit-touch-callout: none;
			-webkit-user-select: none;
			user-select: none;
		}
	}

	/*
	 * The phone layout follows the conversation's width (the `conversation` container), so a
	 * workbench pane narrower than a phone gets it in a wide window too. What only a touch screen
	 * needs — no text selection on long-press, no hover pill — still asks the window.
	 */
	@container conversation (max-width: 680px) {
		.msg-wrap.is-bot {
			max-width: 100%;
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

		.msg-header .bot-badge,
		.msg-header .app-badge,
		.msg-header .msg-time {
			flex-shrink: 0;
		}

		.msg-header .msg-time {
			margin-left: auto;
		}

		.msg {
			padding: 9px 12px;
		}
	}
</style>
