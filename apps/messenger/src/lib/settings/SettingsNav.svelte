<script lang="ts" module>
	export type SettingsTab = 'general' | 'behavior' | 'models' | 'routing' | 'agents' | 'mcp' | 'prompts' | 'notifications' | 'lessons' | 'remote' | 'about';
</script>

<script lang="ts">
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
		/** The app's own calls you changed (a model of their own or an edited prompt), ADR 0082. */
		routingCounts: { changed: number; conflict: boolean };
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
		routingCounts,
		lessonsTabVisible,
		remoteTabVisible,
		behaviorTabVisible,
		closeSettings
	}: Props = $props();
</script>

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
			data-settings-tab="general"
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

		{#if behaviorTabVisible}
			<button
				type="button"
				class="settings-tab-btn"
				class:is-active={activeSettingsTab === 'behavior'}
				data-settings-tab="behavior"
				onclick={() => openSettingsTab('behavior')}
			>
				<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="3" y="4" width="18" height="16" rx="2"></rect>
					<line x1="12" y1="4" x2="12" y2="20"></line>
					<line x1="12" y1="12" x2="21" y2="12"></line>
				</svg>
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
			class:is-active={activeSettingsTab === 'routing'}
			data-settings-tab="routing"
			onclick={() => openSettingsTab('routing')}
		>
			<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<circle cx="5" cy="6" r="2"></circle>
				<circle cx="19" cy="6" r="2"></circle>
				<circle cx="12" cy="18" r="2"></circle>
				<path d="M7 6h10"></path>
				<path d="M6 8l5 8"></path>
				<path d="M18 8l-5 8"></path>
			</svg>
			<span class="tab-name">{t.routing.tab}</span>
			{#if routingCounts.changed > 0}
				<span class="tab-count text-11 font-semibold py-[1px] px-3 rounded-full bg-chip text-ink-secondary" class:is-warn={routingCounts.conflict}>{routingCounts.changed}</span>
			{/if}
		</button>

		<button
			type="button"
			class="settings-tab-btn"
			class:is-active={activeSettingsTab === 'agents'}
			data-settings-tab="agents"
			onclick={() => openSettingsTab('agents')}
		>
			<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
				<polyline points="7 9 10 12 7 15"></polyline>
				<line x1="12" y1="15" x2="17" y2="15"></line>
			</svg>
			<span class="tab-name">{t.settings.tabAgents}</span>
		</button>

		<button
			type="button"
			class="settings-tab-btn"
			class:is-active={activeSettingsTab === 'mcp'}
			data-settings-tab="mcp"
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
			class:is-active={activeSettingsTab === 'prompts'}
			data-settings-tab="prompts"
			onclick={() => openSettingsTab('prompts')}
		>
			<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M4 7V4h16v3"></path>
				<line x1="9" y1="20" x2="15" y2="20"></line>
				<line x1="12" y1="4" x2="12" y2="20"></line>
			</svg>
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
			<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
				<path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
			</svg>
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
				<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
					<path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
				</svg>
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
				<svg class="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
					<line x1="12" y1="18" x2="12.01" y2="18"></line>
				</svg>
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
	 * The open page is tinted the way the open conversation is in the sidebar. The frame the
	 * generic `.settings-tab-btn.is-active` draws for the row of tabs is taken off here.
	 */
	.settings-sidebar .settings-tab-btn.is-active {
		color: var(--accent);
		background: var(--accent-tint);
		border-color: transparent;
		box-shadow: none;
		font-weight: 600;
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
</style>
