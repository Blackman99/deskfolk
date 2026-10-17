<script lang="ts">
	/** Your lines in the transcript, one bubble or a run of them, with what hangs under each. */
	import type { Message } from '@real-bot/protocol';
	import MessageAttachments from './MessageAttachments.svelte';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import BotDmEntry from './BotDmEntry.svelte';
	import ControlActions from './ControlActions.svelte';
	import AnnotationCards from '../annotations/AnnotationCards.svelte';
	import MessageEditor from './MessageEditor.svelte';
	import QuoteRef from './QuoteRef.svelte';
	import ReactionRow from './ReactionRow.svelte';
	import Icon from '../Icon.svelte';
	import { QUICK_REACTIONS } from './quick-reactions.ts';
	import { formatFullTimestamp, formatMessageTime, type TranscriptGroup } from './chat-view.ts';
	import type { Copy } from '../copy.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import { canQuoteReply } from './quote-reply.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { transcriptItemKey } from './transcript.ts';
	import type { TranscriptStage } from './transcript-stage.ts';

	type Props = {
		group: TranscriptGroup;
		t: Copy;
		runtime: MessengerRuntime;
		stage: TranscriptStage;
	};

	let { group, t, runtime, stage }: Props = $props();

	const isMulti = $derived(group.items.length > 1);
</script>

