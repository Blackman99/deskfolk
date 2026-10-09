<script lang="ts">
	/** A Bot's replies in the transcript, one or a run of parts, and its working bubble while a turn runs. */
	import MessageAttachments from './MessageAttachments.svelte';
	import ReplyingIndicator from './ReplyingIndicator.svelte';
	import CommandActivity from './CommandActivity.svelte';
	import TurnStepList from './TurnStepList.svelte';
	import { whenVisible } from '../when-visible.ts';
	import type { CommandRow } from './command-activity.ts';
	import BotDmEntry from './BotDmEntry.svelte';
	import MessageAttribution from './MessageAttribution.svelte';
	import AnnotationCards from '../annotations/AnnotationCards.svelte';
	import QuoteRef from './QuoteRef.svelte';
	import ReactionRow from './ReactionRow.svelte';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import {
		calculateBotDuration,
		formatFullTimestamp,
		formatLiveDuration,
		formatMessageTime,
		type TranscriptGroup
	} from './chat-view.ts';
	import type { Copy } from '../copy.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import { canQuoteReply } from './quote-reply.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { transcriptItemKey } from './transcript.ts';
	import { describeStep, stepRow, type StepLine, type StepRow } from './turn-activity.ts';
	import type { TranscriptStage } from './transcript-stage.ts';

	type Props = {
		group: TranscriptGroup;
		t: Copy;
		runtime: MessengerRuntime;
		stage: TranscriptStage;
	};

	let { group, t, runtime, stage }: Props = $props();

	const botAuthor = $derived(stage.botsById.get(group.author));
	const pal = $derived(botAvatarColor(group.author));
	const isMulti = $derived(group.items.length > 1);
	const hasStreaming = $derived(group.items.some((i) => i.type === 'streaming'));

	/** What a working turn is doing, once it has started a step: see turn-activity.ts. */
	function stepLineOf(turnId: string): StepLine | null {
		const step = runtime.stepOf(turnId);
		return step ? describeStep(step, t.chat.activity, stage.nowMs) : null;
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

	/**
	 * What a working bubble's last line opens onto: only what is going on now. What has finished is
	 * in the command card above it, or done with; listing the whole turn there repeated the card.
	 */
	function liveSteps(turnId: string): StepRow[] | null {
		const rows = runtime.stepsOf(turnId).filter((step) => step.running).map((step) => stepRow(step, t.chat.activity, stage.nowMs));
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
		stage.openStepsTurn = stage.openStepsTurn === turnId ? null : turnId;
	}
</script>

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
				onclick={() => stage.onOpenProfile(botAuthor.id)}
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
					onclick={() => stage.onOpenProfile(botAuthor.id)}
					title={t.top.botSettings}
				>
					{botAuthor.name}
				</button>
			{:else}
				<span class="sender-name">{stage.whoAuthor(group.author)}</span>
			{/if}
			<span class="bot-badge">{t.chat.botBadge}</span>
			{#if botAuthor?.model}
				<span class="model-badge mono">{botAuthor.model}</span>
			{/if}
		</div>

		<div class="msg-segments flex flex-col gap-2 w-full">
			{#each group.items as item (transcriptItemKey(item))}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="msg-segment flex flex-col relative w-fit max-w-full"
					class:is-streaming={item.type === 'streaming'}
					data-message-id={item.type === 'message' ? item.message.id : undefined}
					class:is-search-hit={item.type === 'message' &&
						stage.highlightedId === item.message.id}
					class:is-selected={item.type === 'message' && stage.selectedMessageId === item.message.id}
					onmousedown={(e) => {
						if (item.type === 'message') stage.handleMessageMouseDown(e);
					}}
					ontouchstart={() => {
						if (item.type === 'message') stage.handleMessageTouchStart();
					}}
					oncontextmenu={(e) => {
						if (item.type === 'message') stage.handleMessageContextMenu(e, item.message);
					}}
				>
					{#if item.type === 'streaming'}
						{@const step = stepLineOf(item.turn.id)}
						{@const said = Boolean(item.turn.partial_text?.trim())}
						<article class="msg is-stream is-reply">
							<div class="who">{botAuthor?.name ?? t.top.deleted}</div>
							{#if said}
							<MarkdownBody
								source={item.turn.partial_text ?? ''}
								options={stage.markdownOpts(undefined, { streaming: true })}
								copyLabel={t.chat.copyCode}
								copiedLabel={t.chat.copied}
								onOpenArtifact={(path) => stage.onOpenArtifact(path)}
								onOpenImage={(path, from) => stage.openInlineImage(null, path, from)}
								onOpenProfile={stage.onOpenProfile}
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
											aria-expanded={stage.openStepsTurn === item.turn.id}
											aria-controls={`turn-steps-${item.turn.id}`}
											title={`${step.full}\n${t.chat.activity.showSteps}`}
											onclick={() => toggleSteps(item.turn.id)}
										><span class="toggle-label">{step.text}</span></button>
									{:else}
										<span class="stream-step" aria-live="off" title={step.full}>{step.text}</span>
									{/if}
									{#if step.elapsed}<span class="stream-step-elapsed mono" aria-hidden="true">{step.elapsed}</span>{/if}
								{:else}
									<span class="stream-step" aria-live="off">{said ? t.stream.streaming : stage.statusLabels.running}</span>
								{/if}
								<span class="duration-badge mono">
									<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
									{formatLiveDuration(item.turn.created_at, stage.nowMs)}
								</span>
							</div>
							{#if stage.openStepsTurn === item.turn.id}
								{@const rows = liveSteps(item.turn.id)}
								{#if rows}
									<TurnStepList
										id={`turn-steps-${item.turn.id}`}
										title={t.chat.activity.nowTitle(botAuthor?.name ?? t.top.deleted, rows.length)}
										{rows}
										outputOf={(callId) => commandOutput(item.turn.id, callId)}
										onClose={() => (stage.openStepsTurn = null)}
									/>
								{/if}
							{/if}
						</article>
					{:else if item.type === 'message'}
						<article class="msg is-reply">
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
							<MarkdownBody
								source={stage.messageBody(item.message)}
								options={stage.markdownOpts(item.message)}
								copyLabel={t.chat.copyCode}
								copiedLabel={t.chat.copied}
								onOpenArtifact={(path) => stage.onOpenArtifact(path, undefined, item.message.id)}
								onOpenImage={(path, from) => stage.openBodyImage(item.message, path, from)}
								loadArtifactImage={stage.loadBodyImage}
								onOpenProfile={stage.onOpenProfile}
							/>
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
						{@const tagged = !stage.fileDrop && item.message.kind === 'bot' && !item.message.control && stage.attributionChips.has(item.message.id)}
						{@const ranIn = item.message.turn_id && stage.commandHosts.has(item.message.id) ? item.message.turn_id : null}
						{@const duration = calculateBotDuration(item.message, stage.snapshot.messages, stage.snapshot.turns, stage.messageLookup)}
						{#snippet tail()}
							{#if tagged}
								<MessageAttribution
									message={item.message} {t}
									plans={runtime.attributionPlans[item.message.session_id] ?? []}
									disabled={!stage.connected || stage.lockedComposer}
									onOpen={() => { stage.attributionEditId = item.message.id; }}
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
						<ReactionRow message={item.message} lockedComposer={stage.lockedComposer} {runtime} />
						{#if item.replying && item.replying.length > 0}
							<div class="msg-attached-replying" aria-live="polite">
								<ReplyingIndicator
									entries={item.replying}
									botsById={stage.botsById}
									isUser={false}
									thinkingText={stage.statusLabels.running}
									deletedText={t.top.deleted}
									onOpenProfile={stage.onOpenProfile}
								/>
							</div>
						{/if}
						{#if stage.botDmIndex.get(item.message.id)}
							<div class="msg-attached-botdm">
								<BotDmEntry
									sessions={stage.botDmIndex.get(item.message.id) ?? []}
									botsById={stage.botsById}
									turns={stage.snapshot.turns}
									approvals={stage.snapshot.approvals}
									pendingJudgements={stage.snapshot.pendingJudgements}
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

	.msg-wrap.is-bot {
		max-width: 100%;
		align-self: stretch;
	}

	/* A reply takes the column's full width, so its hover toolbar sits at the column's far edge. */
	.msg-wrap.is-bot:not(.is-system-row) .msg-segment {
		width: 100%;
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

	/* A quiet tag beside the name: the accent is kept for what you can act on. */
	.bot-badge {
		font-size: 10px;
		font-weight: 600;
		padding: 1px 5px;
		border-radius: var(--radius-xs);
		border: 1px solid var(--line);
		color: var(--muted);
		line-height: 1.2;
	}

	.model-badge {
		font-size: 11px;
		padding: 1px 6px;
		border-radius: var(--radius-xs);
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--muted);
	}

	.msg-time {
		font-size: 11px;
		color: var(--muted);
		margin-left: 2px;
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

	.msg-wrap.is-group .msg-segment:not(:first-child) .msg:not(.is-you) {
		border-radius: var(--radius-md) var(--radius-lg) var(--radius-lg) var(--radius-lg);
	}

	/* The ground a part takes under the pointer fades in; the rule that sets it is the stage's (ChatStage), which knows whether a message's menu is open. */
	@media (hover: hover) {
		.msg-wrap.is-bot .msg-segment {
			transition: background-color 0.12s ease;
		}
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

	.msg-attached-replying {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-top: 5px;
		/* The line names a path or a command: it clips inside the message's width, never past it. */
		max-width: 100%;
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

		.msg-header .bot-badge {
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
</style>
