<script lang="ts">
	import type { Bot } from '@real-bot/protocol';
	import type { ReplyingEntry } from './transcript.ts';
	import type { ActivityCopy, StepLine, TurnSteps } from './turn-activity.ts';
	import TurnStepList from './TurnStepList.svelte';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';

	interface Props {
		entries: readonly ReplyingEntry[];
		botsById: Map<string, Bot>;
		isUser?: boolean;
		thinkingText: string;
		/** What this Bot is doing right now, when its turn has said; otherwise it is thinking. */
		stepLine?: (entry: ReplyingEntry) => StepLine | null;
		/** Every step behind that line, for the list a click on it opens. Read only while open. */
		stepsOf?: (entry: ReplyingEntry) => TurnSteps | null;
		/** What a step's command has printed, when this conversation is watching it. */
		outputOf?: (entry: ReplyingEntry, callId: string) => string | null;
		activityCopy?: ActivityCopy;
		deletedText?: string;
		onOpenProfile?: (botId: string) => void;
	}

	let {
		entries,
		botsById,
		isUser = false,
		thinkingText,
		stepLine,
		stepsOf,
		outputOf,
		activityCopy,
		deletedText = '?',
		onOpenProfile
	}: Props = $props();

	const uid = $props.id();
	/** The turn whose steps are open under this card: one at a time. */
	let openTurn = $state<string | null>(null);
	// A turn that ends takes its list with it: the card it hung from is gone.
	const openEntry = $derived(openTurn ? (entries.find((entry) => entry.turn_id === openTurn) ?? null) : null);
	const openSteps = $derived(openEntry ? (stepsOf?.(openEntry) ?? null) : null);
	const panelId = `${uid}-steps`;

	function canOpen(entry: ReplyingEntry): boolean {
		return Boolean(entry.turn_id && stepsOf && activityCopy);
	}

	function toggle(entry: ReplyingEntry): void {
		openTurn = openTurn === entry.turn_id ? null : (entry.turn_id ?? null);
	}
</script>

