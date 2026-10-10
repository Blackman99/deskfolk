<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { AGENT_KINDS, type AgentsStatusResponse } from '@real-bot/protocol';
	import AvatarEditor from '../AvatarEditor.svelte';
	import { backdropClick } from '../click-outside.ts';
	import ModelPicker from '../ModelPicker.svelte';
	import Select from '../Select.svelte';
	import { thinkingLevelLabel, type Copy } from '../copy.ts';
	import {
		agentModelPicker,
		applyModelPin,
		botNameErrorCopy,
		claudeModelPicker,
		endpointModelPicker,
		mapCreateBotError,
		pickerValues,
		pinnableThinkingLevels,
		planCreateBot,
		type CreateBotDraft,
		type CreateBotFieldErrors
	} from '../panels/create-form.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import { agentBlocker, agentLabelOf, agentStatusOf, parseRunnerValue, runnerOptions, setupRunnerOf } from '../runner-choice.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		onClose: () => void;
	};

	let { runtime, t, onClose }: Props = $props();
	/** A click outside closes the sheet; a text-selection drag that starts inside never does. */
	const backdrop = backdropClick();

	// The sheet is mounted only while it is open, so a fresh mount is the reset. With no endpoint a
	// Bot could run on — set up on Claude Code alone (ADR 0078), or on another local agent (ADR 0079)
	// — it starts on that agent.
	let draft = $state<CreateBotDraft>({
		name: '',
		duties: '',
		boundaries: '',
		avatar: '',
		model: '',
		thinkingLevel: '',
		runner: untrack(() => {
			const { providers, settings } = runtime.snapshot;
			return setupRunnerOf(providers, settings.builtin_models?.reader ?? settings.reader_model);
		})
	});
	/** What the daemon finds of your other local agents; the runner picker lists them. Asked once, on opening. */
	let agents = $state<AgentsStatusResponse | null>(null);
	onMount(() => {
		const client = runtime.client;
		if (!client) return;
		void (async () => {
			try {
				agents = await client.agents();
			} catch {
				// The phone, or a daemon older than local agents: only the app's loop and Claude are offered.
				agents = null;
			}
		})();
	});
	const runnerChoices = $derived(runnerOptions(t, agents, draft.runner ?? ''));
	const runnerPick = $derived(parseRunnerValue(draft.runner));
	const agentRunner = $derived(runnerPick.runner && runnerPick.runner !== 'claude_code' ? runnerPick.runner : null);
	const agentName = $derived(agentRunner ? agentLabelOf(agentRunner, runnerPick.customId, agents) : '');
	const agentStatus = $derived(agentRunner ? agentStatusOf(agents, agentRunner, runnerPick.customId) : null);
	const agentBlocked = $derived(agentBlocker(agentStatus));
	let errors = $state<CreateBotFieldErrors>({});
	let failed = $state(false);

	const providers = $derived(runtime.snapshot.providers);
	const endpointModels = $derived(endpointModelPicker(providers, t));
	const modelValues = $derived(pickerValues(endpointModels));
	const thinkingOptions = $derived(pinnableThinkingLevels(draft.model, providers));

	function onInput(): void {
		errors = {};
		failed = false;
	}

	/** Another agent names its models its own way: a model picked for one is not carried to the next. */
	function onRunnerChange(): void {
		draft.agentModel = undefined;
		onInput();
	}

	function onAgentModelChange(value: string): void {
		draft.agentModel = value;
		onInput();
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
				<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
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
				<label for="bot-runner">{t.sidebar.botRunner}</label>
				<Select id="bot-runner" bind:value={draft.runner} options={runnerChoices} error={!!errors.agentCustomId} onchange={onRunnerChange} />
				{#if errors.agentCustomId}
					<p class="field-error">{t.sidebar.botRunnerCustomInvalid}</p>
				{:else if agentRunner}
					{#if agentBlocked === 'missing'}
						<p class="field-error" data-runner-missing>{t.sidebar.botRunnerAgentMissing(agentName, AGENT_KINDS[agentRunner].command)}</p>
					{:else if agentBlocked === 'signed_out'}
						<p class="field-error" data-runner-signed-out>{t.sidebar.botRunnerAgentSignedOut(agentName, agentStatus?.login_command ?? null)}</p>
					{:else}
						<p class="muted field-hint">{t.sidebar.botRunnerAgentCreateHint(agentName)}</p>
					{/if}
					{#if !AGENT_KINDS[agentRunner].appTools}
						<p class="muted field-hint" data-runner-note>{t.sidebar.botRunnerNoAppTools(agentName)}</p>
					{/if}
				{:else}
					<p class="muted field-hint">{draft.runner === 'claude_code' ? t.sidebar.botRunnerClaudeCreateHint : t.sidebar.botRunnerAppHint}</p>
				{/if}
			</div>
			{#if !draft.runner}
			<div class="modal-section">
				<label for="bot-model">{t.sidebar.botModel}</label>
				<ModelPicker
					id="bot-model"
					bind:value={draft.model}
					data={endpointModels}
					{t}
					placeholder={t.sidebar.botModelDefault}
					title={t.sidebar.botModel}
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
			{:else if draft.runner === 'claude_code'}
			<div class="modal-section">
				<label for="bot-agent-model">{t.sidebar.botAgentModel}</label>
				<ModelPicker
					id="bot-agent-model"
					value={draft.agentModel ?? ''}
					data={claudeModelPicker(t, draft.agentModel ?? '')}
					{t}
					title={t.sidebar.botAgentModel}
					error={!!errors.agentModel}
					onchange={onAgentModelChange}
				/>
				{#if errors.agentModel}
					<p class="field-error">{t.sidebar.botAgentModelInvalid}</p>
				{/if}
			</div>
			{:else if agentRunner}
			<div class="modal-section" data-agent-model>
				<label for="bot-agent-model">{t.sidebar.botAgentModelOf(agentName)}</label>
				<ModelPicker
					id="bot-agent-model"
					value={draft.agentModel ?? ''}
					data={agentModelPicker(agents, t, agentRunner, runnerPick.customId, draft.agentModel ?? '')}
					{t}
					title={t.sidebar.botAgentModelOf(agentName)}
					error={!!errors.agentModel}
					onchange={onAgentModelChange}
				/>
				{#if errors.agentModel}
					<p class="field-error">{t.sidebar.botAgentModelInvalidOf(agentName)}</p>
				{:else}
					<p class="muted field-hint">{t.sidebar.botAgentModelEmptyHint(agentName, agentStatus?.default_model ?? null)}</p>
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
