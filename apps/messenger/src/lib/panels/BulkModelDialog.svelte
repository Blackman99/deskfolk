<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import Select from '../Select.svelte';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import { backdropClick } from '../click-outside.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import { thinkingLevelLabel, type Copy } from '../copy.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { toggleValue, type SelectOption } from '../select-options.ts';
	import {
		botPinLabel,
		bulkModelErrorCopy,
		bulkModelOptions,
		choiceSelectValue,
		initialSelection,
		liveSelection,
		mapBulkModelError,
		orderBulkRows,
		pickBulkModel,
		planBulkModel,
		selectAllActive,
		type BulkModelChoice,
		type BulkModelFailure
	} from './bulk-model.ts';
	import { pinnableThinkingLevels } from './create-form.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		/** The profile pane's options, in its `provider::name` encoding. */
		modelOptions: SelectOption[];
		/** Bots to open with ticked: a session's present Bots, or none from the roster-wide entry. */
		preselect: readonly string[];
		onClose: () => void;
	};

	let { runtime, t, modelOptions, preselect, onClose }: Props = $props();
	/** A click outside closes the dialog; a text-selection drag that starts inside never does. */
	const backdrop = backdropClick();
	let backdropEl = $state<HTMLElement | null>(null);

	// Mounted only while open, so a fresh mount is the reset. The opening pick is read once: it
	// also fixes the row order, and a tick must not move the row under the pointer.
	const opening = untrack(() => initialSelection(runtime.snapshot.bots, preselect));
	const openedWith = new Set(opening);
	let selected = $state<string[]>(opening);
	let choice = $state<BulkModelChoice>(null);
	let busy = $state(false);
	let failure = $state<BulkModelFailure | null>(null);

	const bots = $derived(runtime.snapshot.bots);
	const providers = $derived(runtime.snapshot.providers);
	const rows = $derived(orderBulkRows(bots, openedWith));
	const ticked = $derived(liveSelection(bots, selected));
	const tickedSet = $derived(new Set(ticked));
	const options = $derived(bulkModelOptions(modelOptions, t.sidebar.botModelDefault));
	const thinkingOptions = $derived(
		choice && choice.model ? pinnableThinkingLevels(choice.model, providers) : []
	);
	const plan = $derived(planBulkModel(ticked, choice));
	const pinLabels = $derived({ auto: t.sidebar.botModelDefault, levels: t.sidebar.thinkingLevels });
	const failureText = $derived(failure ? bulkModelErrorCopy(failure, t.bulkModel) : null);

	// Focus comes into the dialog, and goes back to whatever opened it when the dialog goes away.
	onMount(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		backdropEl?.focus();
		return () => {
			if (opener?.isConnected) opener.focus();
		};
	});

	function toggle(botId: string): void {
		selected = toggleValue(ticked, botId);
		failure = null;
	}

	function selectAll(): void {
		selected = selectAllActive(bots, ticked);
		failure = null;
	}

	function clearAll(): void {
		selected = [];
		failure = null;
	}

	function onPick(value: string): void {
		choice = pickBulkModel(value, choice, providers);
		failure = null;
	}

	function pickThinking(level: string): void {
		if (!choice || choice.thinkingLevel === level) return;
		choice = { ...choice, thinkingLevel: level };
		failure = null;
	}

	/** One request for every ticked Bot. A refusal changed nothing, so the picks stay for another go. */
	async function apply(): Promise<void> {
		const body = plan;
		if (!body || busy) return;
		busy = true;
		failure = null;
		const error = await runtime.patchBotsModel(body);
		busy = false;
		if (!error) {
			onClose();
			return;
		}
		failure = mapBulkModelError(error.status, error.message, runtime.snapshot.bots);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	bind:this={backdropEl}
	class="modal-backdrop page-on-phone"
	transition:pageSlide
	role="dialog"
	aria-modal="true"
	aria-labelledby="bulk-model-title"
	tabindex="-1"
	onmousedowncapture={backdrop.press}
	onclick={(e) => {
		if (backdrop.isOutside(e)) onClose();
	}}
	onkeydown={(e) => {
		if (e.key !== 'Escape') return;
		// The drawer this may sit on closes on Escape too; this keystroke is the dialog's alone. An
		// open picker already took it to close its own list, and the dialog stays.
		e.stopPropagation();
		if (!e.defaultPrevented) onClose();
	}}
>
	<div class="modal-dialog bulk-model-modal">
		<div class="modal-head">
			<button
				type="button"
				class="modal-back"
				aria-label={t.common.back}
				onclick={onClose}
			>
				<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
			</button>
			<h2 id="bulk-model-title">{t.bulkModel.title}</h2>
			<button
				type="button"
				class="modal-close"
				title={t.common.close}
				aria-label={t.common.close}
				onclick={onClose}>✕</button
			>
		</div>
		<div class="modal-body">
			{#if failureText}
				<p class="field-error bulk-model-failure" role="alert">{failureText}</p>
			{/if}
			<div class="modal-section">
				<label for="bulk-model-pick">{t.bulkModel.model}</label>
				<Select
					id="bulk-model-pick"
					value={choiceSelectValue(choice)}
					placeholder={t.bulkModel.modelPlaceholder}
					{options}
					error={failure?.kind === 'model'}
					onchange={onPick}
				/>
				{#if choice && !choice.model}
					<p class="muted field-hint">{t.bulkModel.autoHint}</p>
				{/if}
			</div>
			{#if choice && choice.model}
				<div class="modal-section">
					<span class="field-label" id="bulk-model-thinking-label">{t.sidebar.botThinking}</span>
					<div class="thinking-picker" role="radiogroup" aria-labelledby="bulk-model-thinking-label">
						{#each thinkingOptions as level (level)}
							<button
								type="button"
								class="btn-chip level-chip"
								class:active={choice.thinkingLevel === level}
								role="radio"
								aria-checked={choice.thinkingLevel === level}
								onclick={() => pickThinking(level)}
							>{thinkingLevelLabel(t.sidebar.thinkingLevels, level)}</button>
						{/each}
					</div>
					<p class="muted field-hint">{t.bulkModel.thinkingHint}</p>
				</div>
			{/if}
			<div class="modal-section bulk-model-bots">
				<div class="bulk-model-bots-head">
					<span class="field-label" id="bulk-model-bots-label">{t.bulkModel.bots}</span>
					<span class="bulk-model-count" aria-live="polite">{t.bulkModel.selected(ticked.length)}</span>
					<span class="bulk-model-acts">
						<button
							type="button"
							class="bulk-model-link"
							title={t.bulkModel.selectAllHint}
							disabled={rows.length === 0}
							onclick={selectAll}>{t.bulkModel.selectAll}</button
						>
						<button
							type="button"
							class="bulk-model-link"
							disabled={ticked.length === 0}
							onclick={clearAll}>{t.bulkModel.clear}</button
						>
					</span>
				</div>
				{#if rows.length === 0}
					<p class="muted field-hint">{t.bulkModel.empty}</p>
				{:else}
					<div class="bulk-model-list" role="group" aria-labelledby="bulk-model-bots-label">
						{#each rows as bot (bot.id)}
							{@const pal = botAvatarColor(bot.id)}
							{@const src = avatarSrc(bot.avatar)}
							<label class="bulk-model-row" class:is-on={tickedSet.has(bot.id)}>
								<input
									type="checkbox"
									checked={tickedSet.has(bot.id)}
									onchange={() => toggle(bot.id)}
								/>
								<span
									class="bulk-model-avatar"
									style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
									aria-hidden="true"
								>
									{#if src}
										<img {src} alt="" class="avatar-img" />
									{:else}
										{rosterLetter(bot.name)}
									{/if}
								</span>
								<span class="bulk-model-row-text">
									<span class="bulk-model-row-name">{bot.name}</span>
									<span class="bulk-model-row-pin">{botPinLabel(bot, pinLabels, providers)}</span>
								</span>
								{#if bot.archived_at}
									<span class="bulk-model-archived">{t.top.archived}</span>
								{/if}
							</label>
						{/each}
					</div>
				{/if}
			</div>
		</div>
		<div class="modal-foot actions">
			<button type="button" disabled={!plan || busy} onclick={() => void apply()}>
				{busy ? t.bulkModel.applying : t.bulkModel.apply(ticked.length)}
			</button>
			<button type="button" onclick={onClose}>{t.bulkModel.cancel}</button>
		</div>
	</div>
</div>

<style>
	/*
	 * The model picker's list opens out of the body, so neither the frame nor the body clips; the
	 * Bot list is the one part that scrolls, and it gives way first when the window is short. The
	 * head and foot round their own corners in place of the frame's overflow.
	 */
	.modal-dialog.bulk-model-modal {
		width: 480px;
		max-width: 100%;
		max-height: calc(100vh - 48px);
		overflow: visible;
	}

	.modal-head {
		border-radius: var(--radius-xl) var(--radius-xl) 0 0;
	}

	.modal-body {
		overflow: visible;
		min-height: 0;
		padding: 18px 22px;
		gap: 16px;
	}

	.modal-foot {
		border-radius: 0 0 var(--radius-xl) var(--radius-xl);
	}

	.modal-foot button:disabled,
	.modal-foot button:disabled:hover {
		opacity: 0.5;
		cursor: not-allowed;
		background: var(--accent);
	}

	.bulk-model-failure {
		margin: 0;
	}

	.bulk-model-bots {
		flex: 0 1 auto;
		min-height: 0;
	}

	.bulk-model-bots-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.bulk-model-bots-head .field-label {
		margin: 0;
	}

	.bulk-model-count {
		font-size: 12px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.bulk-model-acts {
		margin-left: auto;
		display: inline-flex;
		gap: 2px;
		flex-shrink: 0;
	}

	.bulk-model-link {
		border: 0;
		background: transparent;
		box-shadow: none;
		color: var(--accent);
		font-size: 12px;
		font-weight: 600;
		padding: 2px 6px;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.bulk-model-link:hover:not(:disabled) {
		background: var(--accent-tint);
	}

	.bulk-model-link:disabled {
		color: var(--muted);
		opacity: 0.6;
		cursor: not-allowed;
	}

	.bulk-model-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.bulk-model-list {
		flex: 0 1 auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 320px;
		min-height: 88px;
		overflow-y: auto;
		scrollbar-width: thin;
		scrollbar-color: var(--muted-light) transparent;
		margin-top: 4px;
		padding: 4px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
	}

	.bulk-model-row {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		border: 1px solid transparent;
		cursor: pointer;
		transition: background 0.12s ease;
	}

	.bulk-model-row:hover {
		background: var(--line-subtle);
	}

	.bulk-model-row.is-on {
		background: var(--accent-tint);
		border-color: var(--accent-border);
	}

	.bulk-model-row:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	.bulk-model-row input {
		flex-shrink: 0;
		margin: 0;
		accent-color: var(--accent);
	}

	.bulk-model-avatar {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		border: 1px solid;
		overflow: hidden;
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 11px;
		font-weight: 700;
		line-height: 1;
	}

	.bulk-model-row-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
		gap: 1px;
	}

	.bulk-model-row-name,
	.bulk-model-row-pin {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bulk-model-row-name {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.bulk-model-row-pin {
		font-family: var(--mono);
		font-size: 11px;
		color: var(--muted);
	}

	.bulk-model-archived {
		flex-shrink: 0;
		font-size: 10.5px;
		font-weight: 600;
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--warn-bg);
		color: var(--warn-text);
		border: 1px solid var(--warn-line);
	}

	/* As a page there are no corners to round, and the Bot list has the height the page gives it. */
	@media (max-width: 680px) {
		.modal-head,
		.modal-foot {
			border-radius: 0;
		}

		.modal-body {
			flex: 1;
			padding: 18px 16px;
		}

		.bulk-model-bots {
			flex: 1 1 auto;
		}

		.bulk-model-list {
			flex: 1 1 auto;
			max-height: none;
		}
	}

	/*
	 * Too short for the list to give way further: the whole body scrolls instead, so the footer never
	 * sits over rows. The model picker's list then scrolls with it.
	 */
	@media (max-height: 560px) {
		.modal-body {
			overflow-y: auto;
		}

		.bulk-model-list {
			max-height: none;
			min-height: 0;
			flex: none;
			overflow-y: visible;
		}
	}
</style>
