<script lang="ts">
	import { untrack } from 'svelte';
	import { pageSlide } from '../mobile-page-slide.ts';
	import McpSettings from './McpSettings.svelte';
	import LessonsSettings from './LessonsSettings.svelte';
	import PromptsSettings from './PromptsSettings.svelte';
	import { editedCount } from './prompts-view.ts';
	import ClaudeAgentCard from './ClaudeAgentCard.svelte';
	import { type Lesson, type PromptSummary } from '@real-bot/protocol';
	import { backdropClick } from '../click-outside.ts';
	import type ProviderForm from './ProviderForm.svelte';
	import Select from '../Select.svelte';
	import type { CredentialOperation } from '../api.ts';
	import { thinkingLevelLabel, type Copy } from '../copy.ts';
	import { parseHostRelay, type HostRelayField } from '../remote/pairing-host.ts';
	import type { ProviderEditorState } from './provider-form.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import {
		mapSettingsError,
		planWorkspaceSave,
		type SettingsFieldErrors
	} from './wizard-save.ts';
	import NotificationSettings from './NotificationSettings.svelte';
	import SettingsNav, { type SettingsTab } from './SettingsNav.svelte';
	import GeneralTab from './GeneralTab.svelte';
	import ProvidersTab from './ProvidersTab.svelte';
	import ModelsTab from './ModelsTab.svelte';
	import RemoteTab from './RemoteTab.svelte';
	import AboutTab from './AboutTab.svelte';
	import ProviderEditorFlyout from './ProviderEditorFlyout.svelte';
	import IndependentConfirm from './IndependentConfirm.svelte';
	import AutosaveState from './AutosaveState.svelte';
	import { IndependentRuntimeController } from './independent-runtime.svelte.ts';
	import { ProviderEditorController } from './provider-editor.svelte.ts';

	type Props = {
		mobileSettingsDetail?: boolean;
		runtime: MessengerRuntime;
		t: Copy;
		/** Shared with the shell's immediate settings patch helper. */
		saveFailed: boolean;
		/** The shell owns this too, so its Escape cascade can see the flyout stacked on the modal. */
		providerEditor: ProviderEditorState | null;
		/** The danger dialog is up for an endpoint, so neither backdrop should close. */
		confirmingProvider: boolean;
		confirmingIndependent: boolean;
		patchImmediate: (patch: {
			locale?: 'zh' | 'en';
			theme?: 'system' | 'light' | 'dark';
			launch_at_login?: boolean;
		}) => Promise<boolean>;
		openDeleteProviderConfirm: (id: string) => void;
		closeSettings: () => void;
	};

	let {
		runtime,
		t,
		mobileSettingsDetail = $bindable(false),
		saveFailed = $bindable(false),
		providerEditor = $bindable(null),
		confirmingProvider,
		confirmingIndependent = $bindable(false),
		patchImmediate,
		openDeleteProviderConfirm,
		closeSettings
	}: Props = $props();
	/** Backdrop presses start outside these sheets; a drag out of one never closes them. */
	const settingsBackdrop = backdropClick();

	const snapshot = $derived(runtime.snapshot);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	let relativeTimeNow = $state(Date.now());
	$effect(() => {
		if (!runtime.settingsOpen) return;
		relativeTimeNow = Date.now();
		const timer = setInterval(() => (relativeTimeNow = Date.now()), 30_000);
		return () => clearInterval(timer);
	});

	/**
	 * The device list is fetched, not part of the snapshot, so something has to ask for it. The
	 * card asks itself rather than leaning on the button that opened the panel: a reload with
	 * `?o=settings` restores the panel already open, before the runtime has an API to ask, and
	 * never goes through `openSettings()`. Without this the card sits on "no connected devices"
	 * until the panel is closed and reopened. `untrack` keeps the call's own busy flag out of the
	 * dependencies, so finishing a fetch does not start the next one.
	 */
	$effect(() => {
		const listable = runtime.settingsOpen && !runtime.remote && runtime.remoteStatus?.state === 'online';
		if (!listable) return;
		untrack(() => void runtime.refreshHostDevices());
	});

	const credentialOps = $derived(snapshot.credentialOperations);
	let repairValues = $state<Record<string, string>>({});
	let hadPending = $state(false);
	$effect(() => {
		const open = runtime.settingsOpen;
		const pending = runtime.pendingMutation;
		if (pending) hadPending = true;
		else if (hadPending) {
			hadPending = false;
			providerEditorController.closeProviderEditor();
		}
		if (!open) repairValues = {};
		else {
			const active = new Set(credentialOps.filter((op) => op.can_repair).map((op) => op.id));
			for (const id of Object.keys(repairValues)) if (!active.has(id)) delete repairValues[id];
		}
	});

	async function resolveCredential(op: CredentialOperation, action: 'repair' | 'cancel'): Promise<void> {
		const api = runtime.client;
		if (await runtime.resolveCredentialOperation(op.id, action, repairValues[op.id])) {
			if (runtime.client !== api || !runtime.settingsOpen) return;
			delete repairValues[op.id];
		}
	}

	let mcpSettings = $state<McpSettings>();
	let modelsTab = $state<ModelsTab>();

	// Lessons the app learned (ADR 0050, engine level 8): the tab is there once there is one.
	let lessons = $state<Lesson[]>([]);
	$effect(() => {
		const api = runtime.client;
		if (!runtime.settingsOpen || !api || runtime.connection !== 'connected') return;
		void api.listLessons().then(
			(items) => {
				if (runtime.client === api) lessons = items;
			},
			() => {}
		);
	});
	const lessonsTabVisible = $derived(lessons.length > 0);

	// Built-in prompts (ADR 0064): read when settings open and again whenever one changes anywhere.
	let promptItems = $state<PromptSummary[]>([]);
	let promptsFailed = $state(false);
	let promptsSettings = $state<PromptsSettings>();
	$effect(() => {
		const api = runtime.client;
		void runtime.promptsRevision;
		if (!runtime.settingsOpen || !api || runtime.connection !== 'connected') return;
		void api.listPrompts().then(
			(items) => {
				if (runtime.client !== api) return;
				promptItems = items;
				promptsFailed = false;
			},
			() => {
				if (runtime.client === api) promptsFailed = true;
			}
		);
	});
	const promptCounts = $derived(editedCount(promptItems));
	let providerForm = $state<ProviderForm>();

	export function backFromProviderEditor(): void {
		if (providerForm?.backFromDetails()) return;
		if (providerEditorController.backToConnectorPicker()) return;
		providerEditorController.closeProviderEditor();
	}

	/**
	 * What ✕ closes: the screen it sits on, not everything under it. Deep in a section or an
	 * editor it steps out one level, exactly as Back does; on the root list — and on a window
	 * wide enough to have no inner pages — there is nothing above settings, so it closes them.
	 */
	function closeCurrentPage(): void {
		if (backWithinSettings()) return;
		closeSettings();
	}

	export function backWithinSettings(): boolean {
		if (!runtime.settingsOpen || !window.matchMedia('(max-width: 720px)').matches) return false;
		if (confirmingProvider || confirmingIndependent) return true;
		if (providerEditor) {
			backFromProviderEditor();
			return true;
		}
		if (mcpSettings?.backFromEditor()) return true;
		if (promptsSettings?.backFromEditor()) return true;
		if (activeSettingsTab === 'models' && modelsTab?.backFromSection()) return true;
		if (activeSettingsTab === 'prompts' && promptsSettings?.backFromSection()) return true;
		if (!mobileSettingsDetail) return false;
		mobileSettingsDetail = false;
		return true;
	}

	let activeSettingsTab = $state<SettingsTab>('general');
	$effect(() => {
		if (!runtime.settingsOpen) mobileSettingsDetail = false;
	});

	function openSettingsTab(tab: SettingsTab): void {
		activeSettingsTab = tab;
		mobileSettingsDetail = typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches;
	}

	// Asked to open at the prompts (a card's 「在设置里看」): the tab shows, and it opens the prompt itself.
	$effect(() => {
		const target = runtime.promptsTarget;
		if (!runtime.settingsOpen || !target) return;
		openSettingsTab('prompts');
		if (!target.prompt) runtime.promptsTarget = null;
	});

	function settingsTabLabel(tab: SettingsTab): string {
		return tab === 'general'
			? t.settings.tabGeneral
			: tab === 'models'
				? t.settings.tabModels
				: tab === 'agents'
					? t.settings.tabAgents
				: tab === 'mcp'
					? t.settings.tabMcp
				: tab === 'prompts'
					? t.settings.tabPrompts
					: tab === 'notifications'
						? t.settings.tabNotifications
						: tab === 'lessons'
							? t.settings.tabLessons
						: tab === 'remote'
							? t.settings.tabRemote
							: t.settings.tabAbout;
	}
	/** On a phone, a section of Models or a group of Prompts opened from its list names the page. */
	const mainTitle = $derived(
		(activeSettingsTab === 'models'
			? modelsTab?.sectionTitle()
			: activeSettingsTab === 'prompts'
				? promptsSettings?.sectionTitle()
				: null) ?? settingsTabLabel(activeSettingsTab)
	);
	const independentRuntime = new IndependentRuntimeController({
		runtime: () => runtime,
		t: () => t,
		setConfirmingIndependent: (value) => {
			confirmingIndependent = value;
		}
	});

	let fieldErrors = $state<SettingsFieldErrors>({});
	const generalHasError = $derived(Boolean(fieldErrors.workspace));
	const modelsHasError = $derived(
		Boolean(
			providerEditor &&
				(providerEditor.errors.name ||
					providerEditor.errors.endpoint ||
					providerEditor.errors.endpointKey ||
					providerEditor.errors.models ||
					providerEditor.errors.pricing ||
					providerEditor.errors.contextWindow ||
					providerEditor.errors.defaultModel)
		)
	);

	let workspaceSaving = $state(false);
	let pairingCopied = $state(false);
	let relayForm = $state({ origin: '', relayId: '', bootstrap: '' });
	let relayInvalid = $state<HostRelayField | null>(null);

	async function connectRelay(event: SubmitEvent) {
		event.preventDefault();
		const parsed = parseHostRelay(relayForm);
		if ('invalid' in parsed) {
			relayInvalid = parsed.invalid;
			return;
		}
		relayInvalid = null;
		if (await runtime.connectHost(parsed.relay)) relayForm = { origin: '', relayId: '', bootstrap: '' };
	}

	/** A runtime that says nothing about remote access gets no tab for it, rather than an empty page. */
	const remoteTabVisible = $derived(Boolean(runtime.remote || runtime.remoteStatus));
	$effect(() => {
		if (activeSettingsTab === 'remote' && !remoteTabVisible) activeSettingsTab = 'general';
	});
	let workspaceSavedTick = $state(0);
	const providerEditorController = new ProviderEditorController({
		runtime: () => runtime,
		snapshot: () => snapshot,
		t: () => t,
		providerEditor: () => providerEditor,
		setProviderEditor: (value) => {
			providerEditor = value;
		},
		setSaveFailed: (value) => {
			saveFailed = value;
		}
	});

	const settingsSaving = $derived(workspaceSaving || (providerEditorController.providerSaving && !providerEditor));
	const settingsSavedTick = $derived(workspaceSavedTick + (providerEditor ? 0 : providerEditorController.providerSavedTick));

	function clearWorkspaceError(): void {
		if (fieldErrors.workspace) fieldErrors = { ...fieldErrors, workspace: undefined };
	}

	async function setDefaultProvider(id: string): Promise<void> {
		saveFailed = false;
		const api = runtime.client;
		const error = await runtime.patchSettings({ default_provider_id: id });
		if (runtime.client === api && runtime.settingsOpen && error) saveFailed = true;
	}

	const workspaceReadOnly = $derived(runtime.hosted && !runtime.remote);

	async function persistWorkspace(path: string): Promise<void> {
		saveFailed = false;
		fieldErrors = {};
		// A hosted shell has no host to write to, and a remote root change needs the Mac's own
		// confirmation rather than this PATCH.
		if (workspaceReadOnly || runtime.remote) return;
		const plan = planWorkspaceSave(path);
		if (!plan.ok) {
			fieldErrors = { workspace: plan.error };
			activeSettingsTab = 'general';
			return;
		}
		if (plan.workspace_path === (snapshot.settings.workspace_path ?? '')) return;
		const api = runtime.client;
		workspaceSaving = true;
		const error = await runtime.patchSettings({ workspace_path: plan.workspace_path });
		workspaceSaving = false;
		// A transport swap mid-write belongs to the old session, not this modal.
		if (runtime.client !== api || !runtime.settingsOpen) return;
		if (!error) {
			workspaceSavedTick += 1;
			return;
		}
		const mapped = mapSettingsError(error.message);
		if ('workspace' in mapped) {
			fieldErrors = { workspace: mapped.workspace };
			activeSettingsTab = 'general';
		} else {
			saveFailed = true;
		}
	}
