<script lang="ts">
	/** A Bot's question for you in the transcript: its card, with the answer form. */
	import AskCard from './AskCard.svelte';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import { formatFullTimestamp, formatMessageTime, type TranscriptGroup } from './chat-view.ts';
	import type { Copy } from '../copy.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { isPendingAsk } from './transcript.ts';
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
	{@const askBot = stage.botsById.get(singleMsg.message.author)}
	{@const pal = botAvatarColor(singleMsg.message.author)}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="msg-wrap is-bot"
		data-message-id={singleMsg.message.id}
		class:is-search-hit={stage.highlightedId === singleMsg.message.id}
		class:is-selected={stage.selectedMessageId === singleMsg.message.id}
		onmousedown={stage.handleMessageMouseDown}
		ontouchstart={stage.handleMessageTouchStart}
		oncontextmenu={(e) => stage.handleMessageContextMenu(e, singleMsg.message)}
	>
		<div class="avatar-col">
			{#if askBot}
				<button
					type="button"
					class="bot-avatar is-clickable"
					style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
					title={t.top.botSettings}
					onclick={() => stage.onOpenProfile(askBot.id)}
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
						onclick={() => stage.onOpenProfile(askBot.id)}
						title={t.top.botSettings}
					>
						{stage.who(singleMsg.message)}
					</button>
				{:else}
					<span class="sender-name">{stage.who(singleMsg.message)}</span>
				{/if}
				<span class="ask-badge">?</span>
				<span class="msg-time mono" title={formatFullTimestamp(singleMsg.message.created_at)}>
					{formatMessageTime(singleMsg.message.created_at)}
				</span>
			</div>
			<article class="msg is-ask">
				<div class="who">{t.stream.ask} · {stage.who(singleMsg.message)}</div>
				<div class="body">{singleMsg.message.body}</div>
				<AskCard
					message={singleMsg.message}
					answerable={isPendingAsk(singleMsg.message, stage.snapshot.turns, runtime.notificationCapabilities.pending_ask_v1) && !stage.lockedComposer}
					draft={runtime.getAskDraft(singleMsg.message.id)}
					sending={stage.view?.sending ?? false}
					{t}
					onDraft={(body) => runtime.setAskDraft(singleMsg.message.id, body)}
					onSelect={(picks) => runtime.setAskSelection(singleMsg.message.id, picks)}
					onSubmit={() => void stage.replyAsk(singleMsg.message.id)}
				/>
			</article>
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

	/*
	 * Kept visible on the cards that need a speaker line. `.stream-inner > .msg .who` was here
	 * too and never matched — messages sit inside a group wrapper, never directly under
	 * `.stream-inner`. Scoping the sheet is what finally said so.
	 */
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

	.msg :global(.body) {
		white-space: pre-wrap;
		line-height: 1.55;
		font-size: 14px;
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
