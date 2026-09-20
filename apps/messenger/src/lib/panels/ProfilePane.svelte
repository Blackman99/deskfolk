<script lang="ts">
	import MemoryCard from './MemoryCard.svelte';
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
		initialTab?: 'basics' | 'skills' | 'memory' | 'actions';
		openDangerConfirm: (kind: 'skill' | 'memory', run: () => Promise<void>) => void;
		clearDanger: (kind: 'skill' | 'memory') => void;
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
		initialTab = 'basics',
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

	export type BotTab = 'basics' | 'skills' | 'memory' | 'actions';
	let activeTab = $state<BotTab>(untrack(() => initialTab));

	const basicsHasError = $derived(
		Boolean(
			profileErrors.name ||
			profileErrors.duties ||
			profileErrors.boundaries ||
			profileErrors.model ||
			profileErrors.thinkingLevel
		)
	);

	function switchTab(tab: BotTab): void {
		if (activeTab === tab) return;
		flushProfileSave();
		activeTab = tab;
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (skillEditor && e.key === 'Escape' && !skillBusy) {
			e.stopPropagation();
			closeSkillEditor();
		}
	}}
/>

<div class="bot-nav-sticky">
	<div class="bot-tabs" role="tablist" aria-label={t.detail.titleBot}>
		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'basics'}
			class="bot-tab-btn"
			class:is-active={activeTab === 'basics'}
			onclick={() => switchTab('basics')}
		>
			<svg class="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
				<circle cx="12" cy="7" r="4"></circle>
			</svg>
			<span class="tab-name">{t.detail.botTabBasics}</span>
			{#if basicsHasError}
				<span class="tab-badge-error" aria-label="error">!</span>
			{/if}
		</button>

		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'skills'}
			class="bot-tab-btn"
			class:is-active={activeTab === 'skills'}
			onclick={() => switchTab('skills')}
		>
			<svg class="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
			</svg>
			<span class="tab-name">{t.detail.botTabSkills}</span>
			{#if profileSkills.length > 0}
				<span class="tab-count">{profileSkills.length}</span>
			{/if}
		</button>

		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'memory'}
			class="bot-tab-btn"
			class:is-active={activeTab === 'memory'}
			onclick={() => switchTab('memory')}
		>
			<svg class="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
				<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
			</svg>
			<span class="tab-name">{t.detail.botTabMemory}</span>
		</button>

		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'actions'}
			class="bot-tab-btn"
			class:is-active={activeTab === 'actions'}
			onclick={() => switchTab('actions')}
		>
			<svg class="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<circle cx="12" cy="12" r="3"></circle>
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
			</svg>
			<span class="tab-name">{t.detail.botTabActions}</span>
		</button>
	</div>
</div>

