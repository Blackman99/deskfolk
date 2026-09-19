<script lang="ts">
	import { untrack } from 'svelte';
	import type { Bot } from '@real-bot/protocol';
	import AvatarEditor from '../AvatarEditor.svelte';
	import Select from '../Select.svelte';
	import { thinkingLevelLabel, type Copy } from '../copy.ts';
	import {
		applyModelPin,
		botNameErrorCopy,
		emptySkillDraft,
		formatSkillUses,
		mapCreateBotError,
		mapSkillError,
		pinnableThinkingLevels,
		planCreateBot,
		planSkill,
		reconcileSkillDraft,
		skillDraftDirty,
		type CreateBotFieldErrors,
		type SkillDraft,
		type SkillFieldErrors
	} from './create-form.ts';
	import { modelSelectValue, type ProviderEditorState } from '../settings/provider-form.ts';
	import {
		profileDraftDirty,
		profileNeedsSave,
		reconcileProfileDraft,
		type ProfileFields
	} from './roster-edit.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { SelectOption } from '../select-options.ts';

	type Props = {
		runtime: MessengerRuntime;
		/** Keyed on by the shell, so switching Bots remounts this pane rather than reconciling. */
		bot: Bot;
		t: Copy;
		modelOptions: SelectOption[];
		selectedKind: string | null;
		/** The shell's delete writes this too, so it stays there. */
		profileFailed: boolean;
		openDangerConfirm: (kind: 'skill', run: () => Promise<void>) => void;
		clearDanger: (kind: 'skill') => void;
		onDeleteBot: () => void;
		onClearHistory: () => void;
	};

	let {
		runtime,
		bot,
		t,
		modelOptions,
		selectedKind,
		profileFailed = $bindable(false),
		openDangerConfirm,
		clearDanger,
		onDeleteBot,
		onClearHistory
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const modelValues = $derived(modelOptions.map((option) => option.value));
	const profileSkills = $derived(snapshot.skills.filter((skill) => skill.bot_id === bot.id));

	function botModelValue(row: Bot): string {
		if (!row.model) return '';
		if (row.provider_id) return modelSelectValue(row.provider_id, row.model);
		const match = runtime.snapshot.providers.find((p) => p.models.includes(row.model!));
		return match ? modelSelectValue(match.id, row.model) : row.model;
	}

	function emptyProfile(row: Bot): ProfileFields {
		return {
			name: row.name,
			duties: row.duties,
			boundaries: row.boundaries,
			avatar: row.avatar ?? '',
			model: botModelValue(row),
			thinkingLevel: row.thinking_level ?? ''
		};
	}

	// A fresh mount is the reset: the shell keys this pane on the Bot it is showing, so reading
	// `bot` once here is the point — the draft must not follow the prop after that.
	let profileDraft = $state<ProfileFields>(untrack(() => emptyProfile(bot)));
	let profileBaseline = $state<ProfileFields>(untrack(() => emptyProfile(bot)));
	let profileErrors = $state<CreateBotFieldErrors>({});
	let profileSaving = $state(false);
	/** Bumped on every accepted save so the header can say 「已自动保存」. */
	let profileSavedTick = $state(0);
	let profileSaveTimer: ReturnType<typeof setTimeout> | null = null;
	/** The Bot the current draft belongs to; a save resolving after a switch must not touch the new draft. */
	let profileSaveBotId: string | null = null;
	let profileSaveQueued = false;

	let skillEditor = $state<'add' | string | null>(null);
	let skillDraft = $state<SkillDraft>(emptySkillDraft());
	let skillBaseline = $state<SkillDraft>(emptySkillDraft());
	let skillErrors = $state<SkillFieldErrors>({});
	let skillFailed = $state(false);
	let skillBusy = $state(false);

	const profileThinkingOptions = $derived(
		pinnableThinkingLevels(profileDraft.model, snapshot.providers)
	);

	// Closing the drawer or switching Bots unmounts this pane; a pending autosave goes out first.
	$effect(() => () => flushProfileSave());

	/** Server-side edits (a Bot changing its own profile) land in the draft unless you are editing. */
	$effect(() => {
		const live = snapshot.bots.find((row) => row.id === bot.id);
		if (!live) {
			runtime.profileBotId = null;
			return;
		}
		const incoming = {
			name: live.name,
			duties: live.duties,
			boundaries: live.boundaries,
			avatar: live.avatar ?? '',
			model: botModelValue(live),
			thinkingLevel: live.thinking_level ?? ''
		};
		const next = reconcileProfileDraft(profileDraft, profileBaseline, incoming);
		if (profileDraftDirty(profileDraft, next.draft)) profileDraft = next.draft;
		if (profileDraftDirty(profileBaseline, next.baseline)) profileBaseline = next.baseline;
		if (skillEditor && skillEditor !== 'add') {
			const liveSkill = snapshot.skills.find((skill) => skill.id === skillEditor);
			if (!liveSkill || liveSkill.bot_id !== live.id) {
				closeSkillEditor();
			} else {
				const incomingSkill = {
					name: liveSkill.name,
					description: liveSkill.description,
					body: liveSkill.body,
					uses: formatSkillUses(liveSkill.uses),
					enabled: liveSkill.enabled
				};
				const nextSkill = reconcileSkillDraft(skillDraft, skillBaseline, incomingSkill);
				if (skillDraftDirty(skillDraft, nextSkill.draft)) skillDraft = nextSkill.draft;
				if (skillDraftDirty(skillBaseline, nextSkill.baseline)) skillBaseline = nextSkill.baseline;
			}
		}
	});

	function closeSkillEditor(): void {
		skillEditor = null;
		skillDraft = emptySkillDraft();
		skillBaseline = emptySkillDraft();
		skillErrors = {};
		skillFailed = false;
		skillBusy = false;
		clearDanger('skill');
	}

	function openAddSkill(): void {
		skillEditor = 'add';
		skillDraft = emptySkillDraft();
		skillBaseline = emptySkillDraft();
		skillErrors = {};
		skillFailed = false;
	}

	function openEditSkill(id: string): void {
		const skill = snapshot.skills.find((row) => row.id === id);
		if (!skill) return;
		skillEditor = id;
		skillDraft = {
			name: skill.name,
			description: skill.description,
			body: skill.body,
			uses: formatSkillUses(skill.uses),
			enabled: skill.enabled
		};
		skillBaseline = { ...skillDraft };
		skillErrors = {};
		skillFailed = false;
	}

	function skillNameCopy(kind: 'empty' | 'conflict' | undefined): string {
		if (kind === 'conflict') return t.sidebar.skillNameConflict;
		return t.sidebar.skillNameEmpty;
	}

	async function saveSkill(): Promise<void> {
		if (!runtime.profileBotId || !skillEditor) return;
		skillFailed = false;
		skillErrors = {};
		const plan = planSkill(skillDraft);
		if (!plan.ok) {
			skillErrors = plan.errors;
			return;
		}
		skillBusy = true;
		const error =
			skillEditor === 'add'
				? await runtime.createSkill({ bot_id: runtime.profileBotId, ...plan.body })
				: await runtime.patchSkill(skillEditor, plan.body);
		skillBusy = false;
		if (!error) {
			closeSkillEditor();
			return;
		}
		const mapped = mapSkillError(error.status, error.message);
		if ('top' in mapped) skillFailed = true;
		else skillErrors = mapped;
	}

	async function toggleSkillEnabled(id: string, enabled: boolean): Promise<void> {
		skillFailed = false;
		const error = await runtime.patchSkill(id, { enabled });
		if (error) skillFailed = true;
	}

	function openDeleteSkillConfirm(id: string): void {
		openDangerConfirm('skill', () => deleteSkillRow(id));
	}

	async function deleteSkillRow(skillId: string): Promise<void> {
		skillFailed = false;
		const error = await runtime.deleteSkill(skillId);
		if (error) {
			skillFailed = true;
			return;
		}
		if (skillEditor === skillId) closeSkillEditor();
		clearDanger('skill');
	}

	function onProfileInput(): void {
		profileErrors = {};
		profileFailed = false;
		scheduleProfileSave();
	}

	/** Picks (model, thinking level, avatar) are deliberate, so they save almost at once. */
	function onProfilePick(): void {
		profileErrors = {};
		profileFailed = false;
		scheduleProfileSave(120);
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

	function scheduleProfileSave(delay = 600): void {
		if (!runtime.profileBotId) return;
		profileSaveBotId = runtime.profileBotId;
		if (profileSaveTimer) clearTimeout(profileSaveTimer);
		profileSaveTimer = setTimeout(() => {
			profileSaveTimer = null;
			void saveProfile();
		}, delay);
	}

	/** Sends a pending autosave now: on close, on switching Bots, or when the panel goes away. */
	function flushProfileSave(): void {
		if (!profileSaveTimer) return;
		clearTimeout(profileSaveTimer);
		profileSaveTimer = null;
		void saveProfile();
	}

	async function saveProfile(): Promise<void> {
		const botId = profileSaveBotId;
		if (!botId) return;
		if (profileSaving) {
			profileSaveQueued = true;
			return;
		}
		const sent: ProfileFields = { ...profileDraft };
		if (!profileNeedsSave(sent, profileBaseline)) return;
		const plan = planCreateBot(sent, modelValues);
		if (!plan.ok) {
			if (profileSaveBotId === botId) profileErrors = plan.errors;
			return;
		}
		profileSaving = true;
		profileFailed = false;
		profileErrors = {};
		const error = await runtime.patchBot(botId, plan.body);
		profileSaving = false;
		const stillHere = profileSaveBotId === botId && runtime.profileBotId === botId;
		if (!error) {
			if (stillHere) {
				profileBaseline = sent;
				profileSavedTick += 1;
			}
		} else if (stillHere) {
			const mapped = mapCreateBotError(error.status, error.message);
			if ('top' in mapped) profileFailed = true;
			else profileErrors = mapped;
		}
		if (profileSaveQueued) {
			profileSaveQueued = false;
			void saveProfile();
		}
	}

	async function archiveProfile(): Promise<void> {
		if (!runtime.profileBotId) return;
		profileFailed = false;
		const error = await runtime.archiveBot(runtime.profileBotId);
		if (error) profileFailed = true;
	}

	async function restoreProfile(): Promise<void> {
		if (!runtime.profileBotId) return;
		profileFailed = false;
		const error = await runtime.restoreBot(runtime.profileBotId);
		if (error) profileFailed = true;
	}
</script>

{#if profileFailed}
	<div class="panel-alert is-error">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
		<span>{t.sidebar.saveFailed}</span>
	</div>
{/if}

<div class="panel-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{t.sidebar.botAvatar}</span>
	</div>
	<div class="panel-card-body">
		<AvatarEditor bind:avatar={profileDraft.avatar} name={profileDraft.name} {t} onchange={onProfilePick} />
	</div>
</div>

<div class="panel-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{t.top.profile}</span>
		<span class="profile-save-state" class:is-error={profileFailed} aria-live="polite">
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
				bind:value={profileDraft.duties}
				oninput={onProfileInput}
				rows="3"
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
				bind:value={profileDraft.boundaries}
				oninput={onProfileInput}
				rows="3"
				placeholder={t.sidebar.botBoundaries}
			></textarea>
			{#if profileErrors.boundaries}
				<p class="field-error">{t.sidebar.boundariesEmpty}</p>
			{/if}
		</div>

		<div class="form-group">
			<label for="profile-model">{t.sidebar.botModel}</label>
			<Select
				id="profile-model"
				bind:value={profileDraft.model}
				placeholder={t.sidebar.botModelDefault}
				emptyLabel={t.sidebar.botModelDefault}
				options={modelOptions}
				error={!!profileErrors.model}
				onchange={onProfileModelChange}
			/>
			{#if profileErrors.model}
				<p class="field-error">{t.sidebar.botModelInvalid}</p>
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
	</div>
</div>

<div class="panel-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{t.sidebar.skills}</span>
		<span class="panel-counter-badge">{profileSkills.length}</span>
	</div>
	<div class="panel-card-body skill-card-body">
		{#if skillFailed && !skillEditor}
			<p class="field-error" role="alert">{t.sidebar.saveFailed}</p>
		{/if}
		{#if profileSkills.length === 0 && !skillEditor}
			<p class="muted skill-empty">{t.sidebar.skillsEmpty}</p>
		{/if}
		{#each profileSkills as skill (skill.id)}
			<div class="skill-row" class:is-disabled={!skill.enabled} class:is-open={skillEditor === skill.id}>
				<button
					type="button"
					class="skill-open"
					aria-label={`${t.sidebar.skillEdit}: ${skill.name}`}
					onclick={() => openEditSkill(skill.id)}
				>
					<span class="skill-name" title={skill.name}>{skill.name}</span>
					<span class="skill-desc" title={skill.description}>{skill.description}</span>
				</button>
				<label class="mcp-enable-label">
					<input
						type="checkbox"
						aria-label={`${t.sidebar.skillEnabled}: ${skill.name}`}
						checked={skill.enabled}
						onchange={(event) => {
							event.currentTarget.checked = skill.enabled;
							void toggleSkillEnabled(skill.id, !skill.enabled);
						}}
					/>
					{t.sidebar.skillEnabled}
				</label>
			</div>
		{/each}
		{#if skillEditor}
			<div class="skill-editor">
				<p class="muted skill-editor-title">
					{skillEditor === 'add' ? t.sidebar.skillAdd : t.sidebar.skillEdit}
				</p>
				{#if skillFailed}
					<p class="field-error" role="alert">{t.sidebar.saveFailed}</p>
				{/if}
				<div class="form-group">
					<label for="skill-name">{t.sidebar.skillName}</label>
					<input
						id="skill-name"
						type="text"
						bind:value={skillDraft.name}
						disabled={skillBusy}
					/>
					{#if skillErrors.name}
						<p class="field-error">{skillNameCopy(skillErrors.name)}</p>
					{/if}
				</div>
				<div class="form-group">
					<label for="skill-description">{t.sidebar.skillDescription}</label>
					<textarea
						id="skill-description"
						bind:value={skillDraft.description}
						rows="2"
						disabled={skillBusy}
					></textarea>
					{#if skillErrors.description}
						<p class="field-error">{t.sidebar.skillDescriptionEmpty}</p>
					{/if}
				</div>
				<div class="form-group">
					<label for="skill-body">{t.sidebar.skillBody}</label>
					<textarea
						id="skill-body"
						bind:value={skillDraft.body}
						rows="6"
						disabled={skillBusy}
					></textarea>
					{#if skillErrors.body}
						<p class="field-error">{t.sidebar.skillBodyEmpty}</p>
					{/if}
				</div>
				<div class="form-group">
					<label for="skill-uses">{t.sidebar.skillUses}</label>
					<input
						id="skill-uses"
						type="text"
						bind:value={skillDraft.uses}
						placeholder={t.sidebar.skillUsesPlaceholder}
						disabled={skillBusy}
					/>
					<p class="muted skill-editor-hint">{t.sidebar.skillUsesHint}</p>
				</div>
				<label class="mcp-enable-label skill-editor-enabled">
					<input type="checkbox" bind:checked={skillDraft.enabled} disabled={skillBusy} />
					{t.sidebar.skillEnabled}
				</label>
				<div class="skill-editor-actions">
					<button type="button" class="btn-primary" disabled={skillBusy} onclick={() => void saveSkill()}>
						{t.sidebar.skillSave}
					</button>
					<button type="button" class="btn-secondary" disabled={skillBusy} onclick={closeSkillEditor}>
						{t.sidebar.skillCancel}
					</button>
					{#if skillEditor !== 'add'}
						<button
							type="button"
							class="deny"
							disabled={skillBusy}
							onclick={() => openDeleteSkillConfirm(skillEditor as string)}
						>
							{t.sidebar.skillDelete}
						</button>
					{/if}
				</div>
			</div>
		{:else}
			<button type="button" class="btn-secondary skill-add" onclick={openAddSkill}>
				{t.sidebar.skillAdd}
			</button>
		{/if}
	</div>
</div>

<div class="panel-card danger-zone-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{#if selectedKind === 'you-bot'}{t.sidebar.archive} / {t.detail.clearHistory} / {t.sidebar.delete}{:else}{t.sidebar.archive} / {t.sidebar.delete}{/if}</span>
	</div>
	<div class="panel-card-body">
		<div class="bot-management-actions">
			{#if bot.archived_at}
				<button type="button" class="btn-secondary" onclick={() => void restoreProfile()}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
					<span>{t.sidebar.restore}</span>
				</button>
			{:else}
				<button type="button" class="btn-secondary" onclick={() => void archiveProfile()}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
					<span>{t.sidebar.archive}</span>
				</button>
			{/if}

			{#if selectedKind === 'you-bot'}
				<button type="button" class="btn-secondary btn-history-clear" onclick={onClearHistory}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
					<span>{t.detail.clearHistory}</span>
				</button>
			{/if}

			<button type="button" class="deny" onclick={onDeleteBot}>
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
				<span>{t.sidebar.delete}</span>
			</button>
		</div>
	</div>
</div>

<style>
	/* The skill list. It lived in `route-log.css` only because the sheet was cut by line range. */
	.skill-card-body {
	  display: flex;
	  flex-direction: column;
	  gap: 8px;
	}

	.skill-empty {
	  margin: 0;
	  font-size: 13px;
	}

	.skill-row {
	  display: flex;
	  align-items: center;
	  gap: 12px;
	  min-width: 0;
	  padding-right: 12px;
	  border: 1px solid var(--line);
	  border-radius: var(--radius-md);
	  background: var(--pane);
	}

	.skill-row:hover,
	.skill-row:focus-within {
	  border-color: var(--accent-border);
	}

	.skill-row.is-disabled {
	  background: var(--sidebar-bg);
	}

	.skill-row.is-open {
	  border-color: var(--accent-border);
	}

	.skill-open {
	  display: flex;
	  flex-direction: column;
	  gap: 4px;
	  flex: 1;
	  min-width: 0;
	  padding: 12px;
	  border: 0;
	  border-radius: var(--radius-md);
	  background: transparent;
	  text-align: left;
	  color: var(--ink);
	  cursor: pointer;
	}

	.skill-name,
	.skill-desc {
	  overflow: hidden;
	  text-overflow: ellipsis;
	  white-space: nowrap;
	  max-width: 100%;
	}

	.skill-name {
	  font-size: 13.5px;
	  font-weight: 600;
	}

	.skill-desc {
	  font-size: 12px;
	  color: var(--muted);
	}

	.skill-row .mcp-enable-label {
	  flex-shrink: 0;
	  white-space: nowrap;
	  font-size: 12px;
	}

	.skill-editor {
	  display: flex;
	  flex-direction: column;
	  gap: 10px;
	  padding-top: 8px;
	  border-top: 1px solid var(--line-subtle);
	}

	.skill-editor-title {
	  margin: 0;
	  font-size: 12px;
	  font-weight: 600;
	  text-transform: uppercase;
	  letter-spacing: 0.04em;
	}

	.skill-editor-enabled {
	  margin-top: 2px;
	}

	.skill-editor-hint {
	  margin: 4px 0 0;
	  font-size: 12px;
	  line-height: 1.45;
	}

	.skill-editor-actions {
	  display: flex;
	  flex-wrap: wrap;
	  gap: 8px;
	}

	.skill-add {
	  align-self: flex-start;
	}

	/* Profile panel: autosave state + thinking-level quick picker */
	.profile-save-state {
		margin-left: auto;
		font-size: 12px;
		color: var(--muted);
		white-space: nowrap;
	}

	.profile-save-state.is-error {
		color: var(--danger-text);
	}

	.bot-management-actions {
		display: flex;
		gap: 8px;
	}

	.bot-management-actions :global(button) {
		flex: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 8px 12px;
		font-size: 12.5px;
		font-weight: 600;
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.bot-management-actions :global(.btn-secondary) {
		background: var(--btn-secondary-bg);
		border: 1px solid var(--line);
		color: var(--ink-secondary);
	}

	.bot-management-actions :global(.btn-secondary:hover) {
		background: var(--line-subtle);
		border-color: var(--line-hover);
		color: var(--ink);
	}
</style>