{#snippet editedMark(message: Message)}
	<button
		type="button"
		class="msg-edited"
		aria-expanded={stage.versionsShown[message.id]?.at === (message.edited_at ?? '')}
		title={t.chat.editedAt(formatFullTimestamp(message.edited_at ?? message.created_at))}
		onclick={() => void stage.toggleVersions(message)}
	>{t.chat.edited}</button>
{/snippet}

{#snippet foot(message: Message)}
	<!--
		Under the bubble, as under a Bot's line: when you sent it, then 「已编辑」 where what it said before
		opens. Focus mode keeps only 「已编辑」: it says the words changed.
	-->
	{@const edited = Boolean(message.edited_at && !message.withdrawn_at)}
	{#if !stage.focus || edited}
		<div class="msg-foot">
			{#if !stage.focus}
				<span class="msg-time mono" title={formatFullTimestamp(message.created_at)}>{formatMessageTime(message.created_at)}</span>
			{/if}
			{#if edited}
				{#if !stage.focus}<span class="msg-foot-sep" aria-hidden="true">·</span>{/if}
				{@render editedMark(message)}
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet queuedRow(message: Message)}
	<!-- Still unread (ADR 0069): where it waits, and what you can do about it before a Bot reads it. -->
	{@const queued = stage.queuedLine(message)}
	{#if queued}
		<div class="msg-queued-row" data-wait={queued.wait}>
			<span class="msg-queued-state">
				{queued.wait === 'held' ? t.chat.queuedHeld : queued.wait === 'next_step' ? t.chat.queuedNextStep : t.chat.queuedItsTurn}
			</span>
			{#if queued.canInsert}
				<button
					type="button"
					class="msg-line-btn"
					title={stage.insertTitle(message)}
					disabled={stage.lineBusy(message)}
					onclick={() => stage.insertLine(message)}
				>{t.chat.insertNow}</button>
			{/if}
			{#if queued.canWithdraw}
				<button
					type="button"
					class="msg-line-btn"
					title={t.chat.withdrawLineTitle}
					disabled={stage.lineBusy(message)}
					onclick={() => void stage.withdrawLine(message)}
				>{t.chat.withdrawLine}</button>
			{/if}
		</div>
	{/if}
	{#if stage.lineNoteText(message)}
		<div class="msg-line-note" role="status">{stage.lineNoteText(message)}</div>
	{/if}
{/snippet}

<div class="msg-wrap is-user" class:is-group={isMulti}>
	<div class="msg-content">
		{#if isMulti && !stage.focus}
			<div class="msg-header is-right">
				<span class="segment-count-badge mono">{t.chat.messageCount(group.items.length)}</span>
			</div>
		{/if}
		<div class="msg-segments is-user-segments flex flex-col gap-4 w-full">
			{#each group.items as item (transcriptItemKey(item))}
				{#if item.type === 'message'}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="msg-segment is-user-segment flex flex-col relative w-fit"
						data-message-id={item.message.id}
						class:is-search-hit={stage.highlightedId === item.message.id}
						class:is-arriving={stage.arriving.has(transcriptItemKey(item))}
						class:is-selected={stage.selectedMessageId === item.message.id}
						onmousedown={stage.handleMessageMouseDown}
						ontouchstart={stage.handleMessageTouchStart}
						oncontextmenu={(e) => stage.handleMessageContextMenu(e, item.message)}
					>
						{#if item.message.withdrawn_at}
							<!-- Taken back before any Bot read it (ADR 0069): the words wait for you, not for a Bot. -->
							<div class="msg-withdrawn">
								<span>{t.chat.lineWithdrawn}</span>
								{#if !stage.lockedComposer}
									<button type="button" class="msg-line-btn" onclick={() => stage.reEditLine(item.message)}>{t.chat.reEditLine}</button>
								{/if}
							</div>
							{@render foot(item.message)}
						{:else}
							<article class="msg is-you" class:is-editing={stage.editingHere(item.message)}>
								<div class="who">{stage.who(item.message)}</div>
								<div class="msg-toolbar">
									<div class="msg-toolbar-pill">
										{#if !stage.lockedComposer}
											{#each QUICK_REACTIONS as emoji (emoji)}
												<button
													type="button"
													class="act-react"
													title={emoji}
													aria-label={t.chat.reactWith(emoji)}
													onclick={() => void runtime.toggleReaction(item.message.id, emoji)}
												>{emoji}</button>
											{/each}
											<span class="act-sep" aria-hidden="true"></span>
										{/if}
										{#if canQuoteReply(item.message) && !stage.lockedComposer}
											<button
												type="button"
												class="act-btn"
												title={t.chat.replyMessage}
												onclick={() => stage.startQuoteReply(item.message)}
											>
												<Icon name="reply" />
											</button>
										{/if}
										{#if stage.editable(item.message)}
											<button
												type="button"
												class="act-btn"
												title={t.chat.editMessage}
												aria-label={t.chat.editThisLine}
												onclick={() => stage.startEdit(item.message)}
											>
												<Icon name="edit" />
											</button>
										{/if}
										<button
											type="button"
											class="act-btn"
											class:is-copied={stage.copiedMessageId === item.message.id}
											title={t.chat.copyMessage}
											onclick={(e) => stage.copyMessageBody(item.message.id, item.message.body, e)}
										>
											{#if stage.copiedMessageId === item.message.id}
												<span class="copied-badge text-11 font-semibold text-ok">✓ {t.chat.copied}</span>
											{:else}
												<Icon name="copy" />
											{/if}
										</button>
										<button
											type="button"
											class="act-more"
											title={t.chat.moreActions}
											aria-label={t.chat.moreActions}
											onclick={(e) => stage.handleMessageContextMenu(e, item.message)}
										>
											<Icon name="more" />
										</button>
									</div>
								</div>
								<QuoteRef message={item.message} {t} {runtime} selected={stage.selected} messageLookup={stage.messageLookup} who={stage.who} />
								{#if stage.editingHere(item.message) && stage.view && stage.selected}
									{@const editingIn = stage.selected.id}
									<MessageEditor
										{t}
										value={stage.view.editDraft}
										saving={stage.view.editSaving}
										error={stage.editErrorText}
										onInput={(value) => {
											if (stage.view) {
												stage.view.editDraft = value;
												stage.view.editError = null;
											}
										}}
										onSave={() => void runtime.saveEdit(editingIn)}
										onCancel={() => runtime.cancelEdit(editingIn)}
									/>
								{:else}
									<MarkdownBody
										source={stage.messageBody(item.message)}
										options={stage.markdownOpts(item.message)}
										copyLabel={t.chat.copyCode}
										copiedLabel={t.chat.copied}
										inverted
										onOpenArtifact={(path) => stage.onOpenArtifact(path, undefined, item.message.id)}
										onOpenImage={(path, from) => stage.openBodyImage(item.message, path, from)}
										loadArtifactImage={stage.loadBodyImage}
										onOpenProfile={stage.onOpenProfile}
									/>
								{/if}
								{#if stage.messageShowsAttachments(item.message)}
									<MessageAttachments
										attachments={item.message.attachments}
										body={item.message.body}
										api={runtime.client}
										{t}
										onPreview={(att) => stage.onOpenArtifact(att.workspace_relpath, att, item.message.id)}
										onOpenImage={(att, from) => stage.openInlineImage(att, att.workspace_relpath, from)}
									/>
								{/if}
								{#if stage.annotationIndex.get(item.message.id)}
									<AnnotationCards
										annotations={stage.annotationIndex.get(item.message.id) ?? []}
										{t}
										locale={stage.locale}
										bots={stage.botsById}
										onOpen={stage.openAnnotation}
										onToggleStatus={stage.lockedComposer ? undefined : (row, status) => void stage.toggleAnnotation(item.message.id, row, status)}
										error={stage.cardErrors[item.message.id] ?? null}
										sourceLabel={stage.annotationSourceLabel(item.message)}
										onOpenSource={() => stage.openAnnotationSource(item.message)}
									/>
								{/if}
							</article>
							{@render foot(item.message)}
							{@render queuedRow(item.message)}
							{#if stage.versionsShown[item.message.id] && stage.versionsShown[item.message.id]!.at === (item.message.edited_at ?? '')}
								{@const shown = stage.versionsShown[item.message.id]!}
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
							<!-- What the reader made of your line — let work through (`passed`) or sent it back (`rework`) — is not said under it (2026-10-14): the job's flow shows it. -->
							{#if item.message.control?.kind === 'possible_control' && !stage.lockedComposer}
								<ControlActions
									control={item.message.control}
									holds={stage.snapshot.holds}
									botName={stage.botNameOf}
									{t}
									align="end"
									disabled={!stage.connected}
									onAct={(action, taskId) => runtime.controlAction(item.message.id, action, taskId)}
								/>
							{/if}
							<ReactionRow message={item.message} right lockedComposer={stage.lockedComposer} {runtime} />
							{#if item.replying && item.replying.length > 0}
								<div class="msg-attached-replying is-user" aria-live="polite">
									<ReplyingIndicator
										entries={item.replying}
										botsById={stage.botsById}
										isUser={true}
										thinkingText={stage.statusLabels.running}
										deletedText={t.top.deleted}
										onOpenProfile={stage.onOpenProfile}
									/>
								</div>
							{/if}
						{/if}
					</div>
					{#if !item.message.withdrawn_at && !stage.focus && stage.botDmIndex.get(item.message.id)}
						<!-- Outside the bubble's column, across the whole conversation, so it centres there and not under your words. -->
						<div class="msg-attached-botdm is-user">
							<BotDmEntry
								sessions={stage.botDmIndex.get(item.message.id) ?? []}
								botsById={stage.botsById}
								turns={stage.snapshot.turns}
								approvals={stage.snapshot.approvals}
								pendingJudgements={stage.snapshot.pendingJudgements}
								isUser={true}
								statusLabels={stage.statusLabels}
								rosterLabels={stage.rosterLabels}
								openedText={t.chat.botDmOpened}
								onOpen={(id) => void runtime.selectSession(id)}
								traceLabel={item.message.task_id ? t.chat.showTrace : undefined}
								onShowTrace={item.message.task_id
									? () => stage.showMessageTrace(item.message)
									: undefined}
							/>
						</div>
					{/if}
				{/if}
			{/each}
		</div>
	</div>
</div>

<style>
	/* Message Wrappers */
	.msg-wrap {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		width: 100%;
		position: relative;
	}

	/* The run spans the conversation so what hangs under a line can centre in it; your bubbles keep to the right 80%. */
	.msg-wrap.is-user {
		justify-content: flex-end;
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
	}

	/* The time under the bubble, at its right edge, with 「已编辑」 beside it: as quiet as each other. */
	.msg-foot {
		display: flex;
		justify-content: flex-end;
		align-items: baseline;
		gap: 6px;
		margin-top: 4px;
		padding: 0 2px;
		line-height: 1.4;
	}

	.msg-foot-sep {
		font-size: 11px;
		color: var(--muted);
		opacity: 0.6;
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

	/* Still unread (ADR 0069): one quiet line under the bubble, its two actions in the interaction colour. */
	.msg-queued-row {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: baseline;
		gap: 2px 10px;
		margin-top: 3px;
		padding: 0 2px;
		font-size: 11px;
		line-height: 1.4;
		color: var(--muted);
	}

	.msg-line-btn {
		padding: 0;
		border: 0;
		background: none;
		font-size: 11px;
		line-height: inherit;
		color: var(--accent);
		cursor: pointer;
		transition-property: color;
		transition-duration: 0.15s;
	}

	.msg-line-btn:hover:not(:disabled) {
		color: var(--accent-hover);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.msg-line-btn:disabled {
		color: var(--muted);
		cursor: default;
	}

	/* A finger needs more than the words: the same line, a larger target around each. */
	@media (pointer: coarse) {
		.msg-line-btn {
			padding: 10px 4px;
			margin: -10px -4px;
		}
	}

	.msg-line-note {
		margin-top: 2px;
		padding: 0 2px;
		font-size: 11px;
		color: var(--muted);
		text-align: right;
	}

	/* Taken back: no bubble, only what happened and the way back to the words. */
	.msg-withdrawn {
		display: flex;
		align-items: baseline;
		justify-content: flex-end;
		gap: 10px;
		padding: 2px 2px;
		font-size: 12px;
		color: var(--muted);
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

	.msg-segments.is-user-segments {
		align-items: flex-end;
	}

	.msg-segment.is-user-segment {
		align-items: flex-end;
		max-width: 80%;
	}

	.msg-wrap.is-group .msg-segment:not(:first-child) {
		margin-top: 4px;
		padding-top: 8px;
		border-top: 1px dashed var(--line-subtle);
	}

	.msg-wrap.is-group .msg-segment:not(:first-child) .msg.is-you {
		border-radius: var(--radius-lg) var(--radius-md) var(--radius-lg) var(--radius-lg);
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
		/* The corner toward your side is the mark's bubble tail. */
		border-radius: var(--radius-lg) var(--radius-xs) var(--radius-lg) var(--radius-lg);
		box-shadow: var(--shadow-xs);
	}

	/* Message Toolbar on Hover. The strip spans the bubble and the pill sits in its far corner; on a
	   bubble narrower than the pill the strip grows to fit, away from the avatar rather than over it.
	   It stands on the message's top edge rather than over its first line, which it used to cover. */
	.msg-toolbar {
		position: absolute;
		bottom: 100%;
		left: 8px;
		width: calc(100% - 16px);
		min-width: max-content;
		display: flex;
		justify-content: flex-end;
		opacity: 0;
		/* Off the message the pill still answers the pointer while it fades: a pointer heading for it
		   from the words leaves the message on the way, and used to find it gone. */
		visibility: hidden;
		transform: translateY(2px);
		pointer-events: none;
		transition:
			opacity 0.2s ease,
			transform 0.2s ease,
			visibility 0s linear 0.2s;
		z-index: 10;
	}

	.msg-toolbar-pill {
		display: flex;
		align-items: center;
		gap: 1px;
		padding: 2px;
		/* Shrunk to a one-word bubble, "✓ 已复制" used to break after every character. */
		white-space: nowrap;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-md);
		pointer-events: auto;
	}

	.msg:hover .msg-toolbar,
	.msg-segment:hover .msg-toolbar {
		opacity: 1;
		visibility: visible;
		transform: translateY(0);
		transition:
			opacity 0.15s ease,
			transform 0.15s ease,
			visibility 0s;
	}

	/* Without the fade the pill would be gone at once yet still take clicks; it stays whole instead. */
	@media (prefers-reduced-motion: reduce) {
		.msg-toolbar {
			transition:
				opacity 0s 0.2s,
				visibility 0s 0.2s;
		}
	}

	/* Your bubble has room above its words, so the pill steps a little onto it and stays attached. */
	.msg-wrap.is-user .msg-toolbar {
		bottom: calc(100% - 4px);
		left: auto;
		right: 8px;
		justify-content: flex-start;
	}

	.act-btn,
	.act-more,
	.act-react {
		min-width: 24px;
		height: 24px;
		padding: 0 5px;
		color: var(--muted);
		border-radius: 7px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		cursor: pointer;
		transition-duration: var(--dur-fast);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.act-btn:hover,
	.act-more:hover {
		color: var(--ink);
		background: var(--row-hover);
	}

	.act-btn:active,
	.act-more:active {
		transform: scale(0.92);
	}

	/* A quick reaction: the emoji itself, which grows a little under the pointer. */
	.act-react {
		padding: 0;
		font-size: 14px;
		line-height: 1;
	}

	.act-react:hover {
		background: var(--row-hover);
		transform: scale(1.15);
	}

	.act-react:active {
		transform: scale(0.95);
	}

	.act-btn :global(svg) {
		width: 14px;
		height: 14px;
	}

	.act-sep {
		width: 1px;
		height: 14px;
		margin: 0 3px;
		background: var(--line);
	}

	/* The quote itself is QuoteRef's; inside your bubble it takes the bubble's light ink. */
	.msg.is-you :global(.quote-ref) {
		background: rgba(255, 255, 255, 0.14);
		border-left-color: rgba(255, 255, 255, 0.55);
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

	.msg.is-you .who {
		color: rgba(255, 255, 255, 0.8);
	}

	.msg :global(.body) {
		white-space: pre-wrap;
		line-height: 1.55;
		font-size: 14px;
	}

	/* Attached replying / thinking indicator under trigger message */
	.msg-attached-botdm {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 5px;
	}

	.msg-attached-botdm.is-user {
		align-self: stretch;
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

	.msg-segment.is-search-hit {
		scroll-margin-top: 28px;
		scroll-margin-bottom: 28px;
		border-radius: 16px;
		background: var(--accent-tint);
		box-shadow: 0 0 0 2px var(--accent-border);
		animation: search-hit-pulse 1.1s ease-out;
	}

	.msg-segment.is-selected {
		border-radius: 16px;
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
		.msg-segment.is-user-segment {
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

		.msg-header .segment-count-badge {
			flex-shrink: 0;
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

	/* A row that has just arrived rises into place; history and a reply replacing its working bubble do not. */
	.is-arriving {
		animation: msg-arrive var(--dur-slow) var(--ease-out) both;
	}

	@keyframes msg-arrive {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
</style>
