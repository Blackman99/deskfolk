<script lang="ts">
	import McpSettings from './McpSettings.svelte';
	import { backdropClick } from '../click-outside.ts';
	import WorkspacePicker from './WorkspacePicker.svelte';
	import ProviderForm from './ProviderForm.svelte';
	import Select from '../Select.svelte';
	import type { CredentialOperation } from '../api.ts';
	import { JAIL_COPY, thinkingLevelLabel, type Copy } from '../copy.ts';
	import { copyText } from '../clipboard.ts';
	import { formatFingerprint } from '../remote/fingerprint.ts';
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
	import { botAvatarColor } from '../avatar.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import { themeManager } from '../theme.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { updateChecker } from '../update-checker.svelte.ts';
	import {
		formatBytes,
		installErrorCopyKey,
		installPercent,
		installPhaseCopyKey
	} from '../updates.ts';
	import { localeSection, releaseNoteGroups } from './release-notes.ts';
	import {
		mapSettingsError,
		planWorkspaceSave,
		type FieldErrorKind,
		type SettingsFieldErrors
	} from './wizard-save.ts';
	import {
		gatedIndependentStatus,
		invokeIndependentRuntime,
		setLaunchAtLogin,
		type IndependentStatus
	} from './independent-runtime.ts';

	type SettingsTab = 'general' | 'preferences' | 'models' | 'mcp' | 'about';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		/** The shell owns this: the sidebar's theme menu writes it through the same patch helper. */
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
	const providerBackdrop = backdropClick();

	const snapshot = $derived(runtime.snapshot);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	function deviceLastActive(value: number): string {
		return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
			year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
		}).format(new Date(value * 1000));
	}

	const credentialOps = $derived(snapshot.credentialOperations);
	let repairValues = $state<Record<string, string>>({});
	let hadPending = $state(false);
	$effect(() => {
		const open = runtime.settingsOpen;
		const pending = runtime.pendingMutation;
		if (pending) hadPending = true;
		else if (hadPending) {
			hadPending = false;
			closeProviderEditor();
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

	let activeSettingsTab = $state<SettingsTab>('general');
	let mobileSettingsDetail = $state(false);
	$effect(() => {
		if (!runtime.settingsOpen) mobileSettingsDetail = false;
	});

	function openSettingsTab(tab: SettingsTab): void {
		activeSettingsTab = tab;
		mobileSettingsDetail = typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches;
	}

	function settingsTabLabel(tab: SettingsTab): string {
		return tab === 'general'
			? t.settings.tabGeneral
			: tab === 'preferences'
				? t.settings.tabPreferences
				: tab === 'models'
					? t.settings.tabModels
					: tab === 'mcp'
						? t.settings.tabMcp
						: t.settings.tabAbout;
	}
	let independent = $state<IndependentStatus>(gatedIndependentStatus('g_pack_not_verified'));
	let independentBusy = $state(false);
	let independentConfirm = $state<'enable' | 'disable' | null>(null);
	$effect(() => {
		confirmingIndependent = independentConfirm !== null;
	});
	$effect(() => {
		if (!runtime.settingsOpen) {
			independentConfirm = null;
			return;
		}
		void refreshIndependent();
	});

	async function refreshIndependent(): Promise<void> {
		independent = await invokeIndependentRuntime('status');
	}

	function independentReason(status: IndependentStatus): string {
		if (status.diagnostic === 'dev_does_not_install_agent') return t.settings.independentRuntimeDev;
		if (status.diagnostic === 'browser_cannot_install_agent') return t.settings.independentRuntimeBrowser;
		if (status.error === 'bootstrap failed' || status.error === 'port_not_empty') return t.settings.independentRuntimeFailed;
		return t.settings.independentRuntimeGated;
	}

	async function onLaunchAtLogin(checked: boolean): Promise<void> {
		if (!(await patchImmediate({ launch_at_login: checked }))) return;
		await setLaunchAtLogin(checked);
	}

	function requestIndependent(next: boolean): void {
		if (independentBusy) return;
		independentConfirm = next ? 'enable' : 'disable';
	}

	async function confirmIndependent(): Promise<void> {
		const action = independentConfirm;
		if (!action) return;
		independentBusy = true;
		try {
			independent = await invokeIndependentRuntime(action);
			if (independent.drain.phase === 'draining') return;
			independentConfirm = null;
		} finally {
			independentBusy = false;
		}
	}

	async function waitIndependent(): Promise<void> {
		independentBusy = true;
		try {
			independent = await invokeIndependentRuntime('wait');
			if (independent.drain.phase !== 'draining') independentConfirm = null;
		} finally {
			independentBusy = false;
		}
	}

	async function forceIndependent(): Promise<void> {
		independentBusy = true;
		try {
			independent = await invokeIndependentRuntime('force');
			if (independent.drain.phase !== 'draining') independentConfirm = null;
		} finally {
			independentBusy = false;
		}
	}

	async function cancelIndependent(): Promise<void> {
		independentBusy = true;
		try {
			independent = await invokeIndependentRuntime('cancel');
			independentConfirm = null;
		} finally {
			independentBusy = false;
		}
	}

	/** What the release body says changed, drawn in the About card instead of only linked to. */
	const updateChanges = $derived(
		releaseNoteGroups(localeSection(updateChecker.result?.notes, locale))
	);
	/** The in-app download and swap, as the card draws it: phase, bar, failure. */
	const installPhaseKey = $derived(installPhaseCopyKey(updateChecker.install.phase));
	const installLabel = $derived(installPhaseKey ? t.settings[installPhaseKey] : '');
	const installPercentValue = $derived(installPercent(updateChecker.install));
	const installErrorLabel = $derived(t.settings[installErrorCopyKey(updateChecker.install.error)]);
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
	let providerSaveTimer: ReturnType<typeof setTimeout> | null = null;
	let providerSaving = $state(false);
	let providerSavedTick = $state(0);
	let workspaceSaving = $state(false);
	let pairingCopied = $state(false);

	/**
	 * The badge carries the state; the sentence under it only appears when the state needs
	 * explaining, so "online" does not spend a paragraph saying nothing.
	 */
	const remoteState = $derived(runtime.remoteStatus?.state ?? 'off');
	const remoteLabel = $derived(
		remoteState === 'online'
			? t.remote.statusOnline
			: remoteState === 'connecting'
				? t.remote.statusConnecting
				: remoteState === 'native_unavailable'
					? t.remote.statusUnavailable
					: remoteState === 'activation_gated'
						? t.remote.statusGated
						: remoteState === 'trust_mismatch'
							? t.remote.statusMismatch
							: remoteState === 'disconnected'
								? t.remote.statusDisconnected
								: t.remote.statusOff
	);
	const remoteTone = $derived(
		remoteState === 'online' ? 'ok' : remoteState === 'connecting' ? 'neutral' : remoteState === 'off' ? 'neutral' : 'warn'
	);
	const remoteExplains = $derived(remoteState === 'online' || remoteState === 'off' ? '' : t.remote.experimental);
	let workspaceSavedTick = $state(0);
	/** Latest editor draft, so a parent that nulls `providerEditor` still has something to flush. */
	let latestProviderEditor: ProviderEditorState | null = null;
	let persistQueue: ProviderEditorState[] = [];
	/** Create once per filled-in add draft; a close flush must not POST a second copy. */
	let lastCreatedSignature: string | null = null;

	const settingsSaving = $derived(workspaceSaving || (providerSaving && !providerEditor));
	const settingsSavedTick = $derived(workspaceSavedTick + (providerEditor ? 0 : providerSavedTick));

	// The flyout outlives no more than this component; a pending probe or draft must not fire after it goes.
	$effect(() => () => {
		resetProviderProbe();
		if (latestProviderEditor) flushProviderEditor(latestProviderEditor);
	});

	// Closing the editor, switching endpoints, or closing settings must send a pending draft first.
	$effect(() => {
		const editor = providerEditor;
		const pending = latestProviderEditor;
		if (pending && pending.target !== editor?.target) {
			flushProviderEditor(pending);
		}
		latestProviderEditor = editor;
	});

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
		scheduleProviderSave();
	}

	function resetProviderProbe(): void {
		if (providerProbeTimer) clearTimeout(providerProbeTimer);
		providerProbeTimer = null;
		providerProbedSignature = null;
	}

	function scheduleProviderSave(delay = 600): void {
		if (providerSaveTimer) clearTimeout(providerSaveTimer);
		providerSaveTimer = setTimeout(() => {
			providerSaveTimer = null;
			if (providerEditor) void persistProviderEditor(providerEditor);
		}, delay);
	}

	function flushProviderEditor(editor: ProviderEditorState): void {
		if (providerSaveTimer) {
			clearTimeout(providerSaveTimer);
			providerSaveTimer = null;
		}
		void persistProviderEditor(editor);
	}

	function createSignature(editor: ProviderEditorState): string {
		const plan = planCreateProvider(editor.draft, true);
		if (!plan.ok) return '';
		return JSON.stringify(plan.body);
	}

	async function persistProviderEditor(editor: ProviderEditorState): Promise<void> {
		if (providerSaving) {
			persistQueue = [editor];
			return;
		}
		if (editor.target === 'add') {
			const signature = createSignature(editor);
			if (!signature) return;
			if (signature === lastCreatedSignature) return;
			providerSaving = true;
			saveFailed = false;
			patchProviderEditor('add', { failed: false, errors: {} });
			const plan = planCreateProvider(editor.draft, true);
			if (!plan.ok) {
				providerSaving = false;
				patchProviderEditor('add', { errors: plan.errors });
				drainPersistQueue();
				return;
			}
			const before = new Set(snapshot.providers.map((row) => row.id));
			const error = await runtime.createProvider(plan.body);
			providerSaving = false;
			if (error) {
				const mapped = mapProviderError(error.message);
				if ('top' in mapped) {
					if (providerEditor?.target === 'add') patchProviderEditor('add', { failed: true });
					else saveFailed = true;
				} else if (providerEditor?.target === 'add') {
					patchProviderEditor('add', { errors: mapped });
				}
				drainPersistQueue();
				return;
			}
			lastCreatedSignature = signature;
			providerSavedTick += 1;
			persistQueue = [];
			const created = snapshot.providers.find((row) => !before.has(row.id));
			if (created && providerEditor?.target === 'add') {
				providerEditor = {
					...providerEditor,
					target: created.id,
					draft: { ...providerEditor.draft, apiKey: '' },
					errors: {},
					failed: false
				};
				void persistProviderEditor(providerEditor);
				return;
			}
			drainPersistQueue();
			return;
		}
		const id = editor.target;
		const provider = snapshot.providers.find((row) => row.id === id);
		if (!provider) return;
		const plan = planPatchProvider(provider, editor.draft);
		if (!plan.ok) {
			if (providerEditor?.target === id) patchProviderEditor(id, { errors: plan.errors, failed: false });
			return;
		}
		if (Object.keys(plan.patch).length === 0) return;
		providerSaving = true;
		saveFailed = false;
		if (providerEditor?.target === id) patchProviderEditor(id, { failed: false, errors: {} });
		const error = await runtime.patchProvider(id, plan.patch);
		providerSaving = false;
		if (error) {
			const mapped = mapProviderError(error.message);
			if ('top' in mapped) {
				if (providerEditor?.target === id) patchProviderEditor(id, { failed: true });
				else saveFailed = true;
			} else if (providerEditor?.target === id) {
				patchProviderEditor(id, { errors: mapped });
			}
			drainPersistQueue();
			return;
		}
		providerSavedTick += 1;
		drainPersistQueue();
	}

	function drainPersistQueue(): void {
		const next = persistQueue.shift();
		if (next) void persistProviderEditor(next);
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
		if (providerSaveTimer) {
			clearTimeout(providerSaveTimer);
			providerSaveTimer = null;
		}
		lastCreatedSignature = null;
		providerSavedTick = 0;
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
		const api = runtime.client;
		const res = await runtime.probeModels(
			baseUrl,
			editor.draft.apiKey,
			target === 'add' ? undefined : target
		);
		// The editor may have closed or moved to another URL / key while the request was out.
		const open = providerEditor;
		if (runtime.client !== api || !runtime.settingsOpen || !open || open.target !== target || probeSignature(open.draft, keySet) !== requested) return;
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
		scheduleProviderSave();
	}

	async function setDefaultProvider(id: string): Promise<void> {
		saveFailed = false;
		const api = runtime.client;
		const error = await runtime.patchSettings({ default_provider_id: id });
		if (runtime.client === api && runtime.settingsOpen && error) saveFailed = true;
	}

	const workspaceReadOnly = $derived(runtime.hosted && !runtime.remote);
	const workspaceRemoteBrowse = $derived(Boolean(runtime.remote));

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
		role="dialog"
		aria-modal="true"
		tabindex="-1"
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
			<aside class="settings-sidebar">
				<div class="settings-sidebar-head">
					<div class="settings-head-left flex items-center gap-5">
						<svg class="settings-head-icon text-muted shrink-0" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
						</svg>
						<h2>{t.settings.title}</h2>
					</div>
					<div class="settings-sidebar-actions">
						{#if !snapshot.settings.wizard_complete}
							<span class="settings-wizard-badge">{t.settings.wizardIncomplete}</span>
						{/if}
						<button
							type="button"
							class="modal-close settings-root-close"
							title={t.common.close}
							onclick={closeSettings}
						>✕</button>
					</div>
				</div>

						<nav class="settings-tabs" aria-label={t.settings.title}>
					<button
						type="button"
						class="settings-tab-btn"
						class:is-active={activeSettingsTab === 'general'}
						onclick={() => openSettingsTab('general')}
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
						class="settings-tab-btn"
						class:is-active={activeSettingsTab === 'preferences'}
						onclick={() => openSettingsTab('preferences')}
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
						class="settings-tab-btn"
						class:is-active={activeSettingsTab === 'models'}
						onclick={() => openSettingsTab('models')}
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
							<span class="tab-count text-11 font-semibold py-[1px] px-3 rounded-full bg-chip text-ink-secondary">{snapshot.providers.length}</span>
						{/if}
					</button>

					<button
						type="button"
						class="settings-tab-btn"
						class:is-active={activeSettingsTab === 'mcp'}
						onclick={() => openSettingsTab('mcp')}
					>
						<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
							<rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
							<line x1="6" y1="6" x2="6.01" y2="6"></line>
							<line x1="6" y1="18" x2="6.01" y2="18"></line>
						</svg>
						<span class="tab-name">{t.settings.tabMcp}</span>
						{#if snapshot.mcpServers.length > 0}
							<span class="tab-count text-11 font-semibold py-[1px] px-3 rounded-full bg-chip text-ink-secondary">{snapshot.mcpServers.length}</span>
						{/if}
					</button>

					<button
						type="button"
						class="settings-tab-btn"
						class:is-active={activeSettingsTab === 'about'}
						onclick={() => openSettingsTab('about')}
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
				</nav>
			</aside>

			<section class="settings-main">
				<div class="settings-main-head">
					<button
						type="button"
						class="settings-mobile-back"
						aria-label={locale === 'en' ? 'Back to settings' : '返回设置'}
						onclick={() => (mobileSettingsDetail = false)}
					>
						<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
					</button>
					<div class="settings-main-head-left flex items-center gap-5">
						<h3 class="settings-main-title">{settingsTabLabel(activeSettingsTab)}</h3>
						<span class="settings-save-state text-12 text-muted whitespace-nowrap" class:is-error={saveFailed} aria-live="polite">
							{#if settingsSaving}
								{t.sidebar.autoSaving}
							{:else if saveFailed}
								{t.settings.saveFailed}
							{:else if settingsSavedTick > 0}
								{t.sidebar.autoSaved}
							{:else}
								{t.sidebar.autoSaveHint}
							{/if}
						</span>
					</div>
					<button
						type="button"
						class="modal-close"
						title={t.common.close}
						onclick={closeSettings}
					>✕</button>
				</div>

			<div class="modal-body" class:is-mcp={activeSettingsTab === 'mcp'}>
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

				{#if activeSettingsTab === 'general'}
					<div class="settings-tab-pane">
						{#if runtime.remote || runtime.remoteStatus}
							<div class="settings-card settings-card-remote">
								<div class="settings-card-header">
									<div class="settings-card-header-main">
										<div>
											<h3 class="settings-card-title">{t.settings.remoteSection}</h3>
											<p class="settings-card-subtitle">{t.settings.remoteSubtitle}</p>
										</div>
										<span class="settings-badge-{remoteTone}" data-testid="remote-state">{remoteLabel}</span>
									</div>
								</div>
								{#if remoteExplains}
									<p class="muted">{remoteLabel === t.remote.statusGated ? t.remote.experimental : remoteExplains}</p>
								{/if}

								{#if !runtime.remote && runtime.remoteStatus?.state === 'online'}
									<div class="pairing" data-testid="remote-pairing">
										{#if !runtime.hostPairing}
											<div class="pairing-invite">
												<p class="pairing-invite-text">
													{runtime.remoteStatus.devices === 0
														? t.remote.hostPairEmpty
														: t.remote.devices(runtime.remoteStatus.devices)}
												</p>
												<button
													type="button"
													class="btn-pair"
													class:is-quiet={runtime.remoteStatus.devices > 0}
													disabled={runtime.hostPairingBusy}
													onclick={() => void runtime.startHostPairing()}
												>
													{t.remote.hostPair}
												</button>
											</div>
										{:else if runtime.hostPairing.phase === 'offer' || runtime.hostPairing.phase === 'confirm'}
											<ol class="pairing-steps">
												<li>
													<p class="pairing-step-text">{t.remote.hostPairPaste}</p>
													<div class="pairing-code-row">
														<code class="pairing-code mono" data-testid="pairing-code">{runtime.hostPairing.code}</code>
														<button
															type="button"
															class="btn-xs pairing-copy"
															data-testid="pairing-copy"
															onclick={() => {
																copyText(runtime.hostPairing && 'code' in runtime.hostPairing ? runtime.hostPairing.code : '');
																pairingCopied = true;
															}}
														>
															{pairingCopied ? t.chat.copied : t.chat.copyMessage}
														</button>
													</div>
												</li>
												<li>
													<p class="pairing-step-text">{t.remote.hostPairFingerprint}</p>
													<p class="pairing-fingerprint mono">{formatFingerprint(runtime.hostPairing.fingerprint)}</p>
												</li>
												<li>
													{#if runtime.hostPairing.phase === 'offer'}
														<p class="pairing-step-text pairing-waiting">{t.remote.hostPairWaiting}</p>
													{:else}
														<p class="pairing-step-text">{t.remote.hostPairArrived(runtime.hostPairing.name)}</p>
														<p class="pairing-fingerprint mono">{formatFingerprint(runtime.hostPairing.deviceFingerprint)}</p>
														<p class="pairing-step-note">{t.remote.hostPairCompare}</p>
														<div class="pairing-decide">
															<button
																type="button"
																class="btn-pair"
																data-testid="pairing-confirm"
																disabled={runtime.hostPairingBusy}
																onclick={() => void runtime.confirmHostPairing()}
															>
																{t.remote.hostPairApprove}
															</button>
															<button type="button" class="btn-xs" disabled={runtime.hostPairingBusy} onclick={() => runtime.closeHostPairing()}>
																{t.sidebar.cancel}
															</button>
														</div>
													{/if}
												</li>
											</ol>
											{#if runtime.hostPairing.phase === 'offer'}
												<button type="button" class="btn-xs pairing-dismiss" disabled={runtime.hostPairingBusy} onclick={() => runtime.closeHostPairing()}>
													{t.sidebar.cancel}
												</button>
											{/if}
										{:else if runtime.hostPairing.phase === 'paired'}
											<p class="pairing-done" data-testid="pairing-done">{t.remote.hostPairDone}</p>
											<button type="button" class="btn-xs pairing-dismiss" onclick={() => runtime.closeHostPairing()}>{t.common.close}</button>
										{:else}
											<div class="pairing-failed" role="alert">
												<p class="pairing-failed-text">
													{runtime.hostPairing.error === 'expired' ? t.remote.hostPairExpired : t.remote.hostPairFailed}
												</p>
												<div class="pairing-failed-actions">
													<button type="button" class="btn-pair" disabled={runtime.hostPairingBusy} onclick={() => void runtime.startHostPairing()}>
														{t.remote.hostPairRetry}
													</button>
													<button type="button" class="btn-xs" onclick={() => runtime.closeHostPairing()}>{t.common.close}</button>
												</div>
											</div>
										{/if}
									</div>
									<div class="connected-devices" data-testid="host-devices">
										<div class="connected-devices-head">
											<h4 class="settings-card-title">{t.remote.connectedDevices}</h4>
											<button type="button" class="btn-xs" disabled={runtime.hostDevicesBusy} onclick={() => void runtime.refreshHostDevices()}>{t.remote.refreshStatus}</button>
										</div>
										{#if runtime.hostDevicesError}
											<p class="field-error">{t.remote.deviceActionFailed}</p>
										{/if}
										{#if runtime.hostDevices.length === 0}
											<p class="muted">{t.remote.connectedDevicesEmpty}</p>
										{:else}
											<ul class="settings-device-list">
												{#each runtime.hostDevices as device (device.id)}
													<li>
														<div class="device-copy">
															<strong>{device.name}</strong>
															<span>{device.lastActiveAt ? t.remote.lastActive(deviceLastActive(device.lastActiveAt)) : t.remote.lastActiveUnknown}</span>
														</div>
														<div class="device-actions">
															<button type="button" class="btn-xs" data-testid={`host-remove-${device.id}`} disabled={runtime.hostDevicesBusy} onclick={() => { runtime.hostRemoveDeviceId = device.id; }}>{t.remote.removeDevice}</button>
															{#if runtime.hostRemoveDeviceId === device.id}
																<button type="button" class="btn-danger-xs" data-testid={`host-remove-confirm-${device.id}`} disabled={runtime.hostDevicesBusy} onclick={() => void runtime.removeHostDevice(device.id)}>{t.remote.removeDeviceConfirm(device.name)}</button>
															{/if}
														</div>
													</li>
												{/each}
											</ul>
										{/if}
									</div>
								{:else if runtime.remoteStatus && !runtime.remote}
									<p class="muted">{t.remote.devices(runtime.remoteStatus.devices)}</p>
								{/if}

								<p class="pairing-footnote">{t.remote.noOfflineQueue}</p>
								{#if runtime.remote}
									<p class="muted">{t.remote.uvNeeded}</p>
									{#if runtime.uvError}
										<p class="field-error">{t.remote.uvFailed}</p>
									{/if}
									{#if !runtime.uvReady}
										<button type="button" onclick={() => void runtime.registerUv()}>{t.remote.uvRegister}</button>
									{/if}
									<div class="settings-maintenance" data-testid="remote-maintenance">
										<h4 class="settings-card-title">{t.remote.maintenance}</h4>
										<p class="muted">{t.remote.maintenanceLead}</p>
										{#if runtime.maintenance}
											<p data-testid="remote-version">{t.remote.version(runtime.maintenance.version)}</p>
											<p data-testid="remote-mode">
												{runtime.maintenance.mode === 'window'
													? t.remote.modeWindow
													: runtime.maintenance.mode === 'standalone'
														? t.remote.modeStandalone
														: t.remote.modeNone}
											</p>
											<p data-testid="remote-restart">
												{runtime.maintenance.restart === 'available'
													? t.remote.restartAvailable
													: t.remote.restartUnavailable}
											</p>
											<p data-testid="remote-drain">
												{runtime.maintenance.drain.phase === 'draining'
													? t.remote.drainWaiting(runtime.maintenance.drain.remaining)
													: runtime.maintenance.drain.phase === 'drained'
														? (runtime.maintenance.drain.forced ? t.remote.drainForced : t.remote.drainDrained)
														: t.remote.drainRunning}
											</p>
										{/if}
										<p class="muted">{t.remote.reconnectHint}</p>
										{#if runtime.maintenanceError}
											<p class="field-error" data-testid="remote-maintenance-error">
												{runtime.maintenanceError === 'draining'
													? t.remote.errorDraining
													: runtime.maintenanceError === 'restart_unavailable'
														? t.remote.errorUnavailable
														: runtime.maintenanceError === 'cancelled'
															? t.remote.errorCancelled
															: runtime.maintenanceError === 'request_unknown'
																? t.remote.errorUnknown
																: t.remote.errorUv}
											</p>
										{/if}
										<div class="settings-maintenance-actions">
											<button type="button" data-testid="remote-refresh" onclick={() => void runtime.refreshMaintenance()}>{t.remote.refreshStatus}</button>
											<button type="button" data-testid="remote-diagnostics" disabled={runtime.maintenanceBusy || !runtime.uvReady} onclick={() => void runtime.downloadDiagnostics()}>{t.remote.downloadDiagnostics}</button>
											<button type="button" data-testid="remote-drain-restart" disabled={runtime.maintenanceBusy || !runtime.uvReady || runtime.maintenance?.restart !== 'available'} onclick={() => void runtime.restartRuntime(false)}>{t.remote.drainRestart}</button>
											<button type="button" data-testid="remote-force-restart" disabled={runtime.maintenanceBusy || !runtime.uvReady || runtime.maintenance?.restart !== 'available'} onclick={() => { runtime.maintenanceForceConfirm = true; }}>{t.remote.forceRestart}</button>
											<button type="button" data-testid="remote-stop" disabled={runtime.maintenanceBusy || !runtime.uvReady} onclick={() => { runtime.maintenanceStopConfirm = true; }}>{t.remote.stopRuntime}</button>
										</div>
										{#if runtime.maintenanceForceConfirm}
											<p class="field-error">{t.remote.forceWarn}</p>
											<button type="button" data-testid="remote-force-confirm" onclick={() => void runtime.restartRuntime(true)}>{t.remote.forceConfirm}</button>
											<button type="button" onclick={() => { runtime.maintenanceForceConfirm = false; }}>{t.common.close}</button>
										{/if}
										{#if runtime.maintenanceStopConfirm}
											<p class="field-error">{t.remote.stopWarn}</p>
											<button type="button" data-testid="remote-stop-confirm" onclick={() => void runtime.stopRuntime()}>{t.remote.stopConfirm}</button>
											<button type="button" onclick={() => { runtime.maintenanceStopConfirm = false; }}>{t.common.close}</button>
										{/if}
										<p class="muted">{t.remote.revokeOther}</p>
										{#if runtime.otherRemoteDevices().length === 0}
											<p class="muted">{t.remote.noOtherDevices}</p>
										{:else}
											<ul class="settings-device-list">
												{#each runtime.otherRemoteDevices() as device (device.id)}
													<li>
														<span>{device.name}</span>
														<button type="button" data-testid={`remote-revoke-${device.id}`} disabled={runtime.maintenanceBusy || !runtime.uvReady} onclick={() => { runtime.maintenanceRevokeId = device.id; }}>{t.remote.revokeOther}</button>
														{#if runtime.maintenanceRevokeId === device.id}
															<button type="button" data-testid={`remote-revoke-confirm-${device.id}`} onclick={() => void runtime.revokeRemoteDevice(device.id)}>{t.remote.revokeConfirm(device.name)}</button>
														{/if}
													</li>
												{/each}
											</ul>
										{/if}
									</div>
									<div class="settings-row">
										<div class="settings-row-info">
											<span class="settings-row-title" id="push-setting-label">{t.remote.push}</span>
											<span class="settings-row-desc">{t.remote.pushDesc}</span>
										</div>
										<div class="settings-row-action">
											<label class="switch-toggle relative inline-flex items-center cursor-pointer select-none" for="remote-push-toggle" aria-labelledby="push-setting-label">
												<input
													id="remote-push-toggle"
													type="checkbox"
													checked={runtime.pushEnabled}
													disabled={runtime.pushBusy || runtime.pushPermission === 'unsupported'}
													onchange={(ev) =>
														void runtime.setPushEnabled((ev.currentTarget as HTMLInputElement).checked)}
												/>
												<span class="switch-track" aria-hidden="true">
													<span class="switch-thumb"></span>
												</span>
											</label>
										</div>
									</div>
									{#if runtime.pushPermission === 'denied'}
										<p class="muted">{t.remote.pushDenied}</p>
									{/if}
									{#if runtime.pushPermission === 'unsupported'}
										<p class="muted">{t.remote.pushUnsupported}</p>
									{/if}
									{#if runtime.pushError === 'failed'}
										<p class="field-error">{t.remote.pushFailed}</p>
									{/if}
								{/if}
							</div>
						{/if}
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

							<div class="settings-workspace-box flex flex-col gap-5 mt-2">
								{#if workspaceReadOnly}
									<div class="workspace-readonly">
										<p class="workspace-readonly-path mono">{runtime.workspacePath.trim() || t.settings.workspaceUnsetValue}</p>
										<p class="muted field-hint">{t.settings.workspaceHostOnly}</p>
									</div>
								{:else}
									<WorkspacePicker
										id="workspace"
										path={runtime.workspacePath}
										chooseLabel={t.settings.workspaceChoose}
										changeLabel={t.settings.workspaceChange}
										emptyLabel={t.settings.workspaceUnsetValue}
										unavailableLabel={t.settings.workspacePickerUnavailable}
										dialogTitle={t.settings.workspaceChoose}
										remote={workspaceRemoteBrowse}
										api={runtime.client}
										browseHint={t.settings.workspaceBrowseRemote}
										permissionHint={t.settings.workspaceAuthorizeMac}
										truncatedHint={t.stream.workspaceTruncated}
										confirmHint={t.settings.workspaceConfirmRoot}
										upLabel={t.settings.workspaceUp}
										useLabel={t.settings.workspaceUseFolder}
										cancelLabel={t.sidebar.cancel}
										onChange={(next: string) => {
											runtime.workspacePath = next;
											clearWorkspaceError();
											void persistWorkspace(next);
										}}
									/>
								{/if}

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
									<svg class="jail-callout-icon shrink-0 text-accent mt-1" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
									</svg>
									<div class="jail-callout-content flex flex-col gap-[3px] min-w-0">
										<span class="jail-callout-title text-11p5 font-semibold text-accent tracking-[0.01em]">{t.settings.workspaceSecurityBoundary}</span>
										<p class="jail-callout-text m-0 text-11p5 leading-[1.45] text-muted">{JAIL_COPY[locale]}</p>
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
										<label class="switch-toggle relative inline-flex items-center cursor-pointer select-none" for="launch-at-login-toggle" aria-labelledby="launch-setting-label">
											<input
												id="launch-at-login-toggle"
												type="checkbox"
												checked={snapshot.settings.launch_at_login}
												onchange={(ev) =>
													void onLaunchAtLogin((ev.currentTarget as HTMLInputElement).checked)}
											/>
											<span class="switch-track" aria-hidden="true">
												<span class="switch-thumb"></span>
											</span>
										</label>
									</div>
								</div>

								<div class="settings-row">
									<div class="settings-row-info">
										<span class="settings-row-title" id="independent-runtime-label">{t.settings.independentRuntime}</span>
										<span class="settings-row-desc">{t.settings.independentRuntimeDesc}</span>
										{#if !independent.available || independent.error}
											<span class="settings-row-desc" data-independent-reason>{independentReason(independent)}</span>
										{/if}
									</div>
									<div class="settings-row-action">
										<label
											class="switch-toggle relative inline-flex items-center select-none"
											class:is-disabled={!independent.available}
											for="independent-runtime-toggle"
											aria-labelledby="independent-runtime-label"
										>
											<input
												id="independent-runtime-toggle"
												type="checkbox"
												checked={independent.enabled}
												disabled={independentBusy}
												onchange={(ev) => {
													const next = (ev.currentTarget as HTMLInputElement).checked;
													ev.currentTarget.checked = independent.enabled;
													requestIndependent(next);
												}}
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
						<div class="provider-list-head flex items-start justify-between gap-6">
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
						<div class="provider-card-list flex flex-col gap-5">
							{#each snapshot.providers as provider (provider.id)}
								{@const isDefault = snapshot.settings.default_provider_id === provider.id}
								{@const palette = botAvatarColor(provider.id)}
								{@const host = providerHost(provider.base_url)}
								<div class="provider-card" class:is-default={isDefault}>
									<div class="provider-card-head flex items-center justify-between gap-5 min-w-0">
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
											<span class="provider-identity-text min-w-0 flex flex-col gap-[3px] flex-1">
												<span class="provider-name-row flex items-center gap-4 flex-wrap min-w-0">
													<span class="provider-card-name text-14 font-semibold text-ink leading-[1.2]">{provider.name}</span>
													{#if isDefault}
														<span class="provider-badge-default" title={t.settings.providerDefault}>
															<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
															<span>{t.settings.providerDefault}</span>
														</span>
													{/if}
													<span class="provider-badge-key" class:is-set={provider.key_set} title={provider.key_set ? t.settings.keySet : t.settings.keyUnset}>
														<span class="provider-status-dot w-3 h-3 rounded-[50%] bg-warn shrink-0" class:is-set={provider.key_set}></span>
														<span>{provider.key_set ? t.settings.keySet : t.settings.keyUnset}</span>
													</span>
												</span>
												{#if host}
													<span class="provider-card-host mono inline-flex items-center gap-[5px] text-11p5 text-muted overflow-hidden text-ellipsis whitespace-nowrap max-w-full" title={provider.base_url ?? ''}>
														<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
														<span>{host}</span>
													</span>
												{/if}
											</span>
										</button>

										<div class="provider-card-acts flex items-center gap-3 shrink-0">
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
											<div class="provider-meta-row flex items-center justify-between gap-4 flex-wrap w-full">
												{#if provider.default_model}
													<div class="provider-default-model-tag" title={`${t.settings.defaultModel}: ${provider.default_model}`}>
														<span class="tag-icon">
															<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
														</span>
														<span class="tag-label">{t.settings.defaultModel}:</span>
														<span class="tag-val mono">{provider.default_model}</span>
													</div>
												{/if}
												<span class="provider-model-count-label text-11p5 text-muted font-medium ml-auto">
													{t.settings.providerModelCount(provider.models.length)}
												</span>
											</div>

											{#if provider.models.length > 0}
												<div class="provider-model-chips flex items-center gap-[5px] flex-wrap w-full">
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
					<McpSettings {runtime} {t} {closeSettings} />
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
											<span class="about-version-chip inline-block font-mono text-11p5 text-muted">{t.settings.version(updateChecker.version ?? '0.1.0-rc.5')}</span>
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
									<div class="about-status-banner is-error mt-5 py-4 px-6 rounded-md text-12">
										<p class="about-status-text m-0 leading-[1.4]">{t.settings.updateFailed}</p>
									</div>
								{:else if updateChecker.result?.updateAvailable && updateChecker.result.latest}
									<div class="about-update-banner">
										<p class="about-update-title m-0 text-12p5 font-semibold text-accent">{t.settings.updateAvailable(updateChecker.result.latest)}</p>
										{#if updateChanges.length > 0}
											<div class="about-notes">
												<p class="about-notes-title">{t.settings.updateChanges}</p>
												{#each updateChanges as group, groupIndex (groupIndex)}
													{#if group.heading}
														<p class="about-notes-heading">{group.heading}</p>
													{/if}
													<ul class="about-notes-list">
														{#each group.items as item, itemIndex (itemIndex)}
															<li>{item}</li>
														{/each}
													</ul>
												{/each}
											</div>
										{/if}
										{#if updateChecker.installing}
											<div class="about-install">
												<div class="about-install-head">
													<span class="about-install-phase">{installLabel}</span>
													{#if updateChecker.install.total}
														<span class="about-install-bytes">
															{formatBytes(updateChecker.install.downloaded)} / {formatBytes(updateChecker.install.total)}
														</span>
													{/if}
												</div>
												<div
													class="about-progress"
													role="progressbar"
													aria-label={installLabel}
													aria-valuemin={0}
													aria-valuemax={100}
													aria-valuenow={installPercentValue ?? undefined}
												>
													<div
														class="about-progress-fill"
														class:is-indeterminate={installPercentValue === null}
														style={installPercentValue === null
															? undefined
															: `width: ${installPercentValue}%`}
													></div>
												</div>
												{#if updateChecker.install.phase === 'downloading'}
													<button
														type="button"
														class="btn-text-action self-start"
														onclick={() => void updateChecker.cancelInstall()}
													>
														{t.settings.updateInstallCancel}
													</button>
												{/if}
											</div>
										{:else}
											{#if updateChecker.install.phase === 'failed'}
												<div class="about-install-failed">
													<p class="m-0 text-12 leading-[1.4]">{installErrorLabel}</p>
													{#if updateChecker.install.detail}
														<p class="about-install-detail">{updateChecker.install.detail}</p>
													{/if}
												</div>
											{/if}
											<div class="about-actions flex items-center flex-wrap gap-4">
												{#if updateChecker.installable}
													<button type="button" class="btn-xs btn-primary" onclick={() => void updateChecker.startInstall()}>
														{updateChecker.install.phase === 'failed'
															? t.settings.updateInstallRetry
															: t.settings.updateInstall}
													</button>
												{/if}
												{#if updateChecker.result.downloadUrl}
													<button
														type="button"
														class="btn-xs"
														class:btn-primary={!updateChecker.installable}
														onclick={() => void updateChecker.download()}
													>
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
											{#if updateChecker.installable && updateChecker.install.phase !== 'failed'}
												<p class="about-install-hint">{t.settings.updateInstallHint}</p>
											{/if}
										{/if}
									</div>
								{:else if updateChecker.status === 'ok'}
									<div class="about-status-banner is-ok mt-5 py-4 px-6 rounded-md text-12">
										<p class="about-status-text m-0 leading-[1.4]">{t.settings.upToDate}</p>
									</div>
								{/if}
							{/if}
						</div>
					</div>
				{/if}
			</div>
			</section>
		</div>
	</div>
{/if}
{#if runtime.settingsOpen && providerEditor}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal-backdrop provider-editor-backdrop z-[110]"
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		onmousedowncapture={providerBackdrop.press}
		onclick={(e) => {
			if (providerBackdrop.isOutside(e)) closeProviderEditor();
		}}
	>
		<div class="modal-dialog provider-editor-modal settings-subpage">
			<div class="modal-head settings-subpage-head">
				<button
					type="button"
					class="settings-subpage-back"
					aria-label={locale === 'en' ? 'Back to model providers' : '返回模型服务'}
					onclick={closeProviderEditor}
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
				</button>
				<h2>
					{providerEditor.target === 'add' ? t.settings.providerAdd : t.settings.providerEdit}
				</h2>
				<span class="settings-save-state text-12 text-muted whitespace-nowrap" class:is-error={providerEditor.failed} aria-live="polite">
					{#if providerSaving}
						{t.sidebar.autoSaving}
					{:else if providerEditor.failed}
						{t.settings.saveFailed}
					{:else if providerSavedTick > 0}
						{t.sidebar.autoSaved}
					{:else}
						{t.sidebar.autoSaveHint}
					{/if}
				</span>
				<button
					type="button"
					class="modal-close provider-editor-dismiss"
					title={t.common.close}
					onclick={closeProviderEditor}
				>✕</button>
				<button
					type="button"
					class="modal-close settings-subpage-close"
					title={t.common.close}
					onclick={closeSettings}
				>✕</button>
			</div>
			<div class="modal-body">
				{@render pendingCredentials()}
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
		</div>
	</div>
{/if}
{#if runtime.settingsOpen && independentConfirm}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		class="modal-backdrop confirm-backdrop z-[120]"
		role="dialog"
		aria-modal="true"
		aria-labelledby="independent-runtime-confirm-title"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget && independent.drain.phase !== 'draining') void cancelIndependent();
		}}
	>
		<div class="modal-dialog confirm-dialog">
			<div class="modal-head">
				<h2 id="independent-runtime-confirm-title">
					{independentConfirm === 'enable'
						? t.settings.independentRuntimeConfirmEnable
						: t.settings.independentRuntimeConfirmDisable}
				</h2>
				<button type="button" class="modal-close" title={t.common.close} onclick={() => void cancelIndependent()}>✕</button>
			</div>
			<div class="modal-body">
				<p class="confirm-copy">
					{independentConfirm === 'enable'
						? t.settings.independentRuntimeConfirmEnableBody
						: t.settings.independentRuntimeConfirmDisableBody}
				</p>
				{#if independent.drain.phase === 'draining'}
					<p class="confirm-copy" data-independent-waiting>{t.settings.independentRuntimeWaiting}</p>
				{/if}
				{#if independent.error}
					<p class="confirm-copy" data-independent-error>{independentReason(independent)}</p>
				{/if}
			</div>
			<div class="modal-foot actions">
				{#if independent.drain.phase === 'draining'}
					<button type="button" onclick={() => void waitIndependent()}>{t.settings.independentRuntimeWaiting}</button>
					<button type="button" class="deny" onclick={() => void forceIndependent()}>{t.settings.independentRuntimeForce}</button>
					<button type="button" onclick={() => void cancelIndependent()}>{t.settings.independentRuntimeCancel}</button>
				{:else}
					<button type="button" onclick={() => void cancelIndependent()}>{t.settings.independentRuntimeCancel}</button>
					<button type="button" class="deny" onclick={() => void confirmIndependent()}>{t.settings.independentRuntimeConfirm}</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-dialog.settings-modal {
		width: 880px;
		max-width: 94vw;
		height: 640px;
		max-height: 88vh;
		flex-direction: row;
	}

	.settings-wizard-badge {
		font-size: 11.5px;
		font-weight: 500;
		padding: 2px 8px;
		border-radius: 9999px;
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
	}

	/* Settings Split Layout */
	.settings-sidebar {
		width: 220px;
		flex-shrink: 0;
		background: var(--sidebar-bg);
		border-right: 1px solid var(--line);
		display: flex;
		flex-direction: column;
		user-select: none;
	}

	.settings-sidebar-head {
		padding: 0 18px;
		height: 56px;
		border-bottom: 1px solid var(--line);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		box-sizing: border-box;
		flex-shrink: 0;
	}

	.settings-sidebar-head .settings-head-left {
		display: flex;
		align-items: center;
		gap: 9px;
		min-width: 0;
	}

	.settings-sidebar-head :global(h2) {
		margin: 0;
		font-size: 16px;
		font-weight: 700;
		color: var(--ink);
		white-space: nowrap;
	}

	.settings-sidebar-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.settings-sidebar-head .settings-wizard-badge {
		font-size: 11px;
		flex-shrink: 0;
	}

	.settings-root-close,
	.settings-mobile-back,
	.settings-subpage-back,
	.settings-subpage-close {
		display: none;
	}

	.settings-sidebar .settings-tabs {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px 10px;
		background: transparent;
		border-bottom: none;
		flex: 1;
		overflow-y: auto;
	}

	.settings-sidebar .settings-tab-btn {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 12px;
		border-radius: var(--radius-md);
		font-size: 13.5px;
		font-weight: 500;
		color: var(--ink-secondary);
		background: transparent;
		border: 1px solid transparent;
		transition: all 0.15s ease;
		user-select: none;
		cursor: pointer;
		box-sizing: border-box;
		text-align: left;
	}

	.settings-sidebar .settings-tab-btn:hover {
		color: var(--ink);
		background: var(--row-hover);
	}

	.settings-sidebar .settings-tab-btn.is-active {
		color: var(--accent);
		background: var(--pane);
		border-color: var(--line);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}

	.settings-sidebar .settings-tab-btn .tab-icon {
		opacity: 0.75;
		flex-shrink: 0;
	}

	.settings-sidebar .settings-tab-btn.is-active .tab-icon {
		opacity: 1;
		stroke: var(--accent);
	}

	.settings-sidebar .settings-tab-btn .tab-name {
		flex: 1;
	}

	.settings-sidebar .settings-tab-btn .tab-badge-error,
	.settings-sidebar .settings-tab-btn .tab-badge-dot,
	.settings-sidebar .settings-tab-btn .tab-count {
		margin-left: auto;
		flex-shrink: 0;
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
		font-size: 15.5px;
		font-weight: 600;
		color: var(--ink);
	}

	.settings-save-state {
		font-weight: 500;
	}

	.settings-save-state.is-error {
		color: var(--danger);
	}

	.provider-editor-modal :global(.modal-head) {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.provider-editor-modal :global(.modal-head h2) {
		flex: 1;
		min-width: 0;
	}

	.settings-subpage-back,
	.settings-subpage-close {
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
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


	/* Settings Category Tabs (Base fallback) */
	.settings-tabs {
		display: flex;
		gap: 6px;
		padding: 8px 18px;
		background: var(--sidebar-bg);
		border-bottom: 1px solid var(--line);
	}

	.settings-tab-btn {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 6px 14px;
		border-radius: var(--radius-sm);
		font-size: 13px;
		font-weight: 500;
		color: var(--muted);
		background: transparent;
		border: 1px solid transparent;
		transition: all 0.15s ease;
		user-select: none;
		cursor: pointer;
	}

	.settings-tab-btn:hover {
		color: var(--ink);
		background: rgba(0, 0, 0, 0.04);
	}

	.settings-tab-btn.is-active {
		color: var(--accent);
		background: var(--pane);
		border-color: var(--line);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}

	.settings-tab-btn .tab-icon {
		opacity: 0.7;
		flex-shrink: 0;
	}

	.settings-tab-btn.is-active .tab-icon {
		opacity: 1;
		stroke: var(--accent);
	}

	.tab-badge-error {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		background: var(--danger);
		color: #ffffff;
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		margin-left: 2px;
	}

	.tab-badge-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--danger);
		margin-left: auto;
		flex-shrink: 0;
		box-shadow: 0 0 0 2px var(--sidebar-bg);
	}

	.settings-sidebar .settings-tab-btn.is-active .tab-badge-dot {
		box-shadow: 0 0 0 2px var(--pane);
	}

	.settings-sidebar .settings-tab-btn:hover .tab-badge-dot {
		box-shadow: 0 0 0 2px var(--row-hover);
	}

	.settings-tab-btn.is-active .tab-count {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.settings-tab-pane {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.settings-card {
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		padding: 16px 18px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		box-shadow: var(--shadow-xs);
	}

	.provider-list-head :global(.muted) {
		margin: 0;
		flex: 1;
	}

	.btn-provider-add {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		padding: 6px 12px;
		border-radius: var(--radius-sm);
		border: 1.5px dashed var(--line);
		background: var(--sidebar-bg);
		color: var(--accent);
		font-size: 12.5px;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.btn-provider-add:hover {
		border-color: var(--accent);
		background: var(--accent-tint);
	}

	.btn-provider-add:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.provider-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-xs);
		transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
	}

	.provider-card:hover,
	.provider-card:focus-within {
		border-color: var(--accent-border);
		box-shadow: var(--shadow-sm);
	}

	.provider-card.is-default {
		border-color: var(--accent-border);
		background: linear-gradient(180deg, var(--accent-tint) 0%, var(--pane) 38px);
		box-shadow: 0 0 0 1px var(--accent-border), var(--shadow-xs);
	}

	.provider-card-identity {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 1;
		min-width: 0;
		border: none;
		background: transparent;
		padding: 0;
		text-align: left;
		cursor: pointer;
		color: inherit;
		border-radius: var(--radius-sm);
	}

	.provider-card-identity:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.provider-card-mark {
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
		border: 1px solid;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 15px;
		font-weight: 700;
		flex: 0 0 auto;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
	}

	.provider-badge-default {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		font-weight: 600;
		padding: 1.5px 7px;
		border-radius: 9999px;
		background: var(--accent-tint);
		color: var(--accent);
		border: 1px solid var(--accent-border);
		flex-shrink: 0;
		line-height: 1.3;
	}

	.provider-badge-key {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11px;
		font-weight: 500;
		padding: 1.5px 7px;
		border-radius: 9999px;
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
		flex-shrink: 0;
		line-height: 1.3;
	}

	.provider-badge-key.is-set {
		background: var(--ok-bg);
		border-color: var(--ok-line);
		color: var(--ok-text);
	}

	.provider-status-dot.is-set {
		background: var(--ok);
		box-shadow: 0 0 4px var(--ok);
	}

	.provider-card-host :global(svg) {
		flex-shrink: 0;
		opacity: 0.75;
	}

	.btn-provider-action {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		color: var(--ink-secondary);
		transition: all 0.15s ease;
		line-height: 1.2;
	}

	.btn-provider-action:hover {
		border-color: var(--accent);
		color: var(--accent);
		background: var(--accent-tint);
	}

	.btn-provider-action:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.btn-provider-action.btn-provider-delete {
		background: transparent;
		border-color: transparent;
		color: var(--muted);
		padding: 4px 6px;
	}

	.btn-provider-action.btn-provider-delete:hover {
		color: var(--danger);
		background: var(--danger-bg);
		border-color: var(--danger-line);
	}

	/* Card Body Button (clickable area for models / default model) */
	.provider-card-body-btn {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
		border: none;
		background: transparent;
		padding: 8px 0 0 0;
		border-top: 1px solid var(--line);
		text-align: left;
		cursor: pointer;
		color: inherit;
		border-radius: var(--radius-sm);
	}

	.provider-card-body-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.provider-default-model-tag {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		padding: 2px 8px;
		border-radius: var(--radius-sm);
		background: var(--chip);
		border: 1px solid var(--chip-line);
		color: var(--ink-secondary);
		max-width: 100%;
	}

	.provider-default-model-tag .tag-icon {
		display: inline-flex;
		color: var(--accent);
		flex-shrink: 0;
	}

	.provider-default-model-tag .tag-label {
		color: var(--muted);
		font-size: 11px;
	}

	.provider-default-model-tag .tag-val {
		font-weight: 600;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.provider-model-chip {
		font-size: 11px;
		padding: 2px 7px;
		border-radius: 4px;
		background: var(--sidebar-bg);
		border: 1px solid var(--line);
		color: var(--ink-secondary);
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		transition: all 0.12s ease;
	}

	.provider-card:hover .provider-model-chip {
		border-color: var(--chip-line);
	}

	.provider-model-chip.is-default {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
		font-weight: 600;
	}

	.provider-model-chip.is-overflow {
		font-size: 10.5px;
		font-weight: 500;
		color: var(--muted);
		background: transparent;
		border-style: dashed;
	}

	.modal-dialog.provider-editor-modal {
		width: 580px;
		max-width: 95vw;
		max-height: 88vh;
	}

	.settings-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.settings-card-header-main {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.settings-header-icon-wrap {
		width: 30px;
		height: 30px;
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		color: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.settings-card-subtitle {
		margin: 2px 0 0;
		font-size: 11.5px;
		color: var(--muted);
		line-height: 1.35;
	}

	.settings-badge-ok,
	.settings-badge-neutral,
	.settings-badge-warn {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: 9999px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.01em;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.settings-badge-ok {
		background: var(--ok-bg);
		border: 1px solid var(--ok-line);
		color: var(--ok);
	}

	.settings-badge-warn {
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn);
	}

	.settings-badge-neutral {
		background: var(--chip);
		border: 1px solid var(--line);
		color: var(--ink-secondary);
	}

	.connected-devices {
		display: flex;
		flex-direction: column;
		gap: 9px;
	}

	.connected-devices-head,
	.settings-device-list li,
	.device-actions {
		display: flex;
		align-items: center;
	}

	.connected-devices-head,
	.settings-device-list li {
		justify-content: space-between;
		gap: 12px;
	}

	.settings-device-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.settings-device-list li {
		padding: 11px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
	}

	.device-copy {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 12.5px;
	}

	.device-copy span {
		font-size: 11.5px;
		color: var(--muted);
	}

	.device-actions {
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 6px;
	}

	.btn-danger-xs {
		color: var(--danger);
		border-color: color-mix(in srgb, var(--danger) 42%, var(--line));
		background: color-mix(in srgb, var(--danger) 8%, transparent);
	}

	/* Pairing is a short sequence with one action at its end, so it reads as steps rather than
	   as another stack of paragraphs inside the card. */
	.pairing {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.pairing-invite {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 14px;
		border: 1px dashed var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
	}

	.pairing-invite-text {
		margin: 0;
		font-size: 12.5px;
		color: var(--ink-secondary);
	}

	.btn-pair {
		align-self: flex-start;
		padding: 7px 14px;
		border-radius: var(--radius-md);
		border: 1px solid var(--accent);
		background: var(--accent);
		color: #fff;
		font-size: 12.5px;
		font-weight: 600;
		white-space: nowrap;
	}

	.btn-pair:hover:not(:disabled) {
		filter: brightness(1.08);
	}

	.btn-pair:disabled {
		opacity: 0.55;
		cursor: default;
	}

	/* A second device is routine, so the button steps back to match the rest of the card. */
	.btn-pair.is-quiet {
		background: var(--btn-secondary-bg);
		border-color: var(--line);
		color: var(--accent);
	}

	.pairing-steps {
		counter-reset: pairing-step;
		list-style: none;
		margin: 0;
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--sidebar-bg);
	}

	.pairing-steps li {
		counter-increment: pairing-step;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding-left: 26px;
		position: relative;
	}

	.pairing-steps li::before {
		content: counter(pairing-step);
		position: absolute;
		left: 0;
		top: 1px;
		width: 18px;
		height: 18px;
		border-radius: 9999px;
		border: 1px solid var(--line);
		background: var(--pane);
		color: var(--ink-secondary);
		font-size: 10.5px;
		font-weight: 600;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.pairing-step-text {
		margin: 0;
		font-size: 12.5px;
		color: var(--ink);
		line-height: 1.5;
	}

	.pairing-step-note {
		margin: 0;
		font-size: 11.5px;
		color: var(--ink-secondary);
	}

	.pairing-waiting {
		color: var(--ink-secondary);
	}

	/* Wrapping follows the card, not the viewport: this panel also renders inside a narrow pane. */
	.pairing-code-row {
		display: flex;
		flex-wrap: wrap;
		align-items: stretch;
		gap: 8px;
	}

	.pairing-code {
		flex: 1 1 200px;
		min-width: 0;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink-secondary);
		font-size: 11px;
		line-height: 1.5;
		/* The whole code matters, so it wraps instead of hiding its tail behind an ellipsis. */
		overflow-wrap: anywhere;
		max-height: 72px;
		overflow-y: auto;
	}

	.pairing-copy {
		align-self: flex-start;
	}

	.pairing-decide {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 2px;
	}

	.pairing-fingerprint {
		margin: 0;
		font-size: 11.5px;
		line-height: 1.6;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.pairing-dismiss {
		align-self: flex-start;
	}

	.pairing-done {
		margin: 0;
		font-size: 12.5px;
		color: var(--ok);
	}

	.pairing-failed {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px 14px;
		border: 1px solid var(--warn-line);
		border-radius: var(--radius-md);
		background: var(--warn-bg);
	}

	.pairing-failed-text {
		margin: 0;
		font-size: 12.5px;
		color: var(--warn-text);
	}

	.pairing-failed-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.pairing-footnote {
		margin: 0;
		font-size: 11.5px;
		color: var(--ink-tertiary, var(--ink-secondary));
		opacity: 0.85;
	}

	.field-error-alert {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-radius: var(--radius-md);
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
		font-size: 12px;
		font-weight: 500;
	}

	.field-error-alert :global(svg) {
		flex-shrink: 0;
		color: var(--warn);
	}

	.workspace-readonly {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.workspace-readonly-path {
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 8px 12px;
		background: var(--input-bg);
		color: var(--ink);
		word-break: break-all;
	}

	.workspace-jail-callout {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 14px;
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		border: 1px solid var(--accent-border);
	}

	/* Preferences Rows */
	.settings-rows {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--line-subtle);
		margin-top: 4px;
	}

	.settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 2px;
		border-bottom: 1px solid var(--line-subtle);
		transition: background 0.15s ease;
	}

	.settings-row:last-child {
		border-bottom: none;
		padding-bottom: 2px;
	}

	.settings-row-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		flex: 1;
	}

	.settings-row-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
		line-height: 1.3;
	}

	.settings-row-desc {
		font-size: 11.5px;
		color: var(--muted);
		line-height: 1.35;
	}

	.settings-row-action {
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}

	/* Segmented Control (macOS Native Pill Switcher) */
	.segmented-control {
		display: inline-flex;
		align-items: center;
		background: var(--chip);
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-md);
		padding: 3px;
		gap: 2px;
	}

	.segmented-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 11px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
		user-select: none;
		white-space: nowrap;
	}

	.segmented-btn:hover:not(.is-active) {
		color: var(--ink);
		background: var(--line-subtle);
	}

	.segmented-btn.is-active {
		background: var(--pane);
		color: var(--accent);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}

	.segmented-icon {
		flex-shrink: 0;
	}

	.switch-toggle :global(input) {
		position: absolute;
		opacity: 0;
		width: 0;
		height: 0;
		margin: 0;
		pointer-events: none;
	}

	.switch-track {
		display: block;
		width: 40px;
		height: 22px;
		border-radius: 9999px;
		background: var(--chip-line);
		transition: background-color 0.2s ease, box-shadow 0.2s ease;
		position: relative;
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.08);
	}

	.switch-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #ffffff;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
		transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}.switch-toggle input:checked + .switch-track{
		background: var(--accent);
	}.switch-toggle input:checked + .switch-track .switch-thumb{
		transform: translateX(18px);
	}.switch-toggle input:focus-visible + .switch-track{
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.switch-toggle.is-disabled {
		opacity: 0.55;
	}

	.btn-check-update {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-secondary);
		background: var(--btn-secondary-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		cursor: pointer;
		box-shadow: var(--shadow-xs);
		transition: all 0.15s ease;
	}

	.btn-check-update:hover:not(:disabled) {
		background: var(--line-subtle);
		border-color: var(--line-hover);
		color: var(--ink);
	}

	.btn-check-update:disabled {
		opacity: 0.65;
		cursor: not-allowed;
	}

	.spin-icon {
		animation: spin 1s linear infinite;
	}

	.about-status-banner.is-ok {
		background: var(--ok-bg);
		border: 1px solid var(--ok-line);
		color: var(--ok);
	}

	.about-status-banner.is-error {
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
	}

	.about-update-banner {
		margin-top: 10px;
		padding: 10px 12px;
		border-radius: var(--radius-md);
		background: var(--accent-tint);
		border: 1px solid var(--accent-border);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* The in-app download: the phase on the left, how far along on the right, one bar under both. */
	.about-install {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.about-install-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.about-install-phase {
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.about-install-bytes {
		font-family: var(--mono);
		font-size: 11.5px;
		color: var(--muted);
	}

	.about-progress {
		height: 5px;
		border-radius: 999px;
		background: var(--line-subtle);
		overflow: hidden;
	}

	.about-progress-fill {
		height: 100%;
		width: 0;
		border-radius: 999px;
		background: var(--accent);
		transition: width 0.2s ease;
	}

	/* No Content-Length to divide by: the bar sweeps instead of claiming a number. */
	.about-progress-fill.is-indeterminate {
		width: 40%;
		animation: about-progress-sweep 1.2s ease-in-out infinite;
	}

	@keyframes about-progress-sweep {
		0% {
			transform: translateX(-110%);
		}
		100% {
			transform: translateX(260%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.about-progress-fill.is-indeterminate {
			width: 100%;
			animation: none;
		}
	}

	.about-install-failed {
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: var(--warn-text);
	}

	.about-install-detail {
		margin: 0;
		font-family: var(--mono);
		font-size: 11px;
		line-height: 1.4;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	.about-install-hint {
		margin: 2px 0 0;
		font-size: 11.5px;
		line-height: 1.4;
		color: var(--muted);
	}

	/*
	 * The changelog section that came with the check. Long enough to need its own scroll, so it
	 * keeps to a height the card can spare and never pushes the buttons out of reach.
	 */
	.about-notes {
		max-height: 168px;
		overflow-y: auto;
		padding-right: 4px;
		scrollbar-width: thin;
		scrollbar-color: var(--accent-border) transparent;
	}

	.about-notes-title {
		margin: 0 0 4px;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.about-notes-heading {
		margin: 8px 0 2px;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
	}

	.about-notes-heading:first-of-type {
		margin-top: 0;
	}

	.about-notes-list {
		margin: 0;
		padding-left: 16px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.about-notes-list li {
		font-size: 12px;
		line-height: 1.45;
		color: var(--ink-secondary);
	}

	@media (max-width: 540px) {
	.settings-row {
	flex-direction: column;
	align-items: flex-start;
	gap: 8px;
	}
	}

	@media (max-width: 540px) {
	.settings-row-action {
	width: 100%;
	justify-content: flex-end;
	}
	}

	@media (max-width: 540px) {
	.segmented-control {
	width: 100%;
	display: flex;
	}
	}

	@media (max-width: 540px) {
	.segmented-btn {
	flex: 1;
	justify-content: center;
	}
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
	.settings-modal .modal-body.is-mcp {
		min-height: 0;
		overflow: hidden;
	}

	.settings-sidebar,

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

		.settings-sidebar {
			position: absolute;
			inset: 0;
			width: 100%;
			border: 0;
			background: var(--sidebar-bg);
			padding-bottom: env(safe-area-inset-bottom);
			transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
		}

		.settings-sidebar-head {
			height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 12px 0 18px;
			background: var(--pane);
		}

		.settings-sidebar-head :global(h2) {
			font-size: 17px;
		}

		.settings-head-icon {
			display: none;
		}

		.settings-root-close {
			display: inline-flex;
			width: 36px;
			height: 36px;
			font-size: 16px;
		}

		.settings-sidebar .settings-tabs {
			display: flex;
			flex-direction: column;
			overflow-y: auto;
			padding: 20px 12px 32px;
			gap: 0;
			background: var(--sidebar-bg);
		}

		.settings-sidebar .settings-tab-btn {
			width: 100%;
			min-height: 54px;
			padding: 0 14px;
			border: 0;
			border-radius: 0;
			background: var(--pane);
			font-size: 15px;
			color: var(--ink);
			box-shadow: none;
		}

		.settings-sidebar .settings-tab-btn:first-child {
			border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		}

		.settings-sidebar .settings-tab-btn:last-child {
			border-radius: 0 0 var(--radius-lg) var(--radius-lg);
		}

		.settings-sidebar .settings-tab-btn + .settings-tab-btn::before {
			content: '';
			position: absolute;
			left: 44px;
			right: 0;
			top: 0;
			height: 1px;
			background: var(--line);
		}

		.settings-sidebar .settings-tab-btn {
			position: relative;
		}

		.settings-sidebar .settings-tab-btn:hover,
		.settings-sidebar .settings-tab-btn.is-active {
			color: var(--ink);
			background: var(--pane);
			border-color: transparent;
			box-shadow: none;
			font-weight: 500;
		}

		.settings-sidebar .settings-tab-btn:active {
			background: var(--row-hover);
		}

		.settings-sidebar .settings-tab-btn .tab-icon,
		.settings-sidebar .settings-tab-btn.is-active .tab-icon {
			display: block;
			width: 19px;
			height: 19px;
			opacity: 0.78;
			stroke: currentColor;
		}

		.settings-sidebar .settings-tab-btn::after {
			content: '';
			width: 8px;
			height: 8px;
			border-top: 1.8px solid var(--muted);
			border-right: 1.8px solid var(--muted);
			transform: rotate(45deg);
			margin: 0 3px 0 5px;
			flex-shrink: 0;
		}

		.settings-sidebar .settings-tab-btn .tab-badge-dot {
			margin-left: auto;
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

		.settings-modal.is-mobile-detail .settings-sidebar {
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

		.settings-main-head .settings-save-state {
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

		.settings-card {
			border-radius: var(--radius-lg);
			padding: 15px;
			box-shadow: none;
		}

		.provider-editor-backdrop {
			padding: 0;
			align-items: stretch;
			background: var(--sidebar-bg);
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
		}

		.modal-dialog.provider-editor-modal {
			width: 100%;
			max-width: none;
			height: 100%;
			max-height: none;
			border: 0;
			border-radius: 0;
			box-shadow: none;
			animation: settings-subpage-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
			background: var(--sidebar-bg);
		}

		.provider-editor-modal > .settings-subpage-head {
			height: calc(56px + env(safe-area-inset-top));
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 8px 0;
			gap: 4px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
		}

		.provider-editor-modal > .settings-subpage-head h2 {
			text-align: center;
			font-size: 16px;
			font-weight: 650;
		}

		.provider-editor-modal > .settings-subpage-head .settings-save-state,
		.provider-editor-dismiss {
			display: none;
		}

		.settings-subpage-back,
		.settings-subpage-close {
			display: inline-flex;
			width: 40px;
			height: 44px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			cursor: pointer;
		}

		.settings-subpage-close {
			font-size: 16px;
			color: var(--muted);
		}

		.settings-subpage-back:active,
		.settings-subpage-close:active {
			background: var(--row-hover);
		}

		.provider-editor-modal > :global(.modal-body) {
			padding: 18px 14px max(32px, env(safe-area-inset-bottom));
			overscroll-behavior: contain;
		}

		.provider-card {
			padding: 13px;
			box-shadow: none;
		}

		.provider-card-head {
			align-items: flex-start;
		}

		.provider-card-acts {
			gap: 6px;
		}

		.btn-provider-action {
			min-height: 40px;
		}

		.btn-provider-setdefault span,
		.btn-provider-edit span {
			display: none;
		}
	}

	@keyframes settings-subpage-in {
		from { transform: translateX(20%); opacity: 0.72; }
		to { transform: translateX(0); opacity: 1; }
	}


	@media (max-width: 540px) {
	.settings-device-list li {
		align-items: flex-start;
		flex-direction: column;
	}
	.device-actions {
		width: 100%;
		justify-content: flex-start;
	}
	.settings-device-list button {
		min-height: 44px;
	}
	}

	@media (max-width: 540px) {
	.settings-tabs {
	padding-inline: 10px;
	gap: 4px;
	}
	}

	@media (max-width: 540px) {
	.settings-tab-btn {
	min-width: 0;
	padding-inline: 6px;
	gap: 4px;
	font-size: 12px;
	white-space: nowrap;
	}
	}

	@media (max-width: 540px) {
	.settings-tab-btn .tab-icon {
	display: none;
	}
	}

	/* Only the settings modal spins anything; Svelte renames this and the reference together. */
	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}
</style>
