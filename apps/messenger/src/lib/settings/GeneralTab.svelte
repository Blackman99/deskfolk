<script lang="ts">
	import Icon from '../Icon.svelte';
	import SettingsCard from './SettingsCard.svelte';
	import SettingsCardHeader from './SettingsCardHeader.svelte';
	import WorkspacePicker from './WorkspacePicker.svelte';
	import PermissionModeCard from './PermissionModeCard.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import Switch from '../Switch.svelte';
	import { WORKSPACE_COPY, type Copy } from '../copy.ts';
	import { DEFAULT_PERMISSION_MODE } from '@real-bot/protocol';
	import { themeManager } from '../theme.ts';
	import { focusMode } from '../chat/focus-mode.svelte.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Snapshot } from '../snapshot.ts';
	import type { FieldErrorKind, SettingsFieldErrors } from './wizard-save.ts';
	import { setLaunchAtLogin, type IndependentStatus } from './independent-runtime.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		snapshot: Snapshot;
		locale: 'zh' | 'en';
		patchImmediate: (patch: {
			locale?: 'zh' | 'en';
			theme?: 'system' | 'light' | 'dark';
			launch_at_login?: boolean;
		}) => Promise<boolean>;
		/** A hosted shell has no host to write to; the path is shown, not picked. */
		workspaceReadOnly: boolean;
		fieldErrors: SettingsFieldErrors;
		clearWorkspaceError: () => void;
		persistWorkspace: (path: string) => Promise<void>;
		independent: IndependentStatus;
		independentBusy: boolean;
		independentReason: (status: IndependentStatus) => string;
		requestIndependent: (next: boolean) => void;
	};

	let {
		runtime,
		t,
		snapshot,
		locale,
		patchImmediate,
		workspaceReadOnly,
		fieldErrors,
		clearWorkspaceError,
		persistWorkspace,
		independent,
		independentBusy,
		independentReason,
		requestIndependent
	}: Props = $props();

	const workspaceRemoteBrowse = $derived(Boolean(runtime.remote));

	function fieldCopy(kind: FieldErrorKind | undefined, empty: string, invalid: string): string {
		if (kind === 'empty') return empty;
		if (kind === 'invalid') return invalid;
		return '';
	}

	async function onLaunchAtLogin(checked: boolean): Promise<void> {
		if (!(await patchImmediate({ launch_at_login: checked }))) return;
		await setLaunchAtLogin(checked);
	}
</script>

<div class="settings-tab-pane">
	<!-- Workspace Directory Section -->
	<SettingsCard class="settings-card-workspace">
		<SettingsCardHeader title={t.settings.sectionWorkspace} subtitle={t.settings.workspaceSubtitle}>
			{#snippet icon()}
				<div class="settings-header-icon-wrap" aria-hidden="true">
					<Icon name="folder" />
				</div>
			{/snippet}
			{#snippet end()}
				{#if runtime.workspacePath}
					<span class="settings-badge-ok">{t.settings.workspaceConfigured}</span>
				{:else}
					<span class="settings-badge-warn">{t.settings.workspaceUnsetNotice}</span>
				{/if}
			{/snippet}
		</SettingsCardHeader>

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
					<Icon name="alert-circle" />
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
				<Icon name="shield" class="jail-callout-icon shrink-0 text-muted mt-1" />
				<div class="jail-callout-content flex flex-col gap-[3px] min-w-0">
					<span class="jail-callout-title text-12 font-semibold text-ink-secondary">{t.settings.workspaceRole}</span>
					<p class="jail-callout-text m-0 text-12 leading-[1.45] text-muted">{WORKSPACE_COPY[locale]}</p>
				</div>
			</div>
		</div>
	</SettingsCard>
	<PermissionModeCard
		{t}
		mode={snapshot.settings.permission_mode ?? DEFAULT_PERMISSION_MODE}
		bots={snapshot.bots}
		onChoose={async (mode) => (await runtime.patchSettings({ permission_mode: mode })) === null}
	/>
	<!-- Preferences: one page with the workspace, which alone used to fill a tab of its own. -->
	<SettingsCard class="settings-card-preferences">
		<SettingsCardHeader title={t.settings.sectionPreferences} subtitle={t.settings.preferencesSubtitle}>
			{#snippet icon()}
				<div class="settings-header-icon-wrap" aria-hidden="true">
					<Icon name="sliders" />
				</div>
			{/snippet}
		</SettingsCardHeader>

		<div class="settings-rows">
			<!-- Theme Row -->
			<SettingsRow title={t.settings.theme} titleId="theme-setting-label" desc={t.settings.themeDesc}>
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
						<Icon name="monitor" class="segmented-icon" />
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
						<Icon name="sun" class="segmented-icon" />
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
						<Icon name="moon" class="segmented-icon" />
						<span>{t.settings.themeDark}</span>
					</button>
				</div>
			</SettingsRow>

			<!-- Language Row -->
			<SettingsRow title={t.settings.language} titleId="lang-setting-label" desc={t.settings.languageDesc}>
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
			</SettingsRow>

			<!-- Focus mode: one switch for every conversation, kept per browser (chat/focus-mode.svelte.ts). -->
			<SettingsRow title={t.settings.focusMode} titleId="focus-mode-label" desc={t.settings.focusModeDesc}>
				<Switch class="relative inline-flex items-center cursor-pointer select-none" for="focus-mode-toggle" labelledby="focus-mode-label">
					<input
						id="focus-mode-toggle"
						type="checkbox"
						checked={focusMode.on}
						onchange={(ev) => focusMode.set((ev.currentTarget as HTMLInputElement).checked)}
					/>
				</Switch>
			</SettingsRow>

			<!-- Launch at login Row -->
			<SettingsRow title={t.settings.launch} titleId="launch-setting-label" desc={t.settings.launchDesc}>
				<Switch class="relative inline-flex items-center cursor-pointer select-none" for="launch-at-login-toggle" labelledby="launch-setting-label">
					<input
						id="launch-at-login-toggle"
						type="checkbox"
						checked={snapshot.settings.launch_at_login}
						onchange={(ev) =>
							void onLaunchAtLogin((ev.currentTarget as HTMLInputElement).checked)}
					/>
				</Switch>
			</SettingsRow>

			<SettingsRow title={t.settings.independentRuntime} titleId="independent-runtime-label" desc={t.settings.independentRuntimeDesc}>
				{#snippet notes()}
					{#if !independent.available || independent.error}
						<span class="settings-row-desc" data-independent-reason>{independentReason(independent)}</span>
					{/if}
				{/snippet}
				<Switch
					class="relative inline-flex items-center select-none"
					disabled={!independent.available}
					for="independent-runtime-toggle"
					labelledby="independent-runtime-label"
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
				</Switch>
			</SettingsRow>
		</div>
	</SettingsCard>
</div>

<style>
	.settings-tab-pane {
		display: flex;
		flex-direction: column;
		gap: 14px;
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

	.settings-badge-ok,
	.settings-badge-warn {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: var(--radius-full);
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

	/* A note on what the folder means, not an alert: no tinted box, the card's own text colours. */
	.workspace-jail-callout {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 2px 0 0;
	}

	/* Preferences Rows */
	.settings-rows {
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--line-subtle);
		margin-top: 4px;
	}

	.settings-row-desc {
		font-size: 12px;
		color: var(--muted);
		line-height: 1.35;
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
		transition: 0.15s ease;
		transition-property: var(--transition-props);
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

	.segmented-control :global(.segmented-icon) {
		flex-shrink: 0;
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

	@media (max-width: 720px) {
		.settings-tab-pane {
			gap: 12px;
		}
	}
</style>
