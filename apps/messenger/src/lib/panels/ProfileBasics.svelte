<script lang="ts">
	import { AGENT_KINDS, CLAUDE_MODEL_ALIASES, isAgentEffort, type AgentsStatusResponse, type ClaudeCodeStatus } from '@real-bot/protocol';
	import { claudeAccountLabel, claudeAccountOf, claudeAgentBlocker, claudeAgentPaysPerToken } from '../settings/claude-agent.ts';
	import AvatarEditor from '../AvatarEditor.svelte';
	import Select from '../Select.svelte';
	import { thinkingLevelLabel, type Copy } from '../copy.ts';
	import { applyModelPin, botNameErrorCopy, pinnableThinkingLevels, type CreateBotFieldErrors } from './create-form.ts';
	import type { ProfileFields } from './roster-edit.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { SelectOption } from '../select-options.ts';
	import { claudeAgentSource } from '../model-source.ts';
	import {
		agentAccountOptions as otherAgentAccountOptions,
		agentAccountsOf,
		agentLabelOf,
		agentModelsOf,
		agentStatusOf,
		parseRunnerValue,
		runnerOptions,
		runnerValueOf
	} from '../runner-choice.ts';

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
		/** What the daemon finds of your other local agents (ADR 0079); null until asked, or away from the computer. */
		agents?: AgentsStatusResponse | null;
		agentsUnavailable?: boolean;
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
		agents = null,
		agentsUnavailable = false,
		onProfileInput,
		onProfilePick
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);

	const profileThinkingOptions = $derived(
		pinnableThinkingLevels(profileDraft.model, snapshot.providers)
	);

	const runnerChoices = $derived(runnerOptions(t, agents, profileDraft.runner ?? ''));
	const runnerPick = $derived(parseRunnerValue(profileDraft.runner));
	/** The local agent other than Claude this Bot runs on, when it does. */
	const agentRunner = $derived(runnerPick.runner && runnerPick.runner !== 'claude_code' ? runnerPick.runner : null);
	const agentKind = $derived(agentRunner ? AGENT_KINDS[agentRunner] : null);
	const agentStatus = $derived(agentRunner ? agentStatusOf(agents, agentRunner, runnerPick.customId) : null);
	const agentName = $derived(agentRunner ? agentLabelOf(agentRunner, runnerPick.customId, agents) : '');
	const agentEfforts = $derived(agentKind?.efforts ?? []);
	const agentAccounts = $derived(agentAccountsOf(agentStatus));
	/** The account it runs on, when that is one listed; the daemon's own environment while none is picked. */
	const agentAccount = $derived(agentAccounts.find((account) => account.config_dir === (profileDraft.agentConfigDir || null)) ?? null);
	const agentBlockerNow = $derived.by((): 'missing' | 'signed_out' | null => {
		if (!agentStatus) return null;
		if (!agentStatus.path) return 'missing';
		return (agentAccount ? agentAccount.logged_in : agentStatus.logged_in) === false ? 'signed_out' : null;
	});
	const otherLoginCommand = $derived(agentAccount?.login_command ?? agentStatus?.login_command ?? null);
	const agentAuth = $derived(agentAccount?.auth ?? agentStatus?.auth ?? null);
	const agentOtherAccountOptions = $derived(otherAgentAccountOptions(agentStatus, profileDraft.agentConfigDir ?? '', t));
	const agentModelChoices = $derived(agentModelsOf(agentStatus));
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

	/**
	 * Another agent names its models and accounts its own way, so moving the Bot clears them; an
	 * effort stays only where the new agent takes it. The daemon would refuse a model of one agent
	 * sent along with another.
	 */
	function onProfileRunnerChange(value: string): void {
		const next = parseRunnerValue(value);
		const before = parseRunnerValue(profileDraft.runner);
		profileDraft.runner = runnerValueOf(next.runner, next.customId);
		if (before.runner !== next.runner || before.customId !== next.customId) {
			profileDraft.agentModel = '';
			if (profileDraft.agentConfigDir !== undefined) profileDraft.agentConfigDir = '';
			if (!next.runner || !isAgentEffort(next.runner, profileDraft.agentEffort)) profileDraft.agentEffort = '';
		}
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
				value={profileDraft.runner ?? ''}
				options={runnerChoices}
				error={!!profileErrors.agentCustomId}
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
			{:else if agentRunner && agentKind}
				{#if profileErrors.agentCustomId}
					<p class="field-error">{t.sidebar.botRunnerCustomInvalid}</p>
				{:else if agentsUnavailable}
					<p class="muted field-hint">{t.sidebar.botRunnerAgentUnavailable(agentName)}</p>
				{:else if !agents}
					<p class="muted field-hint">{t.sidebar.botRunnerAgentChecking(agentName)}</p>
				{:else if agentBlockerNow === 'missing'}
					<p class="field-error" data-runner-missing>{t.sidebar.botRunnerAgentMissing(agentName, agentKind.command)}</p>
				{:else if agentBlockerNow === 'signed_out'}
					<p class="field-error" data-runner-signed-out>{t.sidebar.botRunnerAgentSignedOut(agentName, otherLoginCommand)}</p>
				{:else}
					<p class="muted field-hint" data-runner-account>{t.sidebar.botRunnerAgentHint(agentName, agentAuth)}</p>
				{/if}
				{#if !agentKind.appTools}
					<p class="muted field-hint" data-runner-note>{t.sidebar.botRunnerNoAppTools(agentName)}</p>
				{/if}
			{:else}
				<p class="muted field-hint">{t.sidebar.botRunnerAppHint}</p>
			{/if}
		</div>

		{#snippet effortPicker(levels: readonly string[], hint: string)}
		<div class="form-group">
			<span class="field-label" id="profile-agent-effort-label">{t.sidebar.botAgentEffort}</span>
			<div class="thinking-picker" role="radiogroup" aria-labelledby="profile-agent-effort-label">
				{#each ['', ...levels] as level (level)}
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
			<p class="muted field-hint">{hint}</p>
			{#if profileErrors.agentEffort}
				<p class="field-error">{t.sidebar.botAgentEffortInvalid}</p>
			{/if}
		</div>
		{/snippet}

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
		{@render effortPicker(AGENT_KINDS.claude_code.efforts, t.sidebar.botAgentEffortHint)}
		{:else if agentRunner && agentKind}
		{#if profileDraft.agentConfigDir !== undefined && agentKind.configDirVar && agentAccounts.length > 0}
		<div class="form-group" data-agent-account>
			<label for="profile-agent-account">{t.sidebar.botAgentAccountOf(agentName)}</label>
			<Select
				id="profile-agent-account"
				bind:value={profileDraft.agentConfigDir}
				options={agentOtherAccountOptions}
				error={!!profileErrors.agentConfigDir}
				onchange={onProfileAgentAccountChange}
			/>
			{#if profileErrors.agentConfigDir}
				<p class="field-error">{t.sidebar.botAgentAccountInvalid}</p>
			{:else}
				<p class="muted field-hint">{t.sidebar.botAgentAccountHintOf(agentName)}</p>
			{/if}
		</div>
		{/if}
		<div class="form-group" data-agent-model>
			<label for="profile-agent-model">{t.sidebar.botAgentModelOf(agentName)}</label>
			<!-- Typed, with the models the agent lists to pick from: an agent names its models its own way, and may take ones it never listed. -->
			<input
				id="profile-agent-model"
				type="text"
				list="profile-agent-models"
				autocomplete="off"
				spellcheck="false"
				aria-invalid={!!profileErrors.agentModel}
				bind:value={profileDraft.agentModel}
				oninput={onProfileInput}
				placeholder={agentStatus?.default_model ?? t.sidebar.botAgentModelDefaultOf(agentName)}
			/>
			<datalist id="profile-agent-models">
				{#each agentModelChoices as choice (choice.id)}
					<option value={choice.id} label={choice.name !== choice.id ? choice.name : undefined}></option>
				{/each}
			</datalist>
			{#if profileErrors.agentModel}
				<p class="field-error">{t.sidebar.botAgentModelInvalidOf(agentName)}</p>
			{:else}
				<p class="muted field-hint">{t.sidebar.botAgentModelEmptyHint(agentName, agentStatus?.default_model ?? null)}</p>
			{/if}
		</div>
		{#if agentEfforts.length > 0}
			{@render effortPicker(agentEfforts, t.sidebar.botAgentEffortHintOf(agentName))}
		{:else}
			<p class="muted field-hint" data-agent-no-effort>{t.sidebar.botAgentNoEffort(agentName)}</p>
		{/if}
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