{#if profileFailed}
	<div class="panel-alert is-error">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
		<span>{t.sidebar.saveFailed}</span>
	</div>
{/if}

{#if activeTab === 'basics'}
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
{:else if activeTab === 'skills'}
<div class="panel-card">
	<div class="panel-card-head">
		<div class="flex items-center gap-2">
			<span class="panel-card-title">{t.sidebar.skills}</span>
			<span class="panel-counter-badge">{profileSkills.length}</span>
		</div>
		<button
			type="button"
			class="skill-head-add-btn"
			onclick={openAddSkill}
			title={t.sidebar.skillAdd}
			aria-label={t.sidebar.skillAdd}
		>
			<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
				<line x1="12" y1="5" x2="12" y2="19"></line>
				<line x1="5" y1="12" x2="19" y2="12"></line>
			</svg>
			<span>{t.sidebar.skillAdd}</span>
		</button>
	</div>
	<div class="panel-card-body skill-card-body flex flex-col gap-3">
		{#if skillFailed && !skillEditor}
			<p class="field-error" role="alert">{t.sidebar.saveFailed}</p>
		{/if}
		{#if profileSkills.length === 0}
			<div class="skill-empty-card">
				<div class="skill-empty-icon">
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
					</svg>
				</div>
				<p class="skill-empty-text">{t.sidebar.skillsEmpty}</p>
				<button type="button" class="btn-secondary skill-empty-add-btn" onclick={openAddSkill}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<line x1="12" y1="5" x2="12" y2="19"></line>
						<line x1="5" y1="12" x2="19" y2="12"></line>
					</svg>
					<span>{t.sidebar.skillAdd}</span>
				</button>
			</div>
		{/if}
		{#each profileSkills as skill (skill.id)}
			<div class="skill-row" class:is-disabled={!skill.enabled} class:is-open={skillEditor === skill.id}>
				<button
					type="button"
					class="skill-open"
					aria-label={`${t.sidebar.skillEdit}: ${skill.name}`}
					onclick={() => openEditSkill(skill.id)}
				>
					<div class="skill-row-icon" class:is-disabled={!skill.enabled}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
						</svg>
					</div>
					<div class="skill-row-content">
						<div class="skill-row-title-line">
							<span class="skill-name" title={skill.name}>{skill.name}</span>
							{#if skill.uses && skill.uses.length > 0}
								<span class="skill-uses-badge" title={skill.uses.join(', ')}>MCP</span>
							{/if}
						</div>
						<span class="skill-desc" title={skill.description}>{skill.description}</span>
					</div>
				</button>
				<div class="skill-row-actions">
					<label class="mcp-enable-label" title={t.sidebar.skillEnabled}>
						<input
							type="checkbox"
							aria-label={`${t.sidebar.skillEnabled}: ${skill.name}`}
							checked={skill.enabled}
							onchange={(event) => {
								event.currentTarget.checked = skill.enabled;
								void toggleSkillEnabled(skill.id, !skill.enabled);
							}}
						/>
						<span class="skill-enable-text">{t.sidebar.skillEnabled}</span>
					</label>
					<button
						type="button"
						class="skill-action-btn edit"
						aria-label={`${t.sidebar.skillEdit}: ${skill.name}`}
						title={t.sidebar.skillEdit}
						onclick={() => openEditSkill(skill.id)}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
						</svg>
					</button>
					<button
						type="button"
						class="skill-action-btn delete"
						aria-label={`${t.sidebar.skillDelete}: ${skill.name}`}
						title={t.sidebar.skillDelete}
						onclick={() => openDeleteSkillConfirm(skill.id)}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="3 6 5 6 21 6"></polyline>
							<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
						</svg>
					</button>
				</div>
			</div>
		{/each}
	</div>
</div>
{:else if activeTab === 'memory'}
<MemoryCard {runtime} {bot} {t} {openDangerConfirm} {clearDanger} />
{:else if activeTab === 'actions'}
<div class="panel-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{t.detail.sessionActions}</span>
	</div>
	<div class="panel-card-body">
		<div class="action-list-row">
			<div class="action-list-info">
				<span class="action-list-title">{bot.archived_at ? t.sidebar.restore : t.sidebar.archive}</span>
				<span class="action-list-desc">{bot.archived_at ? t.sidebar.restoreBody : t.sidebar.archiveBody}</span>
			</div>
			{#if bot.archived_at}
				<button type="button" class="btn-secondary action-btn" onclick={() => void restoreProfile()}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
					<span>{t.sidebar.restore}</span>
				</button>
			{:else}
				<button type="button" class="btn-secondary action-btn" onclick={() => void archiveProfile()}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
					<span>{t.sidebar.archive}</span>
				</button>
			{/if}
		</div>
	</div>
</div>

<div class="panel-card danger-zone-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{t.detail.dangerZone}</span>
	</div>
	<div class="panel-card-body">
		<div class="action-list-stack flex flex-col gap-6">
			{#if selectedKind === 'you-bot'}
				<div class="action-list-row">
					<div class="action-list-info">
						<span class="action-list-title">{t.detail.clearHistory}</span>
						<span class="action-list-desc">{t.detail.clearHistoryBody}</span>
					</div>
					<button
						type="button"
						class="btn-secondary btn-history-clear action-btn"
						onclick={onClearHistory}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
						<span>{t.detail.clearHistory}</span>
					</button>
				</div>
			{/if}

			<div class="action-list-row is-danger">
				<div class="action-list-info">
					<span class="action-list-title text-danger">{t.sidebar.delete}</span>
					<span class="action-list-desc">{t.sidebar.deleteBody}</span>
				</div>
				<button type="button" class="deny action-btn" onclick={onDeleteBot}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
					<span>{t.sidebar.delete}</span>
				</button>
			</div>
		</div>
	</div>
</div>
{/if}

{#if skillEditor}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal-backdrop skill-modal-backdrop"
		role="dialog"
		aria-modal="true"
		aria-labelledby="skill-modal-title"
		tabindex="-1"
		onclick={(e) => {
			e.stopPropagation();
			if (e.target === e.currentTarget && !skillBusy) closeSkillEditor();
		}}
		onpointerdown={(e) => e.stopPropagation()}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="modal-dialog skill-modal"
			onclick={(e) => e.stopPropagation()}
			onpointerdown={(e) => e.stopPropagation()}
		>
			<div class="modal-head">
				<h2 id="skill-modal-title">
					{skillEditor === 'add' ? t.sidebar.skillAdd : t.sidebar.skillEdit}
				</h2>
				<button
					type="button"
					class="modal-close"
					title={t.common.close}
					disabled={skillBusy}
					onclick={closeSkillEditor}
				>✕</button>
			</div>
			<div class="modal-body skill-modal-body">
				{#if skillFailed}
					<div class="panel-alert is-error" role="alert">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="10"></circle>
							<line x1="12" y1="8" x2="12" y2="12"></line>
							<line x1="12" y1="16" x2="12.01" y2="16"></line>
						</svg>
						<span>{t.sidebar.saveFailed}</span>
					</div>
				{/if}

				<div class="form-group">
					<label for="skill-name" class="field-label">
						{t.sidebar.skillName} <span class="required-star">*</span>
					</label>
					<input
						id="skill-name"
						type="text"
						bind:value={skillDraft.name}
						placeholder="例如：web_search, git_commit"
						disabled={skillBusy}
					/>
					{#if skillErrors.name}
						<p class="field-error">{skillNameCopy(skillErrors.name)}</p>
					{/if}
				</div>

				<div class="form-group">
					<label for="skill-description" class="field-label">
						{t.sidebar.skillDescription} <span class="required-star">*</span>
					</label>
					<textarea
						id="skill-description"
						bind:value={skillDraft.description}
						rows="2"
						placeholder="描述此技能适用的场景或触发条件"
						disabled={skillBusy}
					></textarea>
					{#if skillErrors.description}
						<p class="field-error">{t.sidebar.skillDescriptionEmpty}</p>
					{/if}
				</div>

				<div class="form-group">
					<label for="skill-body" class="field-label">
						{t.sidebar.skillBody} <span class="required-star">*</span>
					</label>
					<textarea
						id="skill-body"
						class="skill-body-textarea"
						bind:value={skillDraft.body}
						rows="7"
						placeholder="输入具体的 Markdown 指令、规则或提示词内容"
						disabled={skillBusy}
					></textarea>
					{#if skillErrors.body}
						<p class="field-error">{t.sidebar.skillBodyEmpty}</p>
					{/if}
				</div>

				<div class="form-group">
					<label for="skill-uses" class="field-label">{t.sidebar.skillUses}</label>
					<input
						id="skill-uses"
						type="text"
						bind:value={skillDraft.uses}
						placeholder={t.sidebar.skillUsesPlaceholder}
						disabled={skillBusy}
					/>
					<p class="muted field-hint">{t.sidebar.skillUsesHint}</p>
				</div>

				<div class="skill-modal-enable-row">
					<label class="mcp-enable-label">
						<input type="checkbox" bind:checked={skillDraft.enabled} disabled={skillBusy} />
						<span>{t.sidebar.skillEnabled}</span>
					</label>
				</div>
			</div>

			<div class="modal-foot skill-modal-foot">
				<div class="skill-modal-foot-left">
					{#if skillEditor !== 'add'}
						<button
							type="button"
							class="deny skill-delete-btn"
							disabled={skillBusy}
							onclick={() => openDeleteSkillConfirm(skillEditor as string)}
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<polyline points="3 6 5 6 21 6"></polyline>
								<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
							</svg>
							<span>{t.sidebar.skillDelete}</span>
						</button>
					{/if}
				</div>
				<div class="skill-modal-foot-right">
					<button type="button" class="btn-cancel" disabled={skillBusy} onclick={closeSkillEditor}>
						{t.sidebar.skillCancel}
					</button>
					<button type="button" class="btn-primary" disabled={skillBusy} onclick={() => void saveSkill()}>
						{t.sidebar.skillSave}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.bot-nav-sticky {
		position: sticky;
		top: 0;
		z-index: 10;
		margin-top: -20px;
		padding-top: 8px;
		padding-bottom: 8px;
		background: var(--bg);
	}

	.bot-tabs {
		display: flex;
		align-items: center;
		width: 100%;
		gap: 3px;
		padding: 3px;
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-sizing: border-box;
	}

	.bot-tab-btn {
		flex: 1 1 0;
		min-width: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		padding: 6px 4px;
		border-radius: var(--radius-sm);
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-secondary);
		background: transparent;
		border: none;
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.15s ease;
		line-height: 1.2;
		box-sizing: border-box;
	}

	.bot-tab-btn:hover {
		color: var(--ink);
		background: var(--chip);
	}

	.bot-tab-btn.is-active {
		color: var(--ink);
		font-weight: 600;
		background: var(--pane);
		box-shadow: var(--shadow-sm);
	}

	.bot-tab-btn .tab-icon {
		color: var(--muted);
		flex-shrink: 0;
		transition: color 0.15s ease;
	}

	.bot-tab-btn.is-active .tab-icon {
		color: var(--accent);
	}

	.bot-tab-btn .tab-badge-error {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 9999px;
		background: var(--danger);
		color: #ffffff;
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		margin-left: 2px;
	}

	.bot-tab-btn .tab-count {
		font-size: 10.5px;
		font-weight: 600;
		padding: 0 5px;
		border-radius: 9999px;
		background: var(--chip);
		color: var(--ink-secondary);
		line-height: 15px;
	}

	.bot-tab-btn.is-active .tab-count {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.skill-head-add-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ink-secondary);
		background: var(--btn-secondary-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: all 0.15s ease;
		line-height: 1;
	}

	.skill-head-add-btn:hover {
		background: var(--line-subtle);
		border-color: var(--accent);
		color: var(--accent);
	}

	.skill-empty-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 20px 16px;
		border: 1px dashed var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
		text-align: center;
		gap: 8px;
	}

	.skill-empty-icon {
		color: var(--muted);
		opacity: 0.7;
	}

	.skill-empty-text {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
	}

	.skill-empty-add-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 600;
		margin-top: 2px;
	}

	.skill-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		padding: 6px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		transition: all 0.15s ease;
	}

	.skill-row:hover,
	.skill-row:focus-within {
		border-color: var(--accent-border);
		box-shadow: 0 1px 4px rgba(15, 23, 42, 0.04);
	}

	.skill-row.is-disabled {
		opacity: 0.65;
		background: var(--sidebar-bg);
	}

	.skill-row.is-open {
		border-color: var(--accent);
	}

	.skill-open {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 1;
		min-width: 0;
		padding: 4px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		text-align: left;
		color: var(--ink);
		cursor: pointer;
	}

	.skill-row-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		background: var(--accent-tint, rgba(37, 99, 235, 0.08));
		color: var(--accent);
		flex-shrink: 0;
		transition: all 0.15s ease;
	}

	.skill-row-icon.is-disabled {
		background: var(--line-subtle);
		color: var(--muted);
	}

	.skill-row-content {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.skill-row-title-line {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.skill-name {
		font-size: 13px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
		color: var(--ink);
	}

	.skill-open:hover .skill-name {
		color: var(--accent);
	}

	.skill-uses-badge {
		font-size: 9.5px;
		font-weight: 700;
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--line-subtle);
		color: var(--ink-secondary);
		border: 1px solid var(--line);
		text-transform: uppercase;
		flex-shrink: 0;
	}

	.skill-desc {
		font-size: 11.5px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 100%;
	}

	.skill-row-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.skill-row .mcp-enable-label {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		color: var(--ink-secondary);
		cursor: pointer;
		user-select: none;
		margin: 0;
		padding-right: 4px;
	}

	.skill-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		color: var(--ink-secondary);
		cursor: pointer;
		transition: all 0.15s ease;
		padding: 0;
	}

	.skill-action-btn:hover {
		background: var(--line-subtle);
		color: var(--ink);
		border-color: var(--line-hover);
	}

	.skill-action-btn.edit:hover {
		border-color: var(--accent);
		color: var(--accent);
	}

	.skill-action-btn.delete:hover {
		background: var(--danger-bg);
		border-color: var(--danger-line);
		color: var(--danger);
	}

	/* Modal Dialog Styles */
	.skill-modal-backdrop {
		z-index: 105;
	}

	.modal-dialog.skill-modal {
		width: 520px;
		max-width: 94vw;
		max-height: 88vh;
		display: flex;
		flex-direction: column;
	}

	.skill-modal-body {
		padding: 18px 22px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		overflow-y: auto;
	}

	.skill-modal-body .form-group {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.skill-modal-body .field-label {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink-secondary);
		margin: 0;
	}

	.required-star {
		color: var(--danger);
		font-weight: 700;
	}

	.skill-body-textarea {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
		font-size: 12.5px;
		line-height: 1.5;
		min-height: 140px;
		resize: vertical;
	}

	.skill-modal-enable-row {
		padding-top: 4px;
	}

	.skill-modal-enable-row .mcp-enable-label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
		cursor: pointer;
	}

	.skill-modal-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 20px;
		border-top: 1px solid var(--line);
		background: var(--sidebar-bg);
		gap: 12px;
	}

	.skill-modal-foot-left,
	.skill-modal-foot-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.skill-delete-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.skill-modal-foot-right .btn-primary {
		background: var(--accent);
		color: #ffffff;
		border-color: transparent;
		box-shadow: 0 2px 6px rgba(37, 99, 235, 0.2);
	}

	.skill-modal-foot-right .btn-primary:hover:not(:disabled) {
		background: var(--accent-hover);
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
