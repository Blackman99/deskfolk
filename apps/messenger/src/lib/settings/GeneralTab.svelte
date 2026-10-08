<script lang="ts">
	import WorkspacePicker from './WorkspacePicker.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import SettingsSwitch from './SettingsSwitch.svelte';
	import { JAIL_COPY, type Copy } from '../copy.ts';
	import { themeManager } from '../theme.ts';
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
				<svg class="jail-callout-icon shrink-0 text-muted mt-1" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
				</svg>
				<div class="jail-callout-content flex flex-col gap-[3px] min-w-0">
					<span class="jail-callout-title text-12 font-semibold text-ink-secondary">{t.settings.workspaceSecurityBoundary}</span>
					<p class="jail-callout-text m-0 text-12 leading-[1.45] text-muted">{JAIL_COPY[locale]}</p>
				</div>
			</div>
		</div>
	</div>
	<!-- Preferences: one page with the workspace, which alone used to fill a tab of its own. -->
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

			<!-- Launch at login Row -->
			<SettingsRow title={t.settings.launch} titleId="launch-setting-label" desc={t.settings.launchDesc}>
				<SettingsSwitch class="relative inline-flex items-center cursor-pointer select-none" for="launch-at-login-toggle" labelledby="launch-setting-label">
					<input
						id="launch-at-login-toggle"
						type="checkbox"
						checked={snapshot.settings.launch_at_login}
						onchange={(ev) =>
							void onLaunchAtLogin((ev.currentTarget as HTMLInputElement).checked)}
					/>
				</SettingsSwitch>
			</SettingsRow>

			<SettingsRow title={t.settings.independentRuntime} titleId="independent-runtime-label" desc={t.settings.independentRuntimeDesc}>
				{#snippet notes()}
					{#if !independent.available || independent.error}
						<span class="settings-row-desc" data-independent-reason>{independentReason(independent)}</span>
					{/if}
				{/snippet}
				<SettingsSwitch
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
				</SettingsSwitch>
			</SettingsRow>
		</div>
	</div>
</div>

<style>
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
		font-size: 12px;
		color: var(--muted);
		line-height: 1.35;
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

	.segmented-icon {
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

		.settings-card {
			border-radius: var(--radius-lg);
			padding: 15px;
			box-shadow: none;
		}
	}
</style>
