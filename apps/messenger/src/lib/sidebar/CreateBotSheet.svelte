<script lang="ts">
	import AvatarEditor from '../AvatarEditor.svelte';
	import { backdropClick } from '../click-outside.ts';
	import Select from '../Select.svelte';
	import { thinkingLevelLabel, type Copy } from '../copy.ts';
	import {
		applyModelPin,
		botNameErrorCopy,
		mapCreateBotError,
		pinnableThinkingLevels,
		planCreateBot,
		type CreateBotDraft,
		type CreateBotFieldErrors
	} from '../panels/create-form.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import type { SelectOption } from '../select-options.ts';

	type Props = {
		runtime: MessengerRuntime;
		modelOptions: SelectOption[];
		t: Copy;
		onClose: () => void;
	};

	let { runtime, modelOptions, t, onClose }: Props = $props();
	/** A click outside closes the sheet; a text-selection drag that starts inside never does. */
	const backdrop = backdropClick();

	// The sheet is mounted only while it is open, so a fresh mount is the reset.
	let draft = $state<CreateBotDraft>({
		name: '',
		duties: '',
		boundaries: '',
		avatar: '',
		model: '',
		thinkingLevel: ''
	});
	let errors = $state<CreateBotFieldErrors>({});
	let failed = $state(false);

	const providers = $derived(runtime.snapshot.providers);
	const modelValues = $derived(modelOptions.map((option) => option.value));
	const thinkingOptions = $derived(pinnableThinkingLevels(draft.model, providers));

	function onInput(): void {
		errors = {};
		failed = false;
	}

	function onModelChange(value: string): void {
		const pinned = applyModelPin(value, draft.thinkingLevel ?? '', providers);
		draft.model = pinned.model;
		draft.thinkingLevel = pinned.thinkingLevel;
		onInput();
	}

	function pickThinking(level: string): void {
		draft.thinkingLevel = level;
		onInput();
	}

	async function save(): Promise<void> {
		failed = false;
		errors = {};
		const plan = planCreateBot(draft, modelValues);
		if (!plan.ok) {
			errors = plan.errors;
			return;
		}
		const error = await runtime.createBot(plan.body);
		if (!error) return;
		const mapped = mapCreateBotError(error.status, error.message);
		if ('top' in mapped) failed = true;
		else errors = mapped;
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	class="modal-backdrop page-on-phone"
	transition:pageSlide
	role="dialog"
	aria-modal="true"
	tabindex="-1"
	onmousedowncapture={backdrop.press}
	onclick={(e) => {
		if (backdrop.isOutside(e)) onClose();
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') onClose();
	}}
>
	<div class="modal-dialog create-bot-modal">
		<div class="modal-head">
			<button
				type="button"
				class="modal-back"
				aria-label={t.common.back}
				onclick={onClose}
			>
				<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
			</button>
			<h2>{t.sidebar.addBot}</h2>
			<button type="button" class="modal-close" title={t.common.close} onclick={onClose}>✕</button>
		</div>
		<div class="modal-body">
			{#if failed}
				<p class="field-error">{t.sidebar.saveFailed}</p>
			{/if}
			<div class="modal-section">
				<span class="field-head">{t.sidebar.botAvatar}</span>
				<AvatarEditor bind:avatar={draft.avatar} name={draft.name} {t} onchange={onInput} />
			</div>
			<div class="modal-section">
				<label for="bot-name">{t.sidebar.botName}</label>
				<input id="bot-name" type="text" bind:value={draft.name} oninput={onInput} />
				{#if errors.name}
					<p class="field-error">{botNameErrorCopy(errors.name, t.sidebar)}</p>
				{/if}
			</div>
			<div class="modal-section">
				<label for="bot-duties">{t.sidebar.botDuties}</label>
				<textarea id="bot-duties" bind:value={draft.duties} oninput={onInput}></textarea>
				{#if errors.duties}
					<p class="field-error">{t.sidebar.dutiesEmpty}</p>
				{/if}
			</div>
			<div class="modal-section">
				<label for="bot-boundaries">{t.sidebar.botBoundaries}</label>
				<textarea id="bot-boundaries" bind:value={draft.boundaries} oninput={onInput}></textarea>
				{#if errors.boundaries}
					<p class="field-error">{t.sidebar.boundariesEmpty}</p>
				{/if}
			</div>
			<div class="modal-section">
				<label for="bot-model">{t.sidebar.botModel}</label>
				<Select
					id="bot-model"
					bind:value={draft.model}
					placeholder={t.sidebar.botModelDefault}
					emptyLabel={t.sidebar.botModelDefault}
					options={modelOptions}
					error={!!errors.model}
					onchange={onModelChange}
				/>
				{#if errors.model}
					<p class="field-error">{t.sidebar.botModelInvalid}</p>
				{:else if !draft.model}
					<p class="muted field-hint">{t.sidebar.botModelAutoHint}</p>
				{/if}
			</div>
			{#if draft.model}
				<div class="modal-section">
					<span class="field-label" id="bot-thinking-label">{t.sidebar.botThinking}</span>
					<div class="thinking-picker" role="radiogroup" aria-labelledby="bot-thinking-label">
						{#each thinkingOptions as level (level)}
							<button
								type="button"
								class="btn-chip level-chip"
								class:active={draft.thinkingLevel === level}
								role="radio"
								aria-checked={draft.thinkingLevel === level}
								onclick={() => pickThinking(level)}
							>{thinkingLevelLabel(t.sidebar.thinkingLevels, level)}</button>
						{/each}
					</div>
					<p class="muted field-hint">{t.sidebar.botThinkingHint}</p>
					{#if errors.thinkingLevel}
						<p class="field-error">{t.sidebar.botThinkingInvalid}</p>
					{/if}
				</div>
			{/if}
		</div>
		<div class="modal-foot actions">
			<button type="button" onclick={() => void save()}>{t.sidebar.create}</button>
			<button type="button" onclick={onClose}>{t.common.close}</button>
		</div>
	</div>
</div>

<style>
	.modal-dialog.create-bot-modal {
		width: 500px;
		max-width: 95vw;
		max-height: 88vh;
	}

	.create-bot-modal :global(.modal-body) {
		padding: 20px 24px;
		gap: 16px;
	}

	.create-bot-modal :global(.modal-body) :global(textarea) {
		min-height: 72px;
	}

	/* A page has the whole width; 24px of gutter on a phone is half a field. */
	@media (max-width: 680px) {
		.create-bot-modal :global(.modal-body) {
			padding: 18px 16px calc(18px + env(safe-area-inset-bottom));
		}
	}
</style>
