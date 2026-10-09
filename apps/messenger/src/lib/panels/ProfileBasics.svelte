<script lang="ts">
	import { CLAUDE_EFFORTS, CLAUDE_MODEL_ALIASES, type ClaudeCodeStatus } from '@real-bot/protocol';
	import { claudeAccountLabel, claudeAccountOf, claudeAgentBlocker, claudeAgentPaysPerToken } from '../settings/claude-agent.ts';
	import AvatarEditor from '../AvatarEditor.svelte';
	import Select from '../Select.svelte';
	import { thinkingLevelLabel, type Copy } from '../copy.ts';
	import { applyModelPin, botNameErrorCopy, pinnableThinkingLevels, type CreateBotFieldErrors } from './create-form.ts';
	import type { ProfileFields } from './roster-edit.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { SelectOption } from '../select-options.ts';
	import { claudeAgentSource } from '../model-source.ts';

	/** The basics tab. The draft and its autosave belong to ProfilePane, which outlives a tab switch. */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		profileDraft: ProfileFields;
		profileErrors: CreateBotFieldErrors;
		profileSaving: boolean;
		profileFailed: boolean;
		profileSavedTick: number;
		profileModelOptions: SelectOption[];
		unlistedPin: string | null;
		claudeStatus: ClaudeCodeStatus | null;
		claudeUnavailable: boolean;
		onProfileInput: () => void;
		onProfilePick: () => void;
	};

	let {
		runtime,
		t,
		profileDraft = $bindable(),
		profileErrors,
		profileSaving,
		profileFailed,
		profileSavedTick,
		profileModelOptions,
		unlistedPin,
		claudeStatus,
		claudeUnavailable,
		onProfileInput,
		onProfilePick
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);

	const profileThinkingOptions = $derived(
		pinnableThinkingLevels(profileDraft.model, snapshot.providers)
	);

	const runnerOptions = $derived([
		{ value: '', label: t.sidebar.botRunnerApp },
		{ value: 'claude_code', label: t.sidebar.botRunnerClaude }
	]);
	const agentModelOptions = $derived.by((): SelectOption[] => {
		const source = claudeAgentSource(t);
		return [
			{ value: '', label: t.sidebar.botAgentModelDefault },
			...CLAUDE_MODEL_ALIASES.map((alias) => ({ value: alias, label: alias, source })),
			...(profileDraft.agentModel && !(CLAUDE_MODEL_ALIASES as readonly string[]).includes(profileDraft.agentModel)
				? [{ value: profileDraft.agentModel, label: profileDraft.agentModel, source }]
				: [])
		];
	});

	/** The account this Bot's turns spend, as Claude Code reports it; the daemon's own while none is picked. */
	const agentSignIn = $derived(claudeAccountOf(claudeStatus, profileDraft.agentConfigDir) ?? claudeStatus);
	/** What signs a listed account in, when that is the one picked. */
	const agentLoginCommand = $derived(
		profileDraft.agentConfigDir ? (claudeStatus?.accounts?.find((entry) => entry.config_dir === profileDraft.agentConfigDir)?.login_command ?? null) : null
	);
	const agentAccountOptions = $derived.by(() => {
		const own = claudeStatus && claudeStatus.path ? claudeAccountOf(claudeStatus, null) : null;
		const options = [{ value: '', label: own && own.logged_in !== false ? `${t.sidebar.botAgentAccountDefault} · ${claudeAccountLabel(own, t)}` : t.sidebar.botAgentAccountDefault }];
		for (const account of claudeStatus?.accounts ?? []) {
			if (account.config_dir) options.push({ value: account.config_dir, label: `${claudeAccountLabel(account, t)} · ${account.config_dir}` });
		}
		// On the phone, or listed no more: the account it runs on is still a choice.
		const current = profileDraft.agentConfigDir;
		if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
		return options;
	});

	function onProfileAgentAccountChange(value: string): void {
		profileDraft.agentConfigDir = value;
		onProfilePick();
	}

	function onProfileRunnerChange(value: string): void {
		profileDraft.runner = value === 'claude_code' ? 'claude_code' : '';
		onProfilePick();
	}

	function onProfileAgentModelChange(value: string): void {
		profileDraft.agentModel = value;
		onProfilePick();
	}

	function pickAgentEffort(level: string): void {
		if (profileDraft.agentEffort === level) return;
		profileDraft.agentEffort = level;
		onProfilePick();
	}

	function onProfileModelChange(value: string): void {
		const pinned = applyModelPin(value, profileDraft.thinkingLevel, snapshot.providers);
		profileDraft.model = pinned.model;
		profileDraft.thinkingLevel = pinned.thinkingLevel;
		onProfilePick();
	}

	function pickProfileThinking(level: string): void {
		if (profileDraft.thinkingLevel === level) return;
		profileDraft.thinkingLevel = level;
		onProfilePick();
	}
