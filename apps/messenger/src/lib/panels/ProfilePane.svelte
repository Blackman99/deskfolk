<script lang="ts">
	import MemoryCard from './MemoryCard.svelte';
	import RoutineCard from './RoutineCard.svelte';
	import { backdropClick } from '../click-outside.ts';
	import { untrack } from 'svelte';
	import { pageSlide } from '../mobile-page-slide.ts';
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
	import type { DangerAction } from '../overlays/danger-confirm.ts';
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
		/** Phone only: a section is open on top of the list. The shell owns it so Back can unwind it. */
		mobileDetail?: boolean;
		initialTab?: 'basics' | 'skills' | 'routines' | 'memory' | 'actions';
		openDangerConfirm: (kind: 'skill' | 'memory', run: DangerAction) => void;
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
		mobileDetail = $bindable(false),
		initialTab = 'basics',
		openDangerConfirm,
		clearDanger,
		onDeleteBot,
		onClearHistory
	}: Props = $props();
	/** A click outside closes the skill editor; a text-selection drag that starts inside never does. */
	const skillBackdrop = backdropClick();

	const snapshot = $derived(runtime.snapshot);
	const modelValues = $derived(modelOptions.map((option) => option.value));
	const profileSkills = $derived(snapshot.skills.filter((skill) => skill.bot_id === bot.id));
	const profileMemories = $derived(snapshot.memories.filter((m) => m.bot_id === bot.id));

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
	let profileSaveQueued = false;
	/** Cleared on unmount: a save that fails after the pane is gone must not flag the next one. */
	let mounted = true;

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
	$effect(() => () => {
		flushProfileSave();
		mounted = false;
	});

	/** Server-side edits (a Bot changing its own profile) land in the draft unless you are editing. */
	$effect(() => {
		const live = snapshot.bots.find((row) => row.id === bot.id);
		if (!live) {
			runtime.closeProfile();
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
		if (!skillEditor) return;
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
				? await runtime.createSkill({ bot_id: bot.id, ...plan.body })
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
		openDangerConfirm('skill', (isCurrent) => deleteSkillRow(id, isCurrent));
	}

	async function deleteSkillRow(skillId: string, isCurrent: () => boolean): Promise<void> {
		skillFailed = false;
		const error = await runtime.deleteSkill(skillId);
		if (!isCurrent()) return;
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
		if (profileSaving) {
			profileSaveQueued = true;
			return;
		}
		const sent: ProfileFields = { ...profileDraft };
		if (!profileNeedsSave(sent, profileBaseline)) return;
		const plan = planCreateBot(sent, modelValues);
		if (!plan.ok) {
			profileErrors = plan.errors;
			return;
		}
		profileSaving = true;
		profileFailed = false;
		profileErrors = {};
		const error = await runtime.patchBot(bot.id, plan.body);
		profileSaving = false;
		if (!error) {
			profileBaseline = sent;
			profileSavedTick += 1;
		} else if (mounted) {
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
		profileFailed = false;
		const error = await runtime.archiveBot(bot.id);
		if (error) profileFailed = true;
	}

	async function restoreProfile(): Promise<void> {
		profileFailed = false;
		const error = await runtime.restoreBot(bot.id);
		if (error) profileFailed = true;
	}

	export type BotTab = 'basics' | 'skills' | 'routines' | 'memory' | 'actions';
	let activeTab = $state<BotTab>(untrack(() => initialTab));

	/**
	 * On a phone this pane is two screens: the list of sections, and the section itself. Which one
	 * is showing is the shell's business too — its Back has to unwind the section before it closes
	 * the drawer — so the flag is bound, and the width test matches the stylesheet's breakpoint.
	 */
	const PHONE_QUERY = '(max-width: 680px)';
	function onPhone(): boolean {
		return typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches;
	}

	// A routine opened from search carries its own tab; the card only reads the
	// pending id once it is mounted.
	$effect(() => {
		if (runtime.profileRoutineId) untrack(() => {
			activeTab = 'routines';
			if (onPhone()) mobileDetail = true;
		});
	});

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
		// On a phone the row is how you enter the section, so tapping the current one still opens it.
		if (onPhone()) mobileDetail = true;
		if (activeTab === tab) return;
		flushProfileSave();
		activeTab = tab;
	}

	/**
	 * A skill sheet, routine page, or memory page sits on top of this section. Back closes that before it
	 * leaves the section. A save in flight stays put.
	 */
	let routineCard = $state<{ backFromEditor: () => boolean; addRoutine: () => void; canAdd: () => boolean } | undefined>();
	let memoryCard = $state<{ backFromEditor: () => boolean } | undefined>();
	const routineCount = $derived(runtime.snapshot.routines.filter((row) => row.bot_id === bot.id).length);
	export function backFromEditor(): boolean {
		if (skillEditor) {
			if (!skillBusy) closeSkillEditor();
			return true;
		}
		if (routineCard?.backFromEditor()) return true;
		if (memoryCard?.backFromEditor()) return true;
		return false;
	}

	/** The shell's Back button and the browser's both come through here first. */
	export function backFromDetail(): boolean {
		if (!mobileDetail) return false;
		flushProfileSave();
		mobileDetail = false;
		return true;
	}

	function tabLabel(tab: BotTab): string {
		return tab === 'basics'
			? t.detail.botTabBasics
			: tab === 'skills'
				? t.detail.botTabSkills
				: tab === 'routines'
					? t.detail.botTabRoutines
					: tab === 'memory'
						? t.detail.botTabMemory
						: t.detail.botTabActions;
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

<div class="profile-pane" class:is-mobile-detail={mobileDetail}>
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
			<span class="tab-chevron" aria-hidden="true"></span>
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
			<span class="tab-chevron" aria-hidden="true"></span>
		</button>

		<button
			type="button"
			role="tab"
			aria-selected={activeTab === 'routines'}
			class="bot-tab-btn"
			class:is-active={activeTab === 'routines'}
			onclick={() => switchTab('routines')}
		>
			<svg class="tab-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<rect x="3" y="4" width="18" height="18" rx="2"></rect>
				<line x1="16" y1="2" x2="16" y2="6"></line>
				<line x1="8" y1="2" x2="8" y2="6"></line>
				<line x1="3" y1="10" x2="21" y2="10"></line>
			</svg>
			<span class="tab-name">{t.detail.botTabRoutines}</span>
			<span class="tab-chevron" aria-hidden="true"></span>
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
			{#if profileMemories.length > 0}
				<span class="tab-count">{profileMemories.length}</span>
			{/if}
			<span class="tab-chevron" aria-hidden="true"></span>
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
			<span class="tab-chevron" aria-hidden="true"></span>
		</button>
	</div>
</div>

<div class="bot-detail">
	<!-- Phone only: the section's own header. Wider windows keep the tab strip and this is hidden. -->
	<div class="bot-detail-head">
		<button
			type="button"
			class="bot-detail-back"
			aria-label={t.detail.backToSections}
			onclick={() => backFromDetail()}
		>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
		</button>
		<h3 class="bot-detail-title">{tabLabel(activeTab)}</h3>
		{#if activeTab === 'skills'}
			<span class="panel-counter-badge bot-detail-count">{profileSkills.length}</span>
			<button
				type="button"
				class="bot-detail-action"
				onclick={openAddSkill}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
				<span>{t.sidebar.skillAdd}</span>
			</button>
		{:else if activeTab === 'routines'}
			<span class="panel-counter-badge bot-detail-count">{routineCount}</span>
			<button
				type="button"
				class="bot-detail-action"
				disabled={!routineCard?.canAdd()}
				onclick={() => routineCard?.addRoutine()}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
				<span>{t.routines.add}</span>
			</button>
		{:else if activeTab === 'memory'}
			<span class="panel-counter-badge bot-detail-count">{profileMemories.length}</span>
		{/if}
	</div>

<div class="panel-scroll-content profile-pane-scroll flex-1 overflow-y-auto pt-8 px-9 pb-12 flex flex-col gap-8">
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
<div class="panel-card skill-card">
	<div class="panel-card-head skill-card-head">
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
				<div class="skill-empty-icon" aria-hidden="true">
					<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
					</svg>
				</div>
				<p class="skill-empty-text">{t.sidebar.skillsEmpty}</p>
				<button type="button" class="btn-primary skill-empty-add-btn" onclick={openAddSkill}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
						</svg>
					</div>
					<div class="skill-row-content">
						<div class="skill-row-title-line">
							<span class="skill-name" title={skill.name}>{skill.name}</span>
							{#if skill.uses && skill.uses.length > 0}
								<span class="skill-uses-badge" title={skill.uses.join(', ')}>MCP</span>
							{/if}
							{#if !skill.enabled}
								<span class="skill-badge-disabled">已停用</span>
							{/if}
						</div>
						<span class="skill-desc" title={skill.description}>{skill.description}</span>
						{#if skill.learning}
							<span class="skill-learning">
								{skill.learning.later === 0
									? t.sidebar.learningNoneYet
									: t.sidebar.learningLater(skill.learning.later, skill.learning.shorter)}
							</span>
						{/if}
					</div>
				</button>
				<div class="skill-row-actions skill-row-actions-desktop">
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
				<div class="skill-mobile-toggle">
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<label
						class="switch-toggle"
						title={skill.enabled ? t.sidebar.skillEnabled : '已停用'}
						onclick={(e) => e.stopPropagation()}
					>
						<input
							type="checkbox"
							aria-label={`${t.sidebar.skillEnabled}: ${skill.name}`}
							checked={skill.enabled}
							onchange={(event) => {
								event.currentTarget.checked = skill.enabled;
								void toggleSkillEnabled(skill.id, !skill.enabled);
							}}
						/>
						<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
					</label>
				</div>
			</div>
		{/each}
	</div>
</div>
{:else if activeTab === 'routines'}
<RoutineCard bind:this={routineCard} {runtime} {bot} {t} />
{:else if activeTab === 'memory'}
<MemoryCard bind:this={memoryCard} {runtime} {bot} {t} {openDangerConfirm} {clearDanger} />
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
		{#if runtime.selectedId}
			<div class="action-list-row session-mute-row mt-4 pt-4">
				<div class="action-list-info">
					<span class="action-list-title">{t.notifications.sessionMute}</span>
				</div>
				<input
					type="checkbox"
					checked={runtime.isSessionMuted(runtime.selectedId)}
					onchange={(e) => {
						if (runtime.selectedId) {
							void runtime.setSessionMuted(runtime.selectedId, (e.currentTarget as HTMLInputElement).checked);
						}
					}}
				/>
			</div>
		{/if}
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
</div>
</div>
</div>

{#if skillEditor}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal-backdrop skill-modal-backdrop page-on-phone"
		transition:pageSlide={{ instant: !onPhone() }}
		role="dialog"
		aria-modal="true"
		aria-labelledby="skill-modal-title"
		tabindex="-1"
		onmousedowncapture={skillBackdrop.press}
		onclick={(e) => {
			e.stopPropagation();
			if (skillBackdrop.isOutside(e) && !skillBusy) closeSkillEditor();
		}}
		onpointerdown={(e) => e.stopPropagation()}
	>
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="modal-dialog skill-modal"
			onclick={(e) => e.stopPropagation()}
			onpointerdown={(e) => e.stopPropagation()}
		>
			<div class="modal-head skill-modal-head">
				<button
					type="button"
					class="modal-back"
					aria-label={t.common.back}
					disabled={skillBusy}
					onclick={closeSkillEditor}
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
				</button>
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

				<!-- Card 1: 技能名称与归属 -->
				<div class="skill-form-card">
					<div class="skill-card-header">
						<label for="skill-name" class="field-label">
							{t.sidebar.skillName} <span class="required-star">*</span>
						</label>
						<span class="skill-owner-badge" title={`${t.routines.owner}: ${bot.name}`}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
								<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
								<circle cx="12" cy="7" r="4"></circle>
							</svg>
							<span>{bot.name}</span>
						</span>
					</div>
					<div class="form-group">
						<input
							id="skill-name"
							type="text"
							bind:value={skillDraft.name}
							placeholder="例如：web_search, git_commit"
							disabled={skillBusy}
							aria-invalid={!!skillErrors.name}
						/>
						{#if skillErrors.name}
							<p class="field-error">{skillNameCopy(skillErrors.name)}</p>
						{/if}
					</div>
				</div>

				<!-- Card 2: 触发场景或适用条件 -->
				<div class="skill-form-card">
					<div class="skill-card-header">
						<label for="skill-description" class="field-label">
							{t.sidebar.skillDescription} <span class="required-star">*</span>
						</label>
						<span class="skill-card-hint">何时自动调用</span>
					</div>
					<div class="form-group">
						<textarea
							id="skill-description"
							bind:value={skillDraft.description}
							rows="3"
							placeholder="描述此技能适用的场景或触发条件，方便模型识别何时使用..."
							disabled={skillBusy}
							aria-invalid={!!skillErrors.description}
						></textarea>
						{#if skillErrors.description}
							<p class="field-error">{t.sidebar.skillDescriptionEmpty}</p>
						{/if}
					</div>
				</div>

				<!-- Card 3: 指令与规则正文 -->
				<div class="skill-form-card">
					<div class="skill-card-header">
						<label for="skill-body" class="field-label">
							{t.sidebar.skillBody} <span class="required-star">*</span>
						</label>
						<span class="skill-card-hint">Markdown 指令</span>
					</div>
					<div class="form-group">
						<textarea
							id="skill-body"
							class="skill-body-textarea"
							bind:value={skillDraft.body}
							rows="7"
							placeholder="输入具体的 Markdown 指令、规则或提示词内容..."
							disabled={skillBusy}
							aria-invalid={!!skillErrors.body}
						></textarea>
						{#if skillErrors.body}
							<p class="field-error">{t.sidebar.skillBodyEmpty}</p>
						{/if}
					</div>
				</div>

				<!-- Card 4: 依赖的 MCP 工具 -->
				<div class="skill-form-card">
					<div class="skill-card-header">
						<label for="skill-uses" class="field-label">{t.sidebar.skillUses}</label>
						<span class="skill-card-hint">可选</span>
					</div>
					<div class="form-group">
						<input
							id="skill-uses"
							type="text"
							bind:value={skillDraft.uses}
							placeholder={t.sidebar.skillUsesPlaceholder}
							disabled={skillBusy}
						/>
						<p class="muted field-hint">{t.sidebar.skillUsesHint}</p>
					</div>
				</div>

				<!-- Card 5: 启用状态开关 -->
				<div class="skill-form-card skill-status-card">
					<div class="skill-switch-row">
						<div class="skill-switch-copy">
							<span class="skill-switch-title">{t.sidebar.skillEnabled}</span>
							<span class="skill-switch-desc">
								{skillDraft.enabled ? '已启用，Bot 在匹配任务中将自动读取并执行' : '已停用，Bot 将暂时忽略此技能'}
							</span>
						</div>
						<label class="switch-toggle" class:is-disabled={skillBusy}>
							<input type="checkbox" bind:checked={skillDraft.enabled} disabled={skillBusy} />
							<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
						</label>
					</div>
				</div>

				<!-- Card 6: 移动端危险区域 / 删除技能 (仅编辑时显示) -->
				{#if skillEditor !== 'add'}
					<div class="skill-danger-card">
						<button
							type="button"
							class="deny skill-page-delete"
							disabled={skillBusy}
							onclick={() => openDeleteSkillConfirm(skillEditor as string)}
						>
							<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<polyline points="3 6 5 6 21 6"></polyline>
								<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
							</svg>
							<span>{t.sidebar.skillDelete}</span>
						</button>
					</div>
				{/if}
			</div>

			<div class="modal-foot skill-modal-foot">
				<div class="skill-modal-foot-desktop">
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
				<div class="skill-modal-foot-mobile">
					<button type="button" class="btn-primary skill-page-save" disabled={skillBusy} onclick={() => void saveSkill()}>
						{skillBusy ? t.routines.busy : t.sidebar.skillSave}
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.profile-pane {
		display: flex;
		flex-direction: column;
		flex: 1 1 0;
		min-height: 0;
		height: 100%;
		overflow: hidden;
	}

	/* The section body. On a phone it becomes the second screen; wider, it is just the pane. */
	.bot-detail {
		display: flex;
		flex-direction: column;
		flex: 1 1 0;
		min-height: 0;
	}

	.bot-detail-head {
		display: none;
	}

	/*
	 * Flush with the drawer: the title's rule is the top edge and the tabs run to both sides.
	 * A padded, rounded pill used to float in a gap of its own.
	 */
	.bot-nav-sticky {
		flex-shrink: 0;
		padding: 0;
		background: var(--sidebar-bg);
		border-bottom: 1px solid var(--line);
		box-sizing: border-box;
	}

	.profile-pane-scroll {
		min-height: 0;
		box-sizing: border-box;
	}

	.profile-textarea {
		line-height: 1.5;
	}

	.profile-textarea-duties {
		min-height: 140px;
	}

	.profile-textarea-boundaries {
		min-height: 100px;
	}

	.bot-tabs {
		display: flex;
		align-items: stretch;
		width: 100%;
		gap: 0;
		padding: 0;
		background: transparent;
		border: 0;
		border-radius: 0;
		box-sizing: border-box;
	}

	.bot-tab-btn {
		flex: 1 1 0;
		min-width: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		min-height: 40px;
		padding: 10px 4px 8px;
		border-radius: 0;
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-secondary);
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		cursor: pointer;
		white-space: nowrap;
		transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
		line-height: 1.2;
		box-sizing: border-box;
	}

	.bot-tab-btn:hover {
		color: var(--ink);
		background: var(--row-hover);
	}

	.bot-tab-btn.is-active {
		color: var(--accent);
		font-weight: 600;
		background: transparent;
		border-bottom-color: var(--accent);
		box-shadow: none;
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

	/* Phone rows draw this; the wider tab strip does not. */
	.tab-chevron {
		display: none;
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

	.skill-learning {
		font-size: 11px;
		color: var(--muted);
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

	.skill-badge-disabled {
		font-size: 11px;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		color: var(--muted);
		line-height: 1.3;
	}

	.skill-mobile-toggle {
		display: none;
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

	.skill-form-card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.skill-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.skill-card-header .field-label {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink);
		margin: 0;
	}

	.skill-owner-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		font-weight: 500;
		color: var(--muted);
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		padding: 2px 8px;
		border-radius: 999px;
	}

	.skill-card-hint {
		font-size: 11.5px;
		color: var(--muted);
	}

	.skill-form-card .form-group {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.skill-status-card {
		padding: 12px 14px;
	}

	.skill-switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 40px;
	}

	.skill-switch-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.skill-switch-title {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--ink);
	}

	.skill-switch-desc {
		font-size: 11.5px;
		color: var(--muted);
	}

	.skill-danger-card {
		padding: 4px 0;
	}

	.skill-page-delete {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		width: 100%;
		min-height: 44px;
		border: 1px solid rgba(239, 68, 68, 0.25);
		border-radius: var(--radius-md);
		background: rgba(239, 68, 68, 0.05);
		color: var(--danger-text, var(--danger, #ef4444));
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.skill-page-delete:hover:not(:disabled) {
		background: rgba(239, 68, 68, 0.1);
		border-color: rgba(239, 68, 68, 0.4);
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

	.session-mute-row {
		border-top: 1px solid var(--line);
	}

	.skill-modal-foot {
		display: flex;
		align-items: center;
		padding: 12px 20px;
		border-top: 1px solid var(--line);
		background: var(--sidebar-bg);
		gap: 12px;
	}

	.skill-modal-foot-desktop {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
	}

	.skill-modal-foot-mobile {
		display: none;
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

	.switch-toggle { position: relative; display: inline-flex; align-items: center; margin: 0; cursor: pointer; }
	.switch-toggle input { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
	.switch-track { display: block; width: 44px; height: 24px; border-radius: 9999px; background: var(--chip-line, var(--line)); position: relative; transition: background-color 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
	.switch-thumb { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
	.switch-toggle input:checked + .switch-track { background: var(--accent); }
	.switch-toggle input:checked + .switch-track .switch-thumb { transform: translateX(20px); }
	.switch-toggle input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 2px; }
	.switch-toggle.is-disabled { opacity: 0.55; cursor: default; }

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
	@media (max-width: 680px) {
		/*
		 * Two screens, the way the settings page does it: the sections as a grouped list, and the
		 * section itself sliding in over it. The pane keeps one scroll area per screen, so a long
		 * section never drags the list along with it.
		 */
		.profile-pane {
			position: relative;
		}

		.bot-nav-sticky {
			position: absolute;
			inset: 0;
			overflow-y: auto;
			padding: 14px 12px calc(24px + env(safe-area-inset-bottom));
			background: var(--sidebar-bg);
			border-bottom: 0;
			transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
		}

		.profile-pane.is-mobile-detail .bot-nav-sticky {
			transform: translateX(-28%);
		}

		.bot-tabs {
			flex-direction: column;
			align-items: stretch;
			gap: 0;
			padding: 0;
			background: transparent;
			border: 0;
			border-radius: var(--radius-lg);
			overflow: hidden;
		}

		.bot-tab-btn {
			position: relative;
			flex: none;
			justify-content: flex-start;
			gap: 10px;
			min-height: 54px;
			padding: 0 14px;
			margin-bottom: 0;
			border-radius: 0;
			border-bottom: 0;
			background: var(--pane);
			font-size: 15px;
			font-weight: 500;
			color: var(--ink);
		}

		.bot-tab-btn + .bot-tab-btn::before {
			content: '';
			position: absolute;
			left: 44px;
			right: 0;
			top: 0;
			height: 1px;
			background: var(--line);
		}

		/* The chevron says the row opens a screen; the active tint belongs to the wider layout. */
		.bot-tab-btn .tab-chevron {
			display: block;
			width: 8px;
			height: 8px;
			border-top: 1.8px solid var(--muted);
			border-right: 1.8px solid var(--muted);
			transform: rotate(45deg);
			margin-left: 8px;
			flex-shrink: 0;
		}

		.bot-tab-btn.is-active,
		.bot-tab-btn:hover {
			background: var(--pane);
			box-shadow: none;
			font-weight: 500;
			color: var(--ink);
		}

		.bot-tab-btn:active {
			background: var(--row-hover);
		}

		.bot-tab-btn .tab-icon,
		.bot-tab-btn.is-active .tab-icon {
			width: 19px;
			height: 19px;
			color: var(--muted);
		}

		/*
		 * The name takes the leftover room, so a count or an error mark lands against the chevron.
		 * Two auto margins (the badge and a ::after chevron) used to split that room and park the
		 * number in the middle of the row.
		 */
		.bot-tab-btn .tab-name {
			flex: 1;
			min-width: 0;
			text-align: left;
		}

		.bot-tab-btn .tab-count,
		.bot-tab-btn .tab-badge-error {
			margin-left: 8px;
			flex-shrink: 0;
		}

		.bot-detail {
			position: absolute;
			inset: 0;
			z-index: 2;
			background: var(--bg);
			transform: translateX(100%);
			visibility: hidden;
			transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), visibility 0s linear 0.22s;
		}

		.profile-pane.is-mobile-detail .bot-detail {
			transform: translateX(0);
			visibility: visible;
			transition-delay: 0s;
		}

		/* It stands in for the drawer's own header, so it keeps that header's safe-area inset. */
		.bot-detail-head {
			display: flex;
			align-items: center;
			gap: 4px;
			flex-shrink: 0;
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 12px 0 4px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
		}

		.bot-detail-back {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 44px;
			height: 44px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			cursor: pointer;
			flex-shrink: 0;
		}

		.bot-detail-back:active {
			background: var(--row-hover);
		}

		.bot-detail-title {
			margin: 0;
			font-size: 16px;
			font-weight: 650;
			color: var(--ink);
		}

		.bot-detail-count {
			margin-left: 4px;
			flex-shrink: 0;
		}

		.bot-detail-action {
			display: inline-flex;
			align-items: center;
			gap: 4px;
			flex-shrink: 0;
			height: 40px;
			margin-left: auto;
			padding: 0 10px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			font-size: 14.5px;
			font-weight: 600;
			cursor: pointer;
		}

		.bot-detail-action:active {
			background: var(--row-hover);
		}

		.bot-detail-action:disabled {
			opacity: 0.45;
			cursor: default;
		}

		.profile-pane-scroll {
			padding: 16px 12px calc(28px + env(safe-area-inset-bottom));
			overscroll-behavior: contain;
		}

		.skill-card {
			border: 0;
			border-radius: 0;
			background: transparent;
			box-shadow: none;
		}

		.skill-card-head {
			display: none;
		}

		.skill-card-body {
			gap: 10px;
			padding: 0;
		}

		.skill-row-actions-desktop {
			display: none;
		}

		.skill-mobile-toggle {
			display: flex;
			align-items: center;
			margin-left: auto;
			flex-shrink: 0;
		}

		.skill-row {
			padding: 12px 14px;
			border: 1px solid var(--line);
			border-radius: var(--radius-lg, 12px);
			background: var(--pane);
			box-shadow: var(--shadow-xs);
		}

		.skill-row-icon {
			width: 36px;
			height: 36px;
			border-radius: 10px;
		}

		.skill-row-icon svg {
			width: 18px;
			height: 18px;
		}

		.skill-name {
			font-size: 15px;
		}

		.skill-desc {
			font-size: 13px;
			line-height: 1.4;
			line-clamp: 2;
			-webkit-line-clamp: 2;
			display: -webkit-box;
			-webkit-box-orient: vertical;
			white-space: normal;
		}

		.skill-open {
			min-height: 52px;
			padding: 0;
		}

		.skill-open:active {
			opacity: 0.85;
		}

		.skill-empty-card {
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 12px;
			padding: 36px 16px;
			border-radius: var(--radius-lg, 12px);
			background: var(--pane);
			border: 1px dashed var(--line);
			text-align: center;
		}

		.skill-empty-icon {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 56px;
			height: 56px;
			border-radius: 50%;
			background: var(--sidebar-bg);
			color: var(--muted);
		}

		.skill-empty-text {
			font-size: 14px;
			color: var(--muted);
			margin: 0;
		}

		.skill-empty-add-btn {
			min-height: 44px;
			padding: 0 20px;
			font-size: 14px;
			border-radius: var(--radius-md);
		}

		/* Mobile Skill Full Page Editor */
		.modal-dialog.skill-modal {
			background: var(--bg);
		}

		.skill-modal-head {
			display: flex;
			align-items: center;
			gap: 4px;
			flex-shrink: 0;
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 12px 0 4px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
		}

		.skill-modal-body {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			padding: 16px 12px calc(24px + env(safe-area-inset-bottom));
			display: flex;
			flex-direction: column;
			gap: 14px;
			-webkit-overflow-scrolling: touch;
		}

		.skill-form-card {
			padding: 14px 16px;
			border-radius: var(--radius-lg, 12px);
			box-shadow: var(--shadow-xs);
		}

		.skill-form-card input:not([type='checkbox']):not([type='radio']),
		.skill-form-card textarea {
			padding: 10px 12px;
			border: 1px solid var(--line);
			border-radius: var(--radius-md);
			background: var(--input-bg);
			width: 100%;
			min-height: 44px;
			box-sizing: border-box;
			font-size: 16px;
			color: var(--ink);
		}

		.skill-modal-foot {
			padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
			background: var(--pane);
			border-top: 1px solid var(--line);
			box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.04);
		}

		.skill-modal-foot-desktop {
			display: none;
		}

		.skill-modal-foot-mobile {
			display: flex;
			width: 100%;
		}

		.skill-page-save {
			width: 100%;
			min-height: 48px;
			font-size: 16px;
			font-weight: 600;
			border-radius: var(--radius-md);
		}

		@media (prefers-reduced-motion: reduce) {
			.bot-nav-sticky,
			.bot-detail {
				transition: none;
			}
		}
	}
</style>
