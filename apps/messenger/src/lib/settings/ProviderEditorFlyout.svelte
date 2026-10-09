<script lang="ts">
	import type { Snippet } from 'svelte';
	import { backdropClick } from '../click-outside.ts';
	import AutosaveState from './AutosaveState.svelte';
	import SettingsSubpageButton from './SettingsSubpageButton.svelte';
	import ProviderForm from './ProviderForm.svelte';
	import ConnectorPicker from './ConnectorPicker.svelte';
	import type { ConnectorId } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { providerHost, type ProviderDraft, type ProviderEditorState } from './provider-form.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		locale: 'zh' | 'en';
		/** The shell's bindable editor state, passed through the modal; this only reads it. */
		providerEditor: ProviderEditorState | null;
		providerForm: ProviderForm | undefined;
		providerDetailModel: string | null;
		providerSaving: boolean;
		providerSavedTick: number;
		/** The modal's pending-credential block, drawn at the top of the editor too. */
		pendingCredentials: Snippet;
		backFromProviderEditor: () => void;
		closeProviderEditor: () => void;
		editorKeySet: (target: 'add' | string) => boolean;
		setProviderDraft: (draft: ProviderDraft) => void;
		/** Adding: a built-in connector picked, or null for a custom endpoint (ADR 0072). */
		pickConnector: (id: ConnectorId | null) => void;
		fetchProviderModels: () => Promise<void>;
		persistProviderEditor: (editor: ProviderEditorState) => Promise<void>;
	};

	let {
		runtime,
		t,
		locale,
		providerEditor,
		providerForm = $bindable(),
		providerDetailModel = $bindable(),
		providerSaving,
		providerSavedTick,
		pendingCredentials,
		backFromProviderEditor,
		closeProviderEditor,
		editorKeySet,
		setProviderDraft,
		pickConnector,
		fetchProviderModels,
		persistProviderEditor
	}: Props = $props();
	/** Backdrop presses start outside these sheets; a drag out of one never closes them. */
	const providerBackdrop = backdropClick();
</script>

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
				<SettingsSubpageButton
					kind="back"
					label={providerDetailModel ? t.common.back : locale === 'en' ? 'Back to model providers' : '返回模型服务'}
					onclick={backFromProviderEditor}
				/>
				<h2>
					{#if providerDetailModel}
						{t.settings.modelSettings}
					{:else if providerEditor.target === 'add'}
						{t.settings.providerAdd}
					{:else if providerEditor.view === 'models'}
						{t.settings.providerModels}
					{:else}
						{t.settings.providerConnection}
					{/if}
				</h2>
				<AutosaveState {t} saving={providerSaving} failed={providerEditor.failed} saved={providerSavedTick > 0} />
				<button
					type="button"
					class="modal-close provider-editor-dismiss"
					title={t.common.close}
					onclick={closeProviderEditor}
				>✕</button>
				<!-- ✕ closes this editor; the list and settings behind it stay where they were. -->
				<SettingsSubpageButton kind="close" title={t.common.close} onclick={backFromProviderEditor} />
			</div>
			<div class="modal-body provider-editor-body">
				{@render pendingCredentials()}
				{#if providerEditor.target !== 'add'}
					<div class="provider-editor-context">
						<strong>{providerEditor.draft.name}</strong>
						<span>{providerHost(providerEditor.draft.baseUrl)}</span>
					</div>
				{/if}
				{#if providerEditor.picking}
				<ConnectorPicker {t} onpick={pickConnector} />
				{:else}
				{#key `${providerEditor.target}:${providerEditor.view}`}
				<ProviderForm
					bind:this={providerForm}
					bind:detailModel={providerDetailModel}
					draft={providerEditor.draft}
					errors={providerEditor.errors}
					failed={providerEditor.failed}
					fetching={providerEditor.fetching}
					fetchError={providerEditor.fetchError}
					view={providerEditor.view}
					fieldPrefix={providerEditor.target === 'add'
						? 'provider-add'
						: `provider-${providerEditor.target}`}
					keySet={editorKeySet(providerEditor.target)}
					{t}
					onchange={setProviderDraft}
					onfetch={() => void fetchProviderModels()}
					measure={providerEditor.target === 'add' ? undefined : (model) => runtime.speedTest(providerEditor!.target, model)}
				/>
				{/key}
				{/if}
			</div>
			<div class="provider-mobile-status" class:is-error={providerEditor.failed || Object.values(providerEditor.errors).some(Boolean)}>
				<span role="status">{providerSaving ? t.sidebar.autoSaving : providerEditor.failed || Object.values(providerEditor.errors).some(Boolean) ? t.settings.saveFailed : providerSavedTick > 0 ? t.sidebar.autoSaved : t.sidebar.autoSaveHint}</span>
				{#if providerEditor.failed}<button type="button" disabled={providerSaving} onclick={() => providerEditor && void persistProviderEditor(providerEditor)}>{t.settings.retry}</button>{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.provider-editor-modal :global(.modal-head) {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.provider-editor-modal :global(.modal-head h2) {
		flex: 1;
		min-width: 0;
	}

	.provider-editor-context, .provider-mobile-status { display: none; }

	.modal-dialog.provider-editor-modal {
		width: 580px;
		max-width: 95vw;
		max-height: 88vh;
	}

	@media (max-width: 720px) {
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

		.provider-editor-modal > .settings-subpage-head :global(.settings-save-state),
		.provider-editor-dismiss {
			display: none;
		}

		.provider-editor-modal > :global(.modal-body) {
			padding: 18px 14px max(32px, env(safe-area-inset-bottom));
			overscroll-behavior: contain;
		}
	}

	@keyframes settings-subpage-in {
		from { transform: translateX(20%); opacity: 0.72; }
		to { transform: translateX(0); opacity: 1; }
	}

	@media (max-width: 720px) {
		.provider-editor-modal > .provider-editor-body { padding: 20px 16px 24px; min-height: 0; }
		.provider-editor-context { display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px; }
		.provider-editor-context strong { font-size: 20px; font-weight: 650; overflow-wrap: anywhere; }
		.provider-editor-context span { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
		.provider-mobile-status { display: flex; flex-shrink: 0; align-items: center; justify-content: center; gap: 12px; min-height: calc(52px + env(safe-area-inset-bottom)); padding: 4px 16px calc(4px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: var(--pane); color: var(--muted); font-size: 12px; }
		.provider-mobile-status.is-error { color: var(--danger-text); }
		.provider-mobile-status button { min-height: 44px; padding: 4px 12px; border: 0; border-radius: var(--radius-sm); background: var(--danger-bg); color: var(--danger-text); }
		.provider-editor-modal :global(.settings-subpage-back), .provider-editor-modal :global(.settings-subpage-close) { width: 44px; }
	}
</style>
