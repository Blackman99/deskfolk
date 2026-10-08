<script lang="ts">
	/** Your lines in the transcript, one bubble or a run of them, with what hangs under each. */
	import type { Message } from '@real-bot/protocol';
	import MessageAttachments from './MessageAttachments.svelte';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import BotDmEntry from './BotDmEntry.svelte';
	import ControlActions from './ControlActions.svelte';
	import MessageAttribution from './MessageAttribution.svelte';
	import AnnotationCards from '../annotations/AnnotationCards.svelte';
	import MessageEditor from './MessageEditor.svelte';
	import QuoteRef from './QuoteRef.svelte';
	import ReactionRow from './ReactionRow.svelte';
	import { formatFullTimestamp, formatMessageTime, type TranscriptGroup } from './chat-view.ts';
	import type { Copy } from '../copy.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import { canQuoteReply } from './quote-reply.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
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
					<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="msg-segment is-user-segment flex flex-col relative w-fit max-w-full"
						data-message-id={item.message.id}
						class:is-search-hit={stage.highlightedId === item.message.id}
						class:is-selected={stage.selectedMessageId === item.message.id}
						onmousedown={stage.handleMessageMouseDown}
						ontouchstart={stage.handleMessageTouchStart}
						oncontextmenu={(e) => stage.handleMessageContextMenu(e, item.message)}
					>
						{#if isMulti}
							<div class="segment-meta is-right flex items-center gap-3 mt-[1px] mb-[5px] py-0 px-2 text-11 leading-none">
								<span class="msg-time mono" title={formatFullTimestamp(item.message.created_at)}>
									{formatMessageTime(item.message.created_at)}
								</span>
							</div>
						{/if}
						{#if item.message.withdrawn_at}
							<!-- Taken back before any Bot read it (ADR 0069): the words wait for you, not for a Bot. -->
							<div class="msg-withdrawn">
								<span>{t.chat.lineWithdrawn}</span>
								{#if !stage.lockedComposer}
									<button type="button" class="msg-line-btn" onclick={() => stage.reEditLine(item.message)}>{t.chat.reEditLine}</button>
								{/if}
							</div>
						{:else}
							<article class="msg is-you" class:is-editing={stage.editingHere(item.message)}>
								<div class="who">{stage.who(item.message)}</div>
								<div class="msg-toolbar">
									<div class="msg-toolbar-pill">
										{#if canQuoteReply(item.message) && !stage.lockedComposer}
											<button
												type="button"
												class="act-btn"
												title={t.chat.replyMessage}
												onclick={() => stage.startQuoteReply(item.message)}
											>
												<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
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
												<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
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
												<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
											{/if}
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
							{@render queuedRow(item.message)}
							{#if item.message.edited_at}
								<!-- Under the bubble, where what it said before opens: the hover bar above it would cover a mark by the time. -->
								<div class="msg-edited-row">{@render editedMark(item.message)}</div>
							{/if}
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
							{#if !stage.fileDrop && !item.message.control && stage.attributionChips.has(item.message.id)}
								<MessageAttribution
									message={item.message} {t}
									plans={runtime.attributionPlans[item.message.session_id] ?? []}
									disabled={!stage.connected || stage.lockedComposer}
									onOpen={() => { stage.attributionEditId = item.message.id; }}
								/>
							{/if}
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
							{#if stage.botDmIndex.get(item.message.id)}
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
					</div>
				{/if}
			{/each}
		</div>
	</div>
	{#if stage.showOwnAvatar}
		<div class="avatar-col">
			<div class="user-avatar" title={t.common.you}>
				{rosterLetter(t.common.you)}
			</div>
		</div>
	{/if}
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

	.msg-wrap.is-user {
		max-width: 80%;
		align-self: flex-end;
		justify-content: flex-end;
	}

	.avatar-col {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
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
	}

	.msg-wrap.is-group .msg-segment:not(:first-child) {
		margin-top: 4px;
		padding-top: 8px;
		border-top: 1px dashed var(--line-subtle);
	}

	.msg-wrap.is-group .msg-segment:not(:first-child) .msg.is-you {
		border-radius: var(--radius-lg) var(--radius-md) var(--radius-lg) var(--radius-lg);
	}

	.segment-meta.is-right {
		justify-content: flex-end;
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
		.msg-wrap.is-user {
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

		.sender-name {
			min-width: 0;
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
		}

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
</style>