</script>

{#snippet settingsNotices()}
	{#if !providerEditor && (runtime.pendingMutation || credentialOps.length)}<div role="region" aria-label="Pending credentials">{@render pendingCredentials()}</div>{/if}
	{#if saveFailed}
		<p class="field-error">{t.settings.saveFailed}</p>
	{/if}
	{#if !snapshot.settings.wizard_complete}
		<div class="wizard-banner">
			<p class="muted">{t.settings.wizardHint}</p>
			<p class="muted">{t.settings.wizardIncomplete}</p>
		</div>
	{/if}
{/snippet}

{#snippet pendingCredentials()}
	{#if runtime.pendingMutation}
		<p role="status">{locale === 'en' ? 'Credential/request result pending. Retry only when ready; no automatic replay.' : '凭据或请求结果待确认。准备好后手动重试，不会自动重放。'}</p>
		<button type="button" onclick={() => void runtime.retryPendingMutation()}>{locale === 'en' ? 'Retry original request' : '重试原请求'}</button>
	{/if}
	{#each credentialOps as op (op.id)}
		<div>
			<p>{locale === 'en' ? 'Unfinished credential' : '未完成的凭据'} · {op.kind} · {op.entity_id}</p>
			{#if op.can_repair}
				<input type="password" aria-label={locale === 'en' ? 'Repair credential' : '修复凭据'} bind:value={repairValues[op.id]} autocomplete="off" />
				<button type="button" disabled={!repairValues[op.id]} onclick={() => void resolveCredential(op, 'repair')}>{locale === 'en' ? 'Save credential only' : '仅保存凭据'}</button>
			{:else}
				<p>{locale === 'en' ? 'Deletion is pending. Only clearing the credential is available.' : '凭据待删除，只能完成清除。'}</p>
			{/if}
			<button type="button" onclick={() => void resolveCredential(op, 'cancel')}>{locale === 'en' ? 'Cancel and clear credential' : '取消并清除凭据'}</button>
		</div>
	{/each}
{/snippet}

{#if runtime.settingsOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal-backdrop settings-backdrop"
		inert={Boolean(providerEditor)}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		in:pageSlide={{ instant: true }}
		out:pageSlide={{ instant: true }}
		onmousedowncapture={settingsBackdrop.press}
		onclick={(e) => {
			if (settingsBackdrop.isOutside(e) && !providerEditor && !confirmingProvider && !confirmingIndependent)
				closeSettings();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape' && !providerEditor && !confirmingProvider && !confirmingIndependent)
				closeSettings();
		}}
	>
		<div class="modal-dialog settings-modal" class:is-mobile-detail={mobileSettingsDetail}>
			<SettingsNav
				{t}
				{snapshot}
				{activeSettingsTab}
				{openSettingsTab}
				{generalHasError}
				{modelsHasError}
				{promptCounts}
				{lessonsTabVisible}
				{remoteTabVisible}
				{closeSettings}
			/>

			<section class="settings-main">
				<div class="settings-main-head">
					<button
						type="button"
						class="settings-mobile-back"
						aria-label={locale === 'en' ? 'Back to settings' : '返回设置'}
						onclick={() => void backWithinSettings()}
					>
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
					</button>
					<div class="settings-main-head-left flex items-center gap-5">
						<h3 class="settings-main-title">{mainTitle}</h3>
						<AutosaveState {t} saving={settingsSaving} failed={saveFailed} saved={settingsSavedTick > 0} />
					</div>
					<button
						type="button"
						class="modal-close"
						title={t.common.close}
						onclick={closeCurrentPage}
					>✕</button>
				</div>

			<div class="modal-body" class:is-mcp={activeSettingsTab === 'mcp'} class:is-prompts={activeSettingsTab === 'prompts'} class:is-models={activeSettingsTab === 'models'}>
				<!-- Models and Prompts scroll their own page under their tabs, so they show these there. -->
				{#if activeSettingsTab !== 'models' && activeSettingsTab !== 'prompts'}{@render settingsNotices()}{/if}

				{#if activeSettingsTab === 'general'}
					<GeneralTab
						{runtime}
						{t}
						{snapshot}
						{locale}
						{patchImmediate}
						{workspaceReadOnly}
						{fieldErrors}
						{clearWorkspaceError}
						{persistWorkspace}
						independent={independentRuntime.independent}
						independentBusy={independentRuntime.independentBusy}
						independentReason={(status) => independentRuntime.independentReason(status)}
						requestIndependent={(next) => independentRuntime.requestIndependent(next)}
					/>
				{:else if activeSettingsTab === 'models'}
					<ModelsTab bind:this={modelsTab} {runtime} {t} {snapshot} notices={settingsNotices}>
						{#snippet endpoints()}
							<ProvidersTab
								{t}
								{snapshot}
								providerSaving={providerEditorController.providerSaving}
								openAddProvider={() => providerEditorController.openAddProvider()}
								openEditProvider={(id) => providerEditorController.openEditProvider(id)}
								openProviderModels={(id) => providerEditorController.openProviderModels(id)}
								{openDeleteProviderConfirm}
								{setDefaultProvider}
								setProviderDefaultModel={(id, model) => providerEditorController.setProviderDefaultModel(id, model)}
							/>
						{/snippet}
					</ModelsTab>
				{:else if activeSettingsTab === 'agents'}
					<!-- Agents that run a Bot's turns themselves (ADR 0061): today your own Claude Code. -->
					<div class="settings-tab-pane">
						<ClaudeAgentCard api={runtime.client} {t} {locale} />
					</div>
				{:else if activeSettingsTab === 'mcp'}
					<McpSettings bind:this={mcpSettings} {runtime} {t} {closeSettings} />
				{:else if activeSettingsTab === 'prompts'}
					<PromptsSettings bind:this={promptsSettings} {runtime} {t} items={promptItems} loadFailed={promptsFailed} {closeSettings} notices={settingsNotices} />
				{:else if activeSettingsTab === 'notifications'}
					<NotificationSettings {runtime} {t} />
				{:else if activeSettingsTab === 'lessons' && lessonsTabVisible}
					<LessonsSettings {lessons} {t} onPatch={(id, patch) => runtime.client!.patchLesson(id, patch)} />
				{:else if activeSettingsTab === 'remote' && remoteTabVisible}
					<RemoteTab
						{runtime}
						{t}
						{locale}
						{relativeTimeNow}
						bind:pairingCopied
						bind:relayForm
						{relayInvalid}
						{connectRelay}
					/>
				{:else if activeSettingsTab === 'about'}
					<AboutTab {t} {locale} />
				{/if}
			</div>
			</section>
		</div>
	</div>
{/if}
<ProviderEditorFlyout
	{runtime}
	{t}
	{locale}
	{providerEditor}
	bind:providerForm
	bind:providerDetailModel={providerEditorController.providerDetailModel}
	providerSaving={providerEditorController.providerSaving}
	providerSavedTick={providerEditorController.providerSavedTick}
	{pendingCredentials}
	{backFromProviderEditor}
	closeProviderEditor={() => providerEditorController.closeProviderEditor()}
	editorKeySet={(target) => providerEditorController.editorKeySet(target)}
	setProviderDraft={(draft) => providerEditorController.setProviderDraft(draft)}
	pickConnector={(id) => providerEditorController.pickConnector(id)}
	fetchProviderModels={() => providerEditorController.fetchProviderModels()}
	persistProviderEditor={(editor) => providerEditorController.persistProviderEditor(editor)}
/>
<IndependentConfirm
	{runtime}
	{t}
	independent={independentRuntime.independent}
	independentConfirm={independentRuntime.independentConfirm}
	independentReason={(status) => independentRuntime.independentReason(status)}
	confirmIndependent={() => independentRuntime.confirmIndependent()}
	waitIndependent={() => independentRuntime.waitIndependent()}
	forceIndependent={() => independentRuntime.forceIndependent()}
	cancelIndependent={() => independentRuntime.cancelIndependent()}
/>

<style>
	@media (max-width: 680px) {
		.settings-backdrop:has(.settings-modal:not(.is-mobile-detail)) { bottom: calc(60px + env(safe-area-inset-bottom)); }
	}

	.modal-dialog.settings-modal {
		width: 880px;
		max-width: 94vw;
		height: 640px;
		max-height: 88vh;
		flex-direction: row;
	}

	.settings-mobile-back {
		display: none;
	}

	/* Settings Main Content Area */
	.settings-main {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		background: var(--pane);
	}

	.settings-main-head {
		padding: 0 24px;
		height: 56px;
		border-bottom: 1px solid var(--line);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		background: var(--pane);
		box-sizing: border-box;
		flex-shrink: 0;
	}

	.settings-main-head-left {
		flex: 1;
		min-width: 0;
		justify-content: space-between;
	}

	.settings-main-title {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--ink);
	}

	.settings-main > :global(.modal-body) {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 20px 24px;
	}

	.settings-main > .modal-body.is-mcp {
		min-height: 0;
		overflow: hidden;
		padding: 18px 24px;
	}

	/* Models and Prompts keep their tabs above a scroll of their own. */
	.settings-main > .modal-body.is-models,
	.settings-main > .modal-body.is-prompts {
		padding: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.settings-tab-pane {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.wizard-banner {
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		border-radius: var(--radius-md);
		padding: 10px 14px;
	}

	.wizard-banner :global(p) {
		margin: 2px 0;
		font-size: 12px;
		color: var(--warn-text);
		line-height: 1.45;
	}

	/* MCP settings */
	.settings-modal .modal-body.is-mcp,
	.settings-modal .modal-body.is-prompts {
		min-height: 0;
		overflow: hidden;
	}

	.settings-main-head,

	/* `.settings-modal > .settings-tabs` was here and never matched: the tabs live inside
	   `.settings-sidebar`, not directly under the dialog. */
	.settings-modal > :global(.modal-head) {
		flex-shrink: 0;
	}

	@media (max-width: 720px) {
		.settings-backdrop {
			padding: 0;
			align-items: stretch;
			background: var(--pane);
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
		}

		.modal-dialog.settings-modal {
			width: 100%;
			max-width: none;
			height: 100%;
			max-height: none;
			border: 0;
			border-radius: 0;
			box-shadow: none;
			animation: none;
			background: var(--sidebar-bg);
			position: relative;
			overflow: hidden;
		}

		.settings-main {
			position: absolute;
			inset: 0;
			z-index: 2;
			background: var(--sidebar-bg);
			transform: translateX(100%);
			visibility: hidden;
			transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), visibility 0s linear 0.22s;
		}

		.settings-modal.is-mobile-detail :global(.settings-sidebar) {
			transform: translateX(-28%);
		}

		.settings-modal.is-mobile-detail .settings-main {
			transform: translateX(0);
			visibility: visible;
			transition-delay: 0s;
		}

		.settings-main-head {
			height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 12px 0 8px;
			background: var(--pane);
			gap: 4px;
		}

		.settings-mobile-back {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 40px;
			height: 44px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			cursor: pointer;
			flex-shrink: 0;
		}

		.settings-mobile-back:active {
			background: var(--row-hover);
		}

		.settings-main-head-left {
			justify-content: center;
			gap: 0;
		}

		.settings-main-title {
			font-size: 16px;
			font-weight: 650;
		}

		.settings-main-head :global(.settings-save-state) {
			display: none;
		}

		.settings-main-head > .modal-close {
			width: 40px;
			height: 44px;
			font-size: 16px;
		}

		.settings-main > :global(.modal-body) {
			padding: 16px 12px max(28px, env(safe-area-inset-bottom));
			overscroll-behavior: contain;
		}

		.settings-main > .modal-body.is-mcp {
			padding: 14px 12px max(20px, env(safe-area-inset-bottom));
		}

		.settings-tab-pane {
			gap: 12px;
		}
	}
</style>
