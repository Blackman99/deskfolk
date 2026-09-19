<script lang="ts">
	import McpSettings from './McpSettings.svelte';
	import WorkspacePicker from './WorkspacePicker.svelte';
	import ProviderForm from './ProviderForm.svelte';
	import Select from '../Select.svelte';
	import { JAIL_COPY, thinkingLevelLabel, type Copy } from '../copy.ts';
	import {
		applyProbedModels,
		draftFromProvider,
		emptyProviderDraft,
		mapProviderError,
		planCreateProvider,
		planPatchProvider,
		probeSignature,
		providerHost,
		withSyncedDefaultModel,
		type ProviderDraft,
		type ProviderEditorState
	} from './provider-form.ts';
	import { botAvatarColor } from '../chat/chat-view.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import { themeManager } from '../theme.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { updateChecker } from '../update-checker.svelte.ts';
	import {
		mapSettingsError,
		planWorkspaceSave,
		type FieldErrorKind,
		type SettingsFieldErrors
	} from './wizard-save.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		/** The shell owns this: the sidebar's theme menu writes it through the same patch helper. */
		saveFailed: boolean;
		/** The shell owns this too, so its Escape cascade can see the flyout stacked on the modal. */
		providerEditor: ProviderEditorState | null;
		/** The danger dialog is up for an endpoint, so neither backdrop should close. */
		confirmingProvider: boolean;
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
		saveFailed = $bindable(false),
		providerEditor = $bindable(null),
		confirmingProvider,
		patchImmediate,
		openDeleteProviderConfirm,
		closeSettings
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');

	let activeSettingsTab = $state<'general' | 'preferences' | 'models' | 'mcp' | 'about'>('general');
	let fieldErrors = $state<SettingsFieldErrors>({});
	const generalHasError = $derived(Boolean(fieldErrors.workspace));
	const modelsHasError = $derived(
		Boolean(
			providerEditor &&
				(providerEditor.errors.name ||
					providerEditor.errors.endpoint ||
					providerEditor.errors.endpointKey ||
					providerEditor.errors.models ||
					providerEditor.errors.defaultModel)
		)
	);

	let providerProbeTimer: ReturnType<typeof setTimeout> | null = null;
	/** URL + key the open editor last asked the endpoint about; the same pair is not probed twice. */
	let providerProbedSignature: string | null = null;

	// The flyout outlives no more than this component; a pending probe must not fire after it goes.
	$effect(() => () => resetProviderProbe());

	/** An endpoint deleted or replaced from elsewhere takes its open editor with it. */
	$effect(() => {
		const openEditor = providerEditor;
		if (
			openEditor &&
			openEditor.target !== 'add' &&
			!snapshot.providers.some((row) => row.id === openEditor.target)
		) {
			closeProviderEditor();
		}
	});

	function fieldCopy(kind: FieldErrorKind | undefined, empty: string, invalid: string): string {
		if (kind === 'empty') return empty;
		if (kind === 'invalid') return invalid;
		return '';
	}

	function clearWorkspaceError(): void {
		if (fieldErrors.workspace) fieldErrors = { ...fieldErrors, workspace: undefined };
	}

	/** A new endpoint has no key on file yet; an existing one's is whatever the snapshot says. */
	function editorKeySet(target: 'add' | string): boolean {
		if (target === 'add') return false;
		return snapshot.providers.find((row) => row.id === target)?.key_set ?? false;
	}

	/** Write into the open editor, but only while it is still that one — awaits can outlive it. */
	function patchProviderEditor(target: 'add' | string, patch: Partial<ProviderEditorState>): void {
		const editor = providerEditor;
		if (!editor || editor.target !== target) return;
		providerEditor = { ...editor, ...patch };
	}

	function setProviderDraft(draft: ProviderDraft): void {
		const editor = providerEditor;
		if (!editor) return;
		const synced = withSyncedDefaultModel(draft);
		providerEditor = { ...editor, draft: synced, errors: {}, failed: false };
		scheduleProviderProbe(editor.target, synced, editorKeySet(editor.target));
	}

	function resetProviderProbe(): void {
		if (providerProbeTimer) clearTimeout(providerProbeTimer);
		providerProbeTimer = null;
		providerProbedSignature = null;
	}

	/** Asks the endpoint for its models once the URL and key are usable, a moment after typing stops. */
	function scheduleProviderProbe(target: 'add' | string, draft: ProviderDraft, keySet: boolean): void {
		const signature = probeSignature(draft, keySet);
		if (providerProbeTimer) clearTimeout(providerProbeTimer);
		providerProbeTimer = null;
		if (!signature || signature === providerProbedSignature) return;
		providerProbeTimer = setTimeout(() => {
			providerProbeTimer = null;
			if (providerEditor?.target !== target) return;
			providerProbedSignature = signature;
			void fetchProviderModels();
		}, 700);
	}

	function openProviderEditor(target: 'add' | string, draft: ProviderDraft): void {
		resetProviderProbe();
		providerEditor = {
			target,
			draft,
			errors: {},
			failed: false,
			fetching: false,
			fetchError: null
		};
	}

	function openAddProvider(): void {
		openProviderEditor('add', emptyProviderDraft());
	}

	function openEditProvider(id: string): void {
		const provider = snapshot.providers.find((row) => row.id === id);
		if (!provider) return;
		const draft = draftFromProvider(provider);
		openProviderEditor(id, draft);
		// The stored URL + key count as already asked, so only changing one of them probes again.
		const signature = probeSignature(draft, provider.key_set);
		providerProbedSignature = signature;
		// Endpoints saved before the list was kept have nothing to show yet; ask once on open.
		if (provider.available_models.length === 0 && signature) void fetchProviderModels();
	}

	function closeProviderEditor(): void {
		resetProviderProbe();
		providerEditor = null;
	}

	async function fetchProviderModels(): Promise<void> {
		const editor = providerEditor;
		if (!editor) return;
		const { target } = editor;
		const baseUrl = editor.draft.baseUrl.trim();
		if (!baseUrl) {
			patchProviderEditor(target, { fetchError: t.settings.endpointEmpty });
			return;
		}
		const keySet = editorKeySet(target);
		const requested = probeSignature(editor.draft, keySet);
		patchProviderEditor(target, { fetching: true, fetchError: null });
		const res = await runtime.probeModels(
			baseUrl,
			editor.draft.apiKey,
			target === 'add' ? undefined : target
		);
		// The editor may have closed or moved to another URL / key while the request was out.
		const open = providerEditor;
		if (!open || open.target !== target || probeSignature(open.draft, keySet) !== requested) return;
		if (!res.ok) {
			providerEditor = {
				...open,
				fetching: false,
				fetchError: `${t.settings.modelsFetchFailed} (${res.error})`
			};
			return;
		}
		providerEditor = {
			...open,
			fetching: false,
			draft: applyProbedModels(open.draft, res),
			errors: {}
		};
	}

	async function saveProvider(): Promise<void> {
		const editor = providerEditor;
		if (!editor || editor.target === 'add') return;
		const id = editor.target;
		const provider = snapshot.providers.find((row) => row.id === id);
		if (!provider) return;
		patchProviderEditor(id, { failed: false });
		const plan = planPatchProvider(provider, editor.draft);
		if (!plan.ok) {
			patchProviderEditor(id, { errors: plan.errors });
			return;
		}
		if (Object.keys(plan.patch).length === 0) {
			closeProviderEditor();
			return;
		}
		const error = await runtime.patchProvider(id, plan.patch);
		if (error) {
			const mapped = mapProviderError(error.message);
			if ('top' in mapped) patchProviderEditor(id, { failed: true });
			else patchProviderEditor(id, { errors: mapped });
			return;
		}
		closeProviderEditor();
	}

	async function addProvider(): Promise<void> {
		const editor = providerEditor;
		if (!editor || editor.target !== 'add') return;
		patchProviderEditor('add', { failed: false });
		const plan = planCreateProvider(editor.draft, true);
		if (!plan.ok) {
			patchProviderEditor('add', { errors: plan.errors });
			return;
		}
		const error = await runtime.createProvider(plan.body);
		if (error) {
			const mapped = mapProviderError(error.message);
			if ('top' in mapped) patchProviderEditor('add', { failed: true });
			else patchProviderEditor('add', { errors: mapped });
			return;
		}
		closeProviderEditor();
	}

	async function setDefaultProvider(id: string): Promise<void> {
		saveFailed = false;
		const error = await runtime.patchSettings({ default_provider_id: id });
		if (error) saveFailed = true;
	}

	async function saveSettings(): Promise<void> {
		saveFailed = false;
		fieldErrors = {};
		const plan = planWorkspaceSave(runtime.workspacePath);
		if (!plan.ok) {
			fieldErrors = { workspace: plan.error };
			activeSettingsTab = 'general';
			return;
		}
		const error = await runtime.patchSettings({ workspace_path: plan.workspace_path });
		if (!error) {
			closeSettings();
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

{#if runtime.settingsOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal-backdrop"
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget && !providerEditor && !confirmingProvider)
				closeSettings();
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape' && !providerEditor && !confirmingProvider)
				closeSettings();
		}}
	>
		<div class="modal-dialog settings-modal">
			<aside class="settings-sidebar">
				<div class="settings-sidebar-head">
					<div class="settings-head-left">
						<svg class="settings-head-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
						</svg>
						<h2>{t.settings.title}</h2>
					</div>
					{#if !snapshot.settings.wizard_complete}
						<span class="settings-wizard-badge">{t.settings.wizardIncomplete}</span>
					{/if}
				</div>

				<div class="settings-tabs" role="tablist" aria-label={t.settings.title}>
					<button
						type="button"
						role="tab"
						aria-selected={activeSettingsTab === 'general'}
						class="settings-tab-btn"
						class:is-active={activeSettingsTab === 'general'}
						onclick={() => (activeSettingsTab = 'general')}
					>
						<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
						</svg>
						<span class="tab-name">{t.settings.tabGeneral}</span>
						{#if generalHasError}
							<span class="tab-badge-error" aria-label="error">!</span>
						{/if}
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeSettingsTab === 'preferences'}
						class="settings-tab-btn"
						class:is-active={activeSettingsTab === 'preferences'}
						onclick={() => (activeSettingsTab = 'preferences')}
					>
						<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<line x1="4" y1="21" x2="4" y2="14"></line>
							<line x1="4" y1="10" x2="4" y2="3"></line>
							<line x1="12" y1="21" x2="12" y2="12"></line>
							<line x1="12" y1="8" x2="12" y2="3"></line>
							<line x1="20" y1="21" x2="20" y2="16"></line>
							<line x1="20" y1="12" x2="20" y2="3"></line>
							<line x1="1" y1="14" x2="7" y2="14"></line>
							<line x1="9" y1="8" x2="15" y2="8"></line>
							<line x1="17" y1="16" x2="23" y2="16"></line>
						</svg>
						<span class="tab-name">{t.settings.tabPreferences}</span>
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeSettingsTab === 'models'}
						class="settings-tab-btn"
						class:is-active={activeSettingsTab === 'models'}
						onclick={() => (activeSettingsTab = 'models')}
					>
						<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
							<polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
							<line x1="12" y1="22.08" x2="12" y2="12"></line>
						</svg>
						<span class="tab-name">{t.settings.tabModels}</span>
						{#if modelsHasError}
							<span class="tab-badge-error" aria-label="error">!</span>
						{:else if snapshot.providers.length > 0}
							<span class="tab-count">{snapshot.providers.length}</span>
						{/if}
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeSettingsTab === 'mcp'}
						class="settings-tab-btn"
						class:is-active={activeSettingsTab === 'mcp'}
						onclick={() => (activeSettingsTab = 'mcp')}
					>
						<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
							<rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
							<line x1="6" y1="6" x2="6.01" y2="6"></line>
							<line x1="6" y1="18" x2="6.01" y2="18"></line>
						</svg>
						<span class="tab-name">{t.settings.tabMcp}</span>
						{#if snapshot.mcpServers.length > 0}
							<span class="tab-count">{snapshot.mcpServers.length}</span>
						{/if}
					</button>

					<button
						type="button"
						role="tab"
						aria-selected={activeSettingsTab === 'about'}
						class="settings-tab-btn"
						class:is-active={activeSettingsTab === 'about'}
						onclick={() => (activeSettingsTab = 'about')}
						title={updateChecker.updateVisible ? `${t.settings.tabAbout} · ${t.sidebar.updateAvailable}` : t.settings.tabAbout}
					>
						<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="10"></circle>
							<line x1="12" y1="16" x2="12" y2="12"></line>
							<line x1="12" y1="8" x2="12.01" y2="8"></line>
						</svg>
						<span class="tab-name">{t.settings.tabAbout}</span>
						{#if updateChecker.updateVisible}
							<span class="tab-badge-dot" aria-label={t.sidebar.updateAvailable}></span>
						{/if}
					</button>
				</div>
			</aside>

			<section class="settings-main">
				<div class="settings-main-head">
					<div class="settings-main-head-left">
						<h3 class="settings-main-title">
							{activeSettingsTab === 'general'
								? t.settings.tabGeneral
								: activeSettingsTab === 'preferences'
									? t.settings.tabPreferences
									: activeSettingsTab === 'models'
										? t.settings.tabModels
										: activeSettingsTab === 'mcp'
											? t.settings.tabMcp
											: t.settings.tabAbout}
						</h3>
					</div>
					<button
						type="button"
						class="modal-close"
						title={t.common.close}
						onclick={closeSettings}
					>✕</button>
				</div>

			<div class="modal-body" class:is-mcp={activeSettingsTab === 'mcp'}>
				{#if saveFailed}
					<p class="field-error">{t.settings.saveFailed}</p>
				{/if}
				{#if !snapshot.settings.wizard_complete}
					<div class="wizard-banner">
						<p class="muted">{t.settings.wizardHint}</p>
						<p class="muted">{t.settings.wizardIncomplete}</p>
					</div>
				{/if}

				{#if activeSettingsTab === 'general'}
					<div class="settings-tab-pane">
						<!-- Workspace Directory Section -->
						<div class="settings-card settings-card-workspace">
							<div class="settings-card-header">
								<div class="settings-card-header-main">
									<div class="settings-header-icon-wrap" aria-hidden="true">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
										</svg>
									</div>
									<div>
										<h3 class="settings-card-title">{t.settings.sectionWorkspace}</h3>
										<p class="settings-card-subtitle">{t.settings.workspaceSubtitle}</p>
									</div>
								</div>
								{#if runtime.workspacePath}
									<span class="settings-badge-ok">{t.settings.workspaceConfigured}</span>
								{:else}
									<span class="settings-badge-warn">{t.settings.workspaceUnsetNotice}</span>
								{/if}
							</div>

							<div class="settings-workspace-box">
								<WorkspacePicker
									id="workspace"
									path={runtime.workspacePath}
									chooseLabel={t.settings.workspaceChoose}
									changeLabel={t.settings.workspaceChange}
									emptyLabel={t.settings.workspaceUnsetValue}
									unavailableLabel={t.settings.workspacePickerUnavailable}
									dialogTitle={t.settings.workspaceChoose}
									onChange={(next: string) => {
										runtime.workspacePath = next;
										clearWorkspaceError();
									}}
								/>

								{#if fieldErrors.workspace}
									<div class="field-error-alert" role="alert">
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<circle cx="12" cy="12" r="10"></circle>
											<line x1="12" y1="8" x2="12" y2="12"></line>
											<line x1="12" y1="16" x2="12.01" y2="16"></line>
										</svg>
										<span>
											{fieldCopy(
												fieldErrors.workspace,
												t.settings.workspaceEmpty,
												t.settings.workspaceInvalid
											)}
										</span>
									</div>
								{/if}

								<div class="workspace-jail-callout">
									<svg class="jail-callout-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
									</svg>
									<div class="jail-callout-content">
										<span class="jail-callout-title">{t.settings.workspaceSecurityBoundary}</span>
										<p class="jail-callout-text">{JAIL_COPY[locale]}</p>
									</div>
								</div>
							</div>
						</div>
					</div>
				{:else if activeSettingsTab === 'preferences'}
					<div class="settings-tab-pane">
						<!-- Preferences Section -->
						<div class="settings-card settings-card-preferences">
							<div class="settings-card-header">
								<div class="settings-card-header-main">
									<div class="settings-header-icon-wrap" aria-hidden="true">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<line x1="4" y1="21" x2="4" y2="14"></line>
											<line x1="4" y1="10" x2="4" y2="3"></line>
											<line x1="12" y1="21" x2="12" y2="12"></line>
											<line x1="12" y1="8" x2="12" y2="3"></line>
											<line x1="20" y1="21" x2="20" y2="16"></line>
											<line x1="20" y1="12" x2="20" y2="3"></line>
											<line x1="1" y1="14" x2="7" y2="14"></line>
											<line x1="9" y1="8" x2="15" y2="8"></line>
											<line x1="17" y1="16" x2="23" y2="16"></line>
										</svg>
									</div>
									<div>
										<h3 class="settings-card-title">{t.settings.sectionPreferences}</h3>
										<p class="settings-card-subtitle">{t.settings.preferencesSubtitle}</p>
									</div>
								</div>
							</div>

							<div class="settings-rows">
								<!-- Theme Row -->
								<div class="settings-row">
									<div class="settings-row-info">
										<span class="settings-row-title" id="theme-setting-label">{t.settings.theme}</span>
										<span class="settings-row-desc">{t.settings.themeDesc}</span>
									</div>
									<div class="settings-row-action">
										<div class="segmented-control" role="group" aria-labelledby="theme-setting-label">
											<button
												type="button"
												class="segmented-btn"
												class:is-active={snapshot.settings.theme === 'system'}
												onclick={() => {
													themeManager.setTheme('system');
													void patchImmediate({ theme: 'system' });
												}}
											>
												<svg class="segmented-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
													<rect x="2" y="3" width="20" height="14" rx="2"></rect>
													<line x1="8" y1="21" x2="16" y2="21"></line>
													<line x1="12" y1="17" x2="12" y2="21"></line>
												</svg>
												<span>{t.settings.themeSystem}</span>
											</button>
											<button
												type="button"
												class="segmented-btn"
												class:is-active={snapshot.settings.theme === 'light'}
												onclick={() => {
													themeManager.setTheme('light');
													void patchImmediate({ theme: 'light' });
												}}
											>
												<svg class="segmented-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
													<circle cx="12" cy="12" r="5"></circle>
													<line x1="12" y1="1" x2="12" y2="3"></line>
													<line x1="12" y1="21" x2="12" y2="23"></line>
													<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
													<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
													<line x1="1" y1="12" x2="3" y2="12"></line>
													<line x1="21" y1="12" x2="23" y2="12"></line>
													<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
													<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
												</svg>
												<span>{t.settings.themeLight}</span>
											</button>
											<button
												type="button"
												class="segmented-btn"
												class:is-active={snapshot.settings.theme === 'dark'}
												onclick={() => {
													themeManager.setTheme('dark');
													void patchImmediate({ theme: 'dark' });
												}}
											>
												<svg class="segmented-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
													<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
												</svg>
												<span>{t.settings.themeDark}</span>
											</button>
										</div>
									</div>
								</div>

								<!-- Language Row -->
								<div class="settings-row">
									<div class="settings-row-info">
										<span class="settings-row-title" id="lang-setting-label">{t.settings.language}</span>
										<span class="settings-row-desc">{t.settings.languageDesc}</span>
									</div>
									<div class="settings-row-action">
										<div class="segmented-control" role="group" aria-labelledby="lang-setting-label">
											<button
												type="button"
												class="segmented-btn"
												class:is-active={locale === 'zh'}
												onclick={() => void patchImmediate({ locale: 'zh' })}
											>
												<span>{t.settings.localeZh}</span>
											</button>
											<button
												type="button"
												class="segmented-btn"
												class:is-active={locale === 'en'}
												onclick={() => void patchImmediate({ locale: 'en' })}
											>
												<span>{t.settings.localeEn}</span>
											</button>
										</div>
									</div>
								</div>

								<!-- Launch at login Row -->
								<div class="settings-row">
									<div class="settings-row-info">
										<span class="settings-row-title" id="launch-setting-label">{t.settings.launch}</span>
										<span class="settings-row-desc">{t.settings.launchDesc}</span>
									</div>
									<div class="settings-row-action">
										<label class="switch-toggle" for="launch-at-login-toggle" aria-labelledby="launch-setting-label">
											<input
												id="launch-at-login-toggle"
												type="checkbox"
												checked={snapshot.settings.launch_at_login}
												onchange={(ev) =>
													void patchImmediate({
														launch_at_login: (ev.currentTarget as HTMLInputElement).checked
													})}
											/>
											<span class="switch-track" aria-hidden="true">
												<span class="switch-thumb"></span>
											</span>
										</label>
									</div>
								</div>
							</div>
						</div>
					</div>
				{:else if activeSettingsTab === 'models'}
					<div class="settings-tab-pane">
						<div class="provider-list-head">
							<p class="muted">{t.settings.providersHint}</p>
							<button type="button" class="btn-provider-add" onclick={openAddProvider}>
								<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
								<span>{t.settings.providerAdd}</span>
							</button>
						</div>
						{#if snapshot.providers.length === 0}
							<div class="mcp-empty">
								<p class="muted">{t.settings.providerEmpty}</p>
							</div>
						{/if}
						<div class="provider-card-list">
							{#each snapshot.providers as provider (provider.id)}
								{@const isDefault = snapshot.settings.default_provider_id === provider.id}
								{@const palette = botAvatarColor(provider.id)}
								{@const host = providerHost(provider.base_url)}
								<div class="provider-card" class:is-default={isDefault}>
									<div class="provider-card-head">
										<button
											type="button"
											class="provider-card-identity"
											onclick={() => openEditProvider(provider.id)}
											title={`${t.settings.providerEdit}: ${provider.name}`}
										>
											<span
												class="provider-card-mark"
												style:background={palette.bg}
												style:color={palette.text}
												style:border-color={palette.border}
											>{rosterLetter(provider.name)}</span>
											<span class="provider-identity-text">
												<span class="provider-name-row">
													<span class="provider-card-name">{provider.name}</span>
													{#if isDefault}
														<span class="provider-badge-default" title={t.settings.providerDefault}>
															<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
															<span>{t.settings.providerDefault}</span>
														</span>
													{/if}
													<span class="provider-badge-key" class:is-set={provider.key_set} title={provider.key_set ? t.settings.keySet : t.settings.keyUnset}>
														<span class="provider-status-dot" class:is-set={provider.key_set}></span>
														<span>{provider.key_set ? t.settings.keySet : t.settings.keyUnset}</span>
													</span>
												</span>
												{#if host}
													<span class="provider-card-host mono" title={provider.base_url ?? ''}>
														<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
														<span>{host}</span>
													</span>
												{/if}
											</span>
										</button>

										<div class="provider-card-acts">
											{#if !isDefault}
												<button
													type="button"
													class="btn-provider-action btn-provider-setdefault"
													onclick={() => void setDefaultProvider(provider.id)}
													title={t.settings.providerSetDefault}
												>
													<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
													<span>{t.settings.providerSetDefault}</span>
												</button>
											{/if}
											<button
												type="button"
												class="btn-provider-action btn-provider-edit"
												aria-label={`${t.settings.providerEdit}: ${provider.name}`}
												onclick={() => openEditProvider(provider.id)}
												title={t.settings.providerEdit}
											>
												<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
												<span>{t.settings.providerEdit}</span>
											</button>
											<button
												type="button"
												class="btn-provider-action btn-provider-delete"
												aria-label={`${t.settings.providerDelete}: ${provider.name}`}
												onclick={() => openDeleteProviderConfirm(provider.id)}
												title={t.settings.providerDelete}
											>
												<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
											</button>
										</div>
									</div>

									{#if provider.default_model || provider.models.length > 0}
										<button
											type="button"
											class="provider-card-body-btn"
											onclick={() => openEditProvider(provider.id)}
											title={`${t.settings.providerEdit}: ${provider.name}`}
										>
											<div class="provider-meta-row">
												{#if provider.default_model}
													<div class="provider-default-model-tag" title={`${t.settings.defaultModel}: ${provider.default_model}`}>
														<span class="tag-icon">
															<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
														</span>
														<span class="tag-label">{t.settings.defaultModel}:</span>
														<span class="tag-val mono">{provider.default_model}</span>
													</div>
												{/if}
												<span class="provider-model-count-label">
													{t.settings.providerModelCount(provider.models.length)}
												</span>
											</div>

											{#if provider.models.length > 0}
												<div class="provider-model-chips">
													{#each provider.models.slice(0, 4) as model}
														<span class="provider-model-chip mono" class:is-default={model === provider.default_model}>
															{model}
														</span>
													{/each}
													{#if provider.models.length > 4}
														<span class="provider-model-chip is-overflow">
															+{provider.models.length - 4}
														</span>
													{/if}
												</div>
											{/if}
										</button>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{:else if activeSettingsTab === 'mcp'}
					<McpSettings {runtime} {t} />
				{:else if activeSettingsTab === 'about'}
					<div class="settings-tab-pane">
						<div class="settings-card settings-card-about">
							<div class="settings-card-header">
								<div class="settings-card-header-main">
									<div class="settings-header-icon-wrap" aria-hidden="true">
										<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
											<circle cx="12" cy="12" r="10"></circle>
											<line x1="12" y1="16" x2="12" y2="12"></line>
											<line x1="12" y1="8" x2="12.01" y2="8"></line>
										</svg>
									</div>
									<div>
										<h3 class="settings-card-title">{t.settings.sectionAbout}</h3>
										<p class="settings-card-subtitle">{t.settings.aboutSubtitle}</p>
									</div>
								</div>
							</div>

							<div class="settings-rows">
								<div class="settings-row">
									<div class="settings-row-info">
										<span class="settings-row-title">Real Bot</span>
										<span class="settings-row-desc">
											<span class="about-version-chip">{t.settings.version(updateChecker.version ?? '0.1.0-rc.1')}</span>
										</span>
									</div>
									{#if updateChecker.available}
										<div class="settings-row-action">
											<button
												type="button"
												class="btn-check-update"
												disabled={updateChecker.status === 'checking'}
												onclick={() => void updateChecker.checkNow()}
											>
												{#if updateChecker.status === 'checking'}
													<svg class="spin-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
														<circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
														<path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor"></path>
													</svg>
												{/if}
												<span>{updateChecker.status === 'checking' ? t.settings.checkingUpdates : t.settings.checkUpdates}</span>
											</button>
										</div>
									{/if}
								</div>
							</div>

							{#if updateChecker.available}
								{#if updateChecker.status === 'error'}
									<div class="about-status-banner is-error">
										<p class="about-status-text">{t.settings.updateFailed}</p>
									</div>
								{:else if updateChecker.result?.updateAvailable && updateChecker.result.latest}
									<div class="about-update-banner">
										<p class="about-update-title">{t.settings.updateAvailable(updateChecker.result.latest)}</p>
										<div class="about-actions">
											{#if updateChecker.result.downloadUrl}
												<button type="button" class="btn-xs btn-primary" onclick={() => void updateChecker.download()}>
													{t.settings.updateDownload}
												</button>
											{/if}
											{#if updateChecker.result.releaseUrl}
												<button type="button" class="btn-xs" onclick={() => void updateChecker.openNotes()}>
													{t.settings.updateNotes}
												</button>
											{/if}
											{#if updateChecker.ignoredVersion !== updateChecker.result.latest}
												<button type="button" class="btn-text-action" onclick={() => updateChecker.ignoreLatest()}>
													{t.settings.updateIgnore}
												</button>
											{/if}
										</div>
									</div>
								{:else if updateChecker.status === 'ok'}
									<div class="about-status-banner is-ok">
										<p class="about-status-text">{t.settings.upToDate}</p>
									</div>
								{/if}
							{/if}
						</div>
					</div>
				{/if}
			</div>
				<div class="modal-foot actions">
					<button type="button" onclick={() => void saveSettings()}>{t.settings.save}</button>
					<button type="button" onclick={closeSettings}>{t.common.close}</button>
				</div>
			</section>
		</div>
	</div>
{/if}
{#if runtime.settingsOpen && providerEditor}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal-backdrop provider-editor-backdrop"
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeProviderEditor();
		}}
	>
		<div class="modal-dialog provider-editor-modal">
			<div class="modal-head">
				<h2>
					{providerEditor.target === 'add' ? t.settings.providerAdd : t.settings.providerEdit}
				</h2>
				<button
					type="button"
					class="modal-close"
					title={t.common.close}
					onclick={closeProviderEditor}
				>✕</button>
			</div>
			<div class="modal-body">
				<ProviderForm
					draft={providerEditor.draft}
					errors={providerEditor.errors}
					failed={providerEditor.failed}
					fetching={providerEditor.fetching}
					fetchError={providerEditor.fetchError}
					fieldPrefix={providerEditor.target === 'add'
						? 'provider-add'
						: `provider-${providerEditor.target}`}
					keySet={editorKeySet(providerEditor.target)}
					{t}
					onchange={setProviderDraft}
					onfetch={() => void fetchProviderModels()}
				/>
			</div>
			<div class="modal-foot actions">
				{#if providerEditor.target === 'add'}
					<button type="button" onclick={() => void addProvider()}>{t.settings.providerAdd}</button>
				{:else}
					<button type="button" onclick={() => void saveProvider()}>{t.settings.providerSave}</button>
				{/if}
				<button type="button" onclick={closeProviderEditor}>{t.common.close}</button>
			</div>
		</div>
	</div>
{/if}