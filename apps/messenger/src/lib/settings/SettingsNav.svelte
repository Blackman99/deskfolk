<script lang="ts" module>
	export type SettingsTab = 'general' | 'behavior' | 'models' | 'agents' | 'mcp' | 'prompts' | 'notifications' | 'lessons' | 'remote' | 'about';
</script>

<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import type { Snapshot } from '../snapshot.ts';
	import { updateChecker } from '../update-checker.svelte.ts';

	type Props = {
		t: Copy;
		snapshot: Snapshot;
		activeSettingsTab: SettingsTab;
		openSettingsTab: (tab: SettingsTab) => void;
		generalHasError: boolean;
		modelsHasError: boolean;
		promptCounts: { edited: number; conflict: boolean };
		lessonsTabVisible: boolean;
		remoteTabVisible: boolean;
		/** Only with the desktop workbench: what it holds is where windows open there. */
		behaviorTabVisible: boolean;
		closeSettings: () => void;
	};

	let {
		t,
		snapshot,
		activeSettingsTab,
		openSettingsTab,
		generalHasError,
		modelsHasError,
		promptCounts,
		lessonsTabVisible,
		remoteTabVisible,
		behaviorTabVisible,
		closeSettings
	}: Props = $props();
</script>

<aside class="settings-sidebar">
	<div class="settings-sidebar-head">
		<div class="settings-head-left flex items-center gap-5">
			<Icon name="settings" size={20} class="settings-head-icon text-muted shrink-0" />
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
			data-settings-tab="general"
			onclick={() => openSettingsTab('general')}
		>
			<Icon name="settings" class="tab-icon" />
			<span class="tab-name">{t.settings.tabGeneral}</span>
			{#if generalHasError}
				<span class="tab-badge-error" aria-label="error">!</span>
			{/if}
		</button>

		{#if behaviorTabVisible}
			<button
				type="button"
				class="settings-tab-btn"
				class:is-active={activeSettingsTab === 'behavior'}
				data-settings-tab="behavior"
				onclick={() => openSettingsTab('behavior')}
			>
				<Icon name="layout" class="tab-icon" />
				<span class="tab-name">{t.settings.tabBehavior}</span>
			</button>
		{/if}


		<button
			type="button"
			class="settings-tab-btn"
			class:is-active={activeSettingsTab === 'models'}
			data-settings-tab="models"
			onclick={() => openSettingsTab('models')}
		>
			<Icon name="box" class="tab-icon" />
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
			class:is-active={activeSettingsTab === 'agents'}
			data-settings-tab="agents"
			onclick={() => openSettingsTab('agents')}
		>
			<Icon name="terminal-square" class="tab-icon" />
			<span class="tab-name">{t.settings.tabAgents}</span>
		</button>

		<button
			type="button"
			class="settings-tab-btn"
			class:is-active={activeSettingsTab === 'mcp'}
			data-settings-tab="mcp"
			onclick={() => openSettingsTab('mcp')}
		>
			<Icon name="server" class="tab-icon" />
			<span class="tab-name">{t.settings.tabMcp}</span>
			{#if snapshot.mcpServers.length > 0}
				<span class="tab-count text-11 font-semibold py-[1px] px-3 rounded-full bg-chip text-ink-secondary">{snapshot.mcpServers.length}</span>
			{/if}
		</button>

		<button
			type="button"
			class="settings-tab-btn"
			class:is-active={activeSettingsTab === 'prompts'}
			data-settings-tab="prompts"
			onclick={() => openSettingsTab('prompts')}
		>
			<Icon name="type" class="tab-icon" />
			<span class="tab-name">{t.settings.tabPrompts}</span>
			{#if promptCounts.edited > 0}
				<span class="tab-count text-11 font-semibold py-[1px] px-3 rounded-full bg-chip text-ink-secondary" class:is-warn={promptCounts.conflict}>{promptCounts.edited}</span>
			{/if}
		</button>

		<button
			type="button"
			class="settings-tab-btn"
			class:is-active={activeSettingsTab === 'notifications'}
			data-settings-tab="notifications"
			onclick={() => openSettingsTab('notifications')}
		>
			<Icon name="bell" class="tab-icon" />
			<span class="tab-name">{t.settings.tabNotifications}</span>
		</button>

		{#if lessonsTabVisible}
			<button
				type="button"
				class="settings-tab-btn"
				class:is-active={activeSettingsTab === 'lessons'}
				data-settings-tab="lessons"
				onclick={() => openSettingsTab('lessons')}
			>
				<Icon name="book-open" class="tab-icon" />
				<span class="tab-name">{t.settings.tabLessons}</span>
			</button>
		{/if}

		{#if remoteTabVisible}
			<button
				type="button"
				class="settings-tab-btn"
				class:is-active={activeSettingsTab === 'remote'}
				data-settings-tab="remote"
				onclick={() => openSettingsTab('remote')}
			>
				<Icon name="smartphone" class="tab-icon" />
				<span class="tab-name">{t.settings.tabRemote}</span>
			</button>
		{/if}

		<button
			type="button"
			class="settings-tab-btn"
			class:is-active={activeSettingsTab === 'about'}
			data-settings-tab="about"
			onclick={() => openSettingsTab('about')}
			title={updateChecker.updateVisible ? `${t.settings.tabAbout} · ${t.sidebar.updateAvailable}` : t.settings.tabAbout}
		>
			<Icon name="info" class="tab-icon" />
			<span class="tab-name">{t.settings.tabAbout}</span>
			{#if updateChecker.updateVisible}
				<span class="tab-badge-dot" aria-label={t.sidebar.updateAvailable}></span>
			{/if}
		</button>
	</nav>
</aside>

<style>
	.settings-wizard-badge {
		font-size: 12px;
		font-weight: 500;
		padding: 2px 8px;
		border-radius: var(--radius-full);
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

	.settings-root-close {
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
		font-size: 14px;
		font-weight: 500;
		color: var(--ink-secondary);
		background: transparent;
		border: 1px solid transparent;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		user-select: none;
		cursor: pointer;
		box-sizing: border-box;
		text-align: left;
	}

	.settings-sidebar .settings-tab-btn:hover {
		color: var(--ink);
		background: var(--row-hover);
	}

	/*
	 * The open page is marked the way every selected item of a set is: the accent's tint behind
	 * it, its name and its icon in the accent. The icon only changes colour; no item lacks it.
	 */
	.settings-sidebar .settings-tab-btn.is-active {
		color: var(--accent);
		background: var(--accent-tint);
		border-color: transparent;
		box-shadow: none;
		font-weight: 600;
	}

	.settings-sidebar .settings-tab-btn :global(.tab-icon) {
		opacity: 0.75;
		flex-shrink: 0;
	}

	.settings-sidebar .settings-tab-btn.is-active :global(.tab-icon) {
		opacity: 1;
		color: var(--accent);
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
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		user-select: none;
		cursor: pointer;
	}

	.settings-tab-btn:hover {
		color: var(--ink);
		background: rgba(0, 0, 0, 0.04);
	}

	.settings-tab-btn.is-active {
		color: var(--accent);
		background: var(--accent-tint);
		border-color: transparent;
		font-weight: 600;
		box-shadow: none;
	}

	.settings-tab-btn :global(.tab-icon) {
		opacity: 0.7;
		flex-shrink: 0;
	}

	.settings-tab-btn.is-active :global(.tab-icon) {
		opacity: 1;
		color: var(--accent);
	}

	.tab-badge-error {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		border-radius: 50%;
		background: var(--danger);
		color: var(--on-danger);
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		margin-left: 2px;
	}

	.tab-badge-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		/* An update is news, not an error: the sidebar's settings entry shows the same dot. */
		background: var(--accent);
		margin-left: auto;
		flex-shrink: 0;
		box-shadow: 0 0 0 2px var(--sidebar-bg);
	}

	.settings-sidebar .settings-tab-btn.is-active .tab-badge-dot {
		box-shadow: none;
	}

	.settings-sidebar .settings-tab-btn:hover .tab-badge-dot {
		box-shadow: 0 0 0 2px var(--row-hover);
	}

	.settings-tab-btn.is-active .tab-count {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.settings-sidebar {
		flex-shrink: 0;
	}

	@media (max-width: 720px) {
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
			font-size: 18px;
		}

		.settings-sidebar-head :global(.settings-head-icon) {
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

		.settings-sidebar .settings-tab-btn :global(.tab-icon),
		.settings-sidebar .settings-tab-btn.is-active :global(.tab-icon) {
			display: block;
			width: 20px;
			height: 20px;
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
	.settings-tab-btn :global(.tab-icon) {
	display: none;
	}
	}
</style>