</script>

<div class="panel-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{t.detail.botBasics}</span>
		<span class="profile-save-state ml-auto text-12 text-muted whitespace-nowrap" class:is-error={profileFailed} aria-live="polite">
			{#if profileSaving}
				{t.sidebar.autoSaving}
			{:else if profileFailed}
				{t.sidebar.saveFailed}
			{:else if profileSavedTick > 0}
				{t.sidebar.autoSaved}
			{:else}
				{t.sidebar.autoSaveHint}
			{/if}
		</span>
	</div>
	<div class="panel-card-body">
		<div class="profile-avatar-block">
			<AvatarEditor bind:avatar={profileDraft.avatar} name={profileDraft.name} {t} onchange={onProfilePick} />
		</div>
		<div class="form-group">
			<label for="profile-name">{t.sidebar.botName}</label>
			<input
				id="profile-name"
				type="text"
				bind:value={profileDraft.name}
				oninput={onProfileInput}
				placeholder={t.sidebar.botName}
			/>
			{#if profileErrors.name}
				<p class="field-error">{botNameErrorCopy(profileErrors.name, t.sidebar)}</p>
			{/if}
		</div>

		<div class="form-group">
			<label for="profile-duties">{t.sidebar.botDuties}</label>
			<textarea
				id="profile-duties"
				class="profile-textarea profile-textarea-duties"
				bind:value={profileDraft.duties}
				oninput={onProfileInput}
				rows="6"
				placeholder={t.sidebar.botDuties}
			></textarea>
			{#if profileErrors.duties}
				<p class="field-error">{t.sidebar.dutiesEmpty}</p>
			{/if}
		</div>

		<div class="form-group">
			<label for="profile-boundaries">{t.sidebar.botBoundaries}</label>
			<textarea
				id="profile-boundaries"
				class="profile-textarea profile-textarea-boundaries"
				bind:value={profileDraft.boundaries}
				oninput={onProfileInput}
				rows="4"
				placeholder={t.sidebar.botBoundaries}
			></textarea>
			{#if profileErrors.boundaries}
				<p class="field-error">{t.sidebar.boundariesEmpty}</p>
			{/if}
		</div>

		<div class="form-group">
			<label for="profile-runner">{t.sidebar.botRunner}</label>
			<Select
				id="profile-runner"
				bind:value={profileDraft.runner}
				options={runnerOptions}
				onchange={onProfileRunnerChange}
			/>
			{#if profileDraft.runner === 'claude_code'}
				{#if claudeUnavailable}
					<p class="muted field-hint">{t.sidebar.botRunnerClaudeUnavailable}</p>
				{:else if !claudeStatus}
					<p class="muted field-hint">{t.sidebar.botRunnerClaudeChecking}</p>
				{:else if claudeAgentBlocker(claudeStatus, agentSignIn) === 'missing'}
					<p class="field-error" data-runner-missing>{t.sidebar.botRunnerClaudeMissing}</p>
				{:else if claudeAgentBlocker(claudeStatus, agentSignIn) === 'signed_out'}
					<p class="field-error" data-runner-signed-out>{agentLoginCommand ? t.sidebar.botRunnerClaudeAccountSignedOut(agentLoginCommand) : t.sidebar.botRunnerClaudeSignedOut}</p>
				{:else}
					<p class="muted field-hint" class:runner-pays={claudeAgentPaysPerToken(agentSignIn)} data-runner-account>{t.sidebar.botRunnerClaudeHint(claudeAccountLabel(agentSignIn ?? claudeStatus, t))}</p>
				{/if}
			{:else}
				<p class="muted field-hint">{t.sidebar.botRunnerAppHint}</p>
			{/if}
		</div>

		{#if profileDraft.runner === 'claude_code'}
		{#if profileDraft.agentConfigDir !== undefined}
		<div class="form-group" data-agent-account>
			<label for="profile-agent-account">{t.sidebar.botAgentAccount}</label>
			<Select
				id="profile-agent-account"
				bind:value={profileDraft.agentConfigDir}
				options={agentAccountOptions}
				error={!!profileErrors.agentConfigDir}
				onchange={onProfileAgentAccountChange}
			/>
			{#if profileErrors.agentConfigDir}
				<p class="field-error">{t.sidebar.botAgentAccountInvalid}</p>
			{:else}
				<p class="muted field-hint">{t.sidebar.botAgentAccountHint}</p>
			{/if}
		</div>
		{/if}
		<div class="form-group">
			<label for="profile-agent-model">{t.sidebar.botAgentModel}</label>
			<Select
				id="profile-agent-model"
				bind:value={profileDraft.agentModel}
				options={agentModelOptions}
				error={!!profileErrors.agentModel}
				onchange={onProfileAgentModelChange}
			/>
			{#if profileErrors.agentModel}
				<p class="field-error">{t.sidebar.botAgentModelInvalid}</p>
			{/if}
		</div>
		<div class="form-group">
			<span class="field-label" id="profile-agent-effort-label">{t.sidebar.botAgentEffort}</span>
			<div class="thinking-picker" role="radiogroup" aria-labelledby="profile-agent-effort-label">
				{#each ['', ...CLAUDE_EFFORTS] as level (level)}
					<button
						type="button"
						class="btn-chip level-chip"
						class:active={(profileDraft.agentEffort ?? '') === level}
						role="radio"
						aria-checked={(profileDraft.agentEffort ?? '') === level}
						onclick={() => pickAgentEffort(level)}
					>{level ? thinkingLevelLabel(t.sidebar.thinkingLevels, level) : t.sidebar.botAgentEffortDefault}</button>
				{/each}
			</div>
			<p class="muted field-hint">{t.sidebar.botAgentEffortHint}</p>
			{#if profileErrors.agentEffort}
				<p class="field-error">{t.sidebar.botAgentEffortInvalid}</p>
			{/if}
		</div>
		{:else}
		<div class="form-group">
			<label for="profile-model">{t.sidebar.botModel}</label>
			<Select
				id="profile-model"
				bind:value={profileDraft.model}
				placeholder={t.sidebar.botModelDefault}
				emptyLabel={t.sidebar.botModelDefault}
				options={profileModelOptions}
				error={!!profileErrors.model}
				onchange={onProfileModelChange}
			/>
			{#if profileErrors.model}
				<p class="field-error">{t.sidebar.botModelInvalid}</p>
			{:else if unlistedPin && profileDraft.model === unlistedPin}
				<p class="muted field-hint">{t.sidebar.botModelUnlistedHint}</p>
			{:else if !profileDraft.model}
				<p class="muted field-hint">{t.sidebar.botModelAutoHint}</p>
			{/if}
		</div>
		{#if profileDraft.model}
		<div class="form-group">
			<span class="field-label" id="profile-thinking-label">{t.sidebar.botThinking}</span>
			<div class="thinking-picker" role="radiogroup" aria-labelledby="profile-thinking-label">
				{#each profileThinkingOptions as level (level)}
					<button
						type="button"
						class="btn-chip level-chip"
						class:active={profileDraft.thinkingLevel === level}
						role="radio"
						aria-checked={profileDraft.thinkingLevel === level}
						onclick={() => pickProfileThinking(level)}
					>{thinkingLevelLabel(t.sidebar.thinkingLevels, level)}</button>
				{/each}
			</div>
			<p class="muted field-hint">{t.sidebar.botThinkingHint}</p>
			{#if profileErrors.thinkingLevel}
				<p class="field-error">{t.sidebar.botThinkingInvalid}</p>
			{/if}
		</div>
		{/if}
		{/if}
	</div>
</div>

<style>
	.profile-textarea {
		line-height: 1.5;
	}

	.profile-textarea-duties {
		min-height: 140px;
	}

	.profile-textarea-boundaries {
		min-height: 100px;
	}

	.profile-save-state.is-error {
		color: var(--danger-text);
	}

	.profile-avatar-block {
		margin-bottom: 14px;
		padding-bottom: 14px;
		border-bottom: 1px solid var(--line-subtle);
	}

	.profile-avatar-block :global(.avatar-editor) {
		margin-bottom: 0;
	}
</style>