{#snippet identity(entry: ReplyingEntry)}
	{@const replyBot = botsById.get(entry.bot_id)}
	{@const pal = botAvatarColor(entry.bot_id)}
	{#if onOpenProfile && replyBot}
		<button
			type="button"
			class="attached-replying-chip is-clickable"
			onclick={() => onOpenProfile(entry.bot_id)}
			title={replyBot.name}
		>
			<div
				class="attached-replying-avatar"
				style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
			>
				{#if avatarSrc(replyBot.avatar)}
					<img src={avatarSrc(replyBot.avatar)} alt="" class="avatar-img" />
				{:else}
					{rosterLetter(replyBot.name)}
				{/if}
			</div>
			<span class="attached-replying-name">{replyBot.name}</span>
		</button>
	{:else}
		<div class="attached-replying-chip">
			<div
				class="attached-replying-avatar"
				style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
				title={replyBot?.name ?? deletedText}
			>
				{#if avatarSrc(replyBot?.avatar)}
					<img src={avatarSrc(replyBot?.avatar)} alt="" class="avatar-img" />
				{:else}
					{rosterLetter(replyBot?.name ?? '?')}
				{/if}
			</div>
			<span class="attached-replying-name">{replyBot?.name ?? deletedText}</span>
		</div>
	{/if}
{/snippet}

{#snippet elapsed(step: StepLine)}
	{#if step.elapsed}
		<span class="attached-replying-elapsed mono" aria-hidden="true">{step.elapsed}</span>
	{/if}
{/snippet}

{#if entries && entries.length > 0}
	{#if entries.length === 1}
		{@const entry = entries[0]}
		{@const step = stepLine?.(entry) ?? null}
		<div class="attached-replying-card is-single" class:is-user={isUser}>
			{@render identity(entry)}
			<span class="attached-replying-dots inline-flex items-center gap-[2.5px] ml-1 mr-1" aria-hidden="true">
				<span class="replying-dot"></span>
				<span class="replying-dot"></span>
				<span class="replying-dot"></span>
			</span>
			<!-- Not announced as it changes: a step can last a second, and its timer ticks. -->
			{#if step && canOpen(entry)}
				<button
					type="button"
					class="attached-replying-text is-toggle text-11p5 text-muted font-normal"
					aria-live="off"
					aria-expanded={openTurn === entry.turn_id}
					aria-controls={panelId}
					title={`${step.full}\n${activityCopy?.showSteps ?? ''}`}
					onclick={() => toggle(entry)}
				><span class="toggle-label">{step.text}</span></button>
			{:else}
				<span
					class="attached-replying-text text-11p5 text-muted font-normal"
					aria-live="off"
					title={step?.full}
				>{step?.text ?? thinkingText}</span>
			{/if}
			{#if step}{@render elapsed(step)}{/if}
		</div>
	{:else}
		<div class="attached-replying-card is-multiple" class:is-user={isUser}>
			<div class="attached-replying-header flex items-center gap-3 py-0 px-1 leading-none select-none">
				<span class="attached-replying-dots inline-flex items-center gap-[2.5px] ml-1 mr-1" aria-hidden="true">
					<span class="replying-dot"></span>
					<span class="replying-dot"></span>
					<span class="replying-dot"></span>
				</span>
				<span class="attached-replying-title text-11p5 font-medium text-muted tracking-[0.01em]">{thinkingText}</span>
				<span class="attached-replying-count mono">{entries.length}</span>
			</div>
			<div class="attached-replying-roster flex flex-wrap gap-[5px] items-center">
				{#each entries as entry (entry.turn_id ?? entry.judgement_id ?? entry.bot_id)}
					{@const step = stepLine?.(entry) ?? null}
					<div class="attached-replying-member" class:has-step={step} class:is-open={openTurn !== null && openTurn === entry.turn_id}>
						{@render identity(entry)}
						{#if step && canOpen(entry)}
							<button
								type="button"
								class="attached-replying-step is-toggle"
								aria-live="off"
								aria-expanded={openTurn === entry.turn_id}
								aria-controls={panelId}
								title={`${step.full}\n${activityCopy?.showSteps ?? ''}`}
								onclick={() => toggle(entry)}
							><span class="toggle-label">{step.text}</span></button>
							{@render elapsed(step)}
						{:else if step}
							<span class="attached-replying-step" aria-live="off" title={step.full}>{step.text}</span>
							{@render elapsed(step)}
						{/if}
					</div>
				{/each}
			</div>
		</div>
	{/if}
	{#if openEntry && openSteps && activityCopy}
		<TurnStepList
			id={panelId}
			name={botsById.get(openEntry.bot_id)?.name ?? deletedText}
			steps={openSteps}
			copy={activityCopy}
			outputOf={outputOf ? (callId) => outputOf(openEntry, callId) : undefined}
			{isUser}
			onClose={() => (openTurn = null)}
		/>
	{/if}
{/if}

<style>
	/* Base card animation and layout */
	.attached-replying-card {
		box-sizing: border-box;
		animation: replyingFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	/* Single bot replying: compact pill */
	.attached-replying-card.is-single {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 3px 10px 3px 4px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: 9999px;
		box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
		font-size: 12px;
		color: var(--muted);
		line-height: 1;
	}

	.attached-replying-card.is-single .attached-replying-chip {
		background: transparent;
		border: none;
		padding: 0;
		box-shadow: none;
		gap: 6px;
	}

	.attached-replying-card.is-single .attached-replying-avatar {
		width: 20px;
		height: 20px;
		font-size: 10px;
	}

	.attached-replying-card.is-single .attached-replying-name {
		font-weight: 600;
	}

	/* Multiple bots replying: merged card with header and chips roster */
	.attached-replying-card.is-multiple {
		display: inline-flex;
		flex-direction: column;
		gap: 7px;
		padding: 7px 10px 9px 10px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		box-shadow: 0 2px 6px rgba(15, 23, 42, 0.06);
		max-width: 100%;
	}

	.attached-replying-count {
		font-size: 10px;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--muted);
		letter-spacing: 0.01em;
		line-height: 1.2;
	}

	/* Bot chips inside the card */
	.attached-replying-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2.5px 8px 2.5px 3px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 9999px;
		font-size: 12px;
		line-height: 1;
		color: var(--ink);
		box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
		user-select: none;
		transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
	}

	button.attached-replying-chip {
		cursor: pointer;
		outline: none;
		font: inherit;
		color: inherit;
	}

	button.attached-replying-chip:hover {
		background: var(--line-hover);
		border-color: var(--muted-light);
		transform: translateY(-0.5px);
	}

	button.attached-replying-chip:active {
		transform: translateY(0.5px) scale(0.98);
	}

	button.attached-replying-chip:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.attached-replying-avatar {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		font-size: 9.5px;
		border: 1px solid;
		overflow: hidden;
		flex-shrink: 0;
		user-select: none;
	}

	.attached-replying-avatar :global(.avatar-img) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.attached-replying-name {
		font-size: 12px;
		font-weight: 500;
		color: var(--ink);
		white-space: nowrap;
		max-width: 140px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* A path or a command can be long; the pill stays a line beside the name, the tooltip has it all. */
	.attached-replying-card.is-single {
		max-width: 100%;
	}

	.attached-replying-card.is-single .attached-replying-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/*
	 * Several Bots: each is one pill, its name opening the profile and its step the list of steps.
	 * Wider than a phone, the name and the step clip first.
	 */
	.attached-replying-member {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
		border: 1px solid transparent;
		border-radius: 9999px;
	}

	.attached-replying-member.has-step {
		padding-right: 8px;
		background: var(--bg);
		border-color: var(--line);
		box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
	}

	.attached-replying-member.is-open {
		border-color: var(--accent-border);
	}

	/* The name is short and says whose step it is: the step clips before it does. */
	.attached-replying-member > .attached-replying-chip {
		flex-shrink: 0;
	}

	.attached-replying-member > .attached-replying-step {
		flex: 0 1 auto;
	}

	.attached-replying-member.has-step > .attached-replying-chip {
		background: transparent;
		border-color: transparent;
		box-shadow: none;
	}

	/* The step line as a button: it looks like the text it was, with a chevron saying it opens. */
	.is-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		font: inherit;
		color: inherit;
		cursor: pointer;
		outline: none;
	}

	.is-toggle::after {
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

	.is-toggle[aria-expanded='true']::after {
		margin-bottom: -2px;
		transform: rotate(-135deg);
	}

	.is-toggle:hover .toggle-label {
		color: var(--ink);
	}

	.is-toggle:focus-visible {
		border-radius: 4px;
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.toggle-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.attached-replying-step {
		min-width: 0;
		max-width: 240px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11.5px;
		color: var(--muted);
	}

	.attached-replying-elapsed {
		flex-shrink: 0;
		font-size: 10.5px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.replying-dot {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 4px var(--accent-glow);
		animation: dotBounce 1.4s infinite ease-in-out both;
	}

	.replying-dot:nth-child(1) {
		animation-delay: -0.32s;
	}

	.replying-dot:nth-child(2) {
		animation-delay: -0.16s;
	}

	.replying-dot:nth-child(3) {
		animation-delay: 0s;
	}

	@media (prefers-reduced-motion: reduce) {
	.attached-replying-card {
	animation: none;
	}
	}

	@media (prefers-reduced-motion: reduce) {
	.replying-dot {
	animation: none;
	}
	}

	@keyframes replyingFadeIn {
		from {
		opacity: 0;
		transform: translateY(3px);
		}
		to {
		opacity: 1;
		transform: translateY(0);
		}
	}

	@keyframes dotBounce {
		0%, 80%, 100% {
		transform: scale(0.6);
		opacity: 0.35;
		}
		40% {
		transform: scale(1.1);
		opacity: 1;
		}
	}

</style>
