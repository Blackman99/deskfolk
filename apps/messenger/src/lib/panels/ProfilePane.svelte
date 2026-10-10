<script lang="ts">
	import { endpointSource } from '../model-source.ts';
	import MemoryCard from './MemoryCard.svelte';
	import RoutineCard from './RoutineCard.svelte';
	import SharedSkillsCard from './SharedSkillsCard.svelte';
	import SettingsSubject from './SettingsSubject.svelte';
	import BotTabNav from './BotTabNav.svelte';
	import ProfileBasics from './ProfileBasics.svelte';
	import SkillsCard from './SkillsCard.svelte';
	import SkillEditor from './SkillEditor.svelte';
	import BotActionsCard from './BotActionsCard.svelte';
	import { untrack } from 'svelte';
	import { Autosave } from '../autosave.svelte.ts';
	import type { AgentsStatusResponse, Bot, ClaudeCodeStatus } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import {
		emptySkillDraft,
		endpointModelPicker,
		formatSkillUses,
		mapCreateBotError,
		mapSkillError,
		pickerValues,
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
	import { findPicked, type PickerData } from '../model-picker.ts';
	import { runnerValueOf } from '../runner-choice.ts';

	type Props = {
		runtime: MessengerRuntime;
		/** Keyed on by the shell, so switching Bots remounts this pane rather than reconciling. */
		bot: Bot;
		t: Copy;
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
		selectedKind,
		profileFailed = $bindable(false),
		mobileDetail = $bindable(false),
		initialTab = 'basics',
		openDangerConfirm,
		clearDanger,
		onDeleteBot,
		onClearHistory
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const listedModels = $derived(endpointModelPicker(snapshot.providers, t));
	/**
	 * A pin no endpoint lists any more: from engine level 7 it outlives the list (ADR 0048), the turn
	 * runs on the endpoint's default meanwhile. Offered as it is and marked, so the rest of the profile
	 * still saves and the pin is not lost by touching it.
	 */
	const unlistedPin = $derived.by(() => {
		const value = botModelValue(bot);
		return value && !findPicked(listedModels, value) ? value : null;
	});
	const profileModelPicker = $derived.by((): PickerData => {
		if (!unlistedPin || !bot.model) return listedModels;
		const endpoint = snapshot.providers.find((provider) => provider.id === bot.provider_id);
		const row = { value: unlistedPin, label: bot.model, hint: t.sidebar.botModelUnlisted, ...(endpoint ? { detail: endpoint.name, mark: endpointSource(endpoint, t) } : {}) };
		return { ...listedModels, specials: [...listedModels.specials, row] };
	});
	const modelValues = $derived(pickerValues(profileModelPicker));
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
			thinkingLevel: row.thinking_level ?? '',
			runner: runnerValueOf(row.runner, row.agent_custom_id),
			agentModel: row.agent_model ?? '',
			agentEffort: row.agent_effort ?? '',
			// Left out of the save for a daemon that has no accounts, which would refuse the field.
			agentConfigDir: row.agent_config_dir === undefined ? undefined : (row.agent_config_dir ?? '')
		};
	}

	// A fresh mount is the reset: the shell keys this pane on the Bot it is showing, so reading
	// `bot` once here is the point — the draft must not follow the prop after that.
	let profileDraft = $state<ProfileFields>(untrack(() => emptyProfile(bot)));
	let profileBaseline = $state<ProfileFields>(untrack(() => emptyProfile(bot)));
	let profileErrors = $state<CreateBotFieldErrors>({});
	/** `saving`, and `savedTick`, bumped on every accepted save so the header can say 「已自动保存」. */
	const autosave = new Autosave();
	let profileSaveQueued = false;
	/** Cleared on unmount: a save that fails after the pane is gone must not flag the next one. */
	let mounted = true;

	let skillEditor = $state<'add' | string | null>(null);
	let skillDraft = $state<SkillDraft>(emptySkillDraft());
	let skillBaseline = $state<SkillDraft>(emptySkillDraft());
	let skillErrors = $state<SkillFieldErrors>({});
	let skillFailed = $state(false);
	let skillBusy = $state(false);

	/** What the daemon finds of your own Claude Code (ADR 0061); null until asked, or away from the computer. */
	let claudeStatus = $state<ClaudeCodeStatus | null>(null);
	let claudeChecking = $state(false);
	let claudeUnavailable = $state(false);

	async function checkClaudeCode(): Promise<void> {
		const client = runtime.client;
		if (!client || claudeChecking) return;
		claudeChecking = true;
		try {
			claudeStatus = await client.claudeCode();
			claudeUnavailable = false;
		} catch {
			claudeUnavailable = true;
		} finally {
			claudeChecking = false;
		}
	}

	// Asked once the Bot runs on Claude Code, or when you pick it: never for a Bot that does not.
	$effect(() => {
		if (profileDraft.runner === 'claude_code' && !claudeStatus && !claudeUnavailable) void untrack(() => checkClaudeCode());
	});

	/** What the daemon finds of your other local agents (ADR 0079): the runner picker lists them, so it is asked once, on opening. */
	let agents = $state<AgentsStatusResponse | null>(null);
	let agentsUnavailable = $state(false);

	async function checkAgents(): Promise<void> {
		const client = runtime.client;
		if (!client) return;
		try {
			agents = await client.agents();
			agentsUnavailable = false;
		} catch {
			// The phone, or a daemon older than local agents: only the app's loop and Claude are offered.
			agentsUnavailable = true;
		}
	}
	untrack(() => void checkAgents());

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
			thinkingLevel: live.thinking_level ?? '',
			runner: runnerValueOf(live.runner, live.agent_custom_id),
			agentModel: live.agent_model ?? '',
			agentEffort: live.agent_effort ?? '',
			agentConfigDir: live.agent_config_dir === undefined ? undefined : (live.agent_config_dir ?? '')
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

	function scheduleProfileSave(delay = 600): void {
		autosave.schedule(() => void saveProfile(), delay);
	}

	/** Sends a pending autosave now: on close, on switching Bots, or when the panel goes away. */
	function flushProfileSave(): void {
		if (!autosave.cancel()) return;
		void saveProfile();
	}

	async function saveProfile(): Promise<void> {
		if (autosave.saving) {
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
		autosave.saving = true;
		profileFailed = false;
		profileErrors = {};
		const error = await runtime.patchBot(bot.id, plan.body);
		autosave.saving = false;
		if (!error) {
			profileBaseline = sent;
			autosave.savedTick += 1;
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
			profileErrors.thinkingLevel ||
			profileErrors.agentModel ||
			profileErrors.agentEffort ||
			profileErrors.agentConfigDir ||
			profileErrors.agentCustomId
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
		<BotTabNav {t} {activeTab} {basicsHasError} {profileSkills} {routineCount} {profileMemories} {switchTab} />
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
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
		</button>
		<div class="bot-detail-heading">
			<div class="bot-detail-title-row">
				<h3 class="bot-detail-title">{tabLabel(activeTab)}</h3>
				{#if activeTab === 'skills'}
					<span class="panel-counter-badge bot-detail-count">{profileSkills.length}</span>
				{:else if activeTab === 'routines'}
					<span class="panel-counter-badge bot-detail-count">{routineCount}</span>
				{:else if activeTab === 'memory'}
					<span class="panel-counter-badge bot-detail-count">{profileMemories.length}</span>
				{/if}
			</div>
			<SettingsSubject variant="line" {bot} {t} />
		</div>
		{#if activeTab === 'skills'}
			<button
				type="button"
				class="bot-detail-action"
				onclick={openAddSkill}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
				<span>{t.sidebar.skillAdd}</span>
			</button>
		{:else if activeTab === 'routines'}
			<button
				type="button"
				class="bot-detail-action"
				disabled={!routineCard?.canAdd()}
				onclick={() => routineCard?.addRoutine()}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
				<span>{t.routines.add}</span>
			</button>
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
<ProfileBasics
	{runtime}
	{t}
	bind:profileDraft
	{profileErrors}
	profileSaving={autosave.saving}
	{profileFailed}
	profileSavedTick={autosave.savedTick}
	{profileModelPicker}
	{unlistedPin}
	{claudeStatus}
	{claudeUnavailable}
	{agents}
	{agentsUnavailable}
	{onProfileInput}
	{onProfilePick}
/>
{:else if activeTab === 'skills'}
<SkillsCard
	{t}
	{profileSkills}
	{skillEditor}
	{skillFailed}
	{openAddSkill}
	{openEditSkill}
	{toggleSkillEnabled}
	{openDeleteSkillConfirm}
/>
<SharedSkillsCard api={runtime.client} botId={bot.id} skills={profileSkills} {t} />
{:else if activeTab === 'routines'}
<RoutineCard bind:this={routineCard} {runtime} {bot} {t} />
{:else if activeTab === 'memory'}
<MemoryCard bind:this={memoryCard} {runtime} {bot} {t} {openDangerConfirm} {clearDanger} />
{:else if activeTab === 'actions'}
<BotActionsCard {runtime} {bot} {t} {selectedKind} {archiveProfile} {restoreProfile} {onDeleteBot} {onClearHistory} />
{/if}
</div>
</div>
</div>

<SkillEditor
	{bot}
	{t}
	{skillEditor}
	bind:skillDraft
	{skillErrors}
	{skillFailed}
	{skillBusy}
	{closeSkillEditor}
	{saveSkill}
	{openDeleteSkillConfirm}
/>

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

		/* The section is the heading; whose settings they are is the line under it. */
		.bot-detail-heading {
			display: flex;
			flex: 1 1 auto;
			flex-direction: column;
			gap: 1px;
			min-width: 0;
		}

		.bot-detail-title-row {
			display: flex;
			align-items: center;
			min-width: 0;
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
			font-size: 15px;
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

		@media (prefers-reduced-motion: reduce) {
			.bot-nav-sticky,
			.bot-detail {
				transition: none;
			}
		}
	}
</style>
