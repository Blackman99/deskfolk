<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { updateChecker } from '../update-checker.svelte.ts';
	import { formatShortcut } from '../keymap.ts';
	import ToolsToggle from './ToolsToggle.svelte';

	/** The wide list's bottom row: workspace, tools and settings. */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		workspaceOpen: boolean;
		workspacePath: string | null | undefined;
		onToggleWorkspace: () => void;
		onOpenSettings: () => void;
		toolsMenuOpen?: boolean;
		toolsFocusLast?: boolean;
		toolsToggleBtnEl?: HTMLButtonElement | null;
	};

	let {
		runtime,
		t,
		workspaceOpen,
		workspacePath,
		onToggleWorkspace,
		onOpenSettings,
		toolsMenuOpen = $bindable(false),
		toolsFocusLast = $bindable(false),
		toolsToggleBtnEl = $bindable(null)
	}: Props = $props();

	/**
	 * The footer row. Its labels hide once the three of them no longer fit beside each other; a
	 * list under 240px drops them in CSS even when they would fit.
	 */
	let footEl = $state<HTMLElement | null>(null);
	let footCompact = $state(false);
	$effect(() => {
		const foot = footEl;
		if (!foot || typeof ResizeObserver !== 'function') return;
		// How wide the row is while its words are showing. A plain variable, not state: reading the
		// state here would rerun this effect the moment the words hide, and forget the width.
		let labelWidth = 0;
		let compact = false;
		// The buttons, the gaps between them and the padding at both ends. Not scrollWidth: that only
		// grows once a button crosses the edge, so words that have eaten the end padding still "fit".
		const rowWidth = () => {
			const style = getComputedStyle(foot);
			const buttons = [...foot.children];
			const gaps = (parseFloat(style.columnGap) || 0) * Math.max(0, buttons.length - 1);
			const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
			return buttons.reduce((sum, button) => sum + button.getBoundingClientRect().width, gaps + padding);
		};
		const measure = () => {
			const room = foot.clientWidth;
			if (!compact) {
				labelWidth = rowWidth();
				compact = labelWidth > room + 1;
			} else if (labelWidth > 0 && labelWidth <= room + 1) {
				compact = false;
			}
			footCompact = compact;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(foot);
		return () => observer.disconnect();
	});
</script>

<div class="foot" class:is-compact={footCompact} bind:this={footEl}>
	<button
		type="button"
		class="foot-action"
		class:is-active={workspaceOpen}
		title={workspacePath ? `${t.sidebar.workspace} (${formatShortcut(['mod', 'O'])})` : t.sidebar.workspaceUnset}
		aria-label={t.sidebar.workspace}
		aria-expanded={workspaceOpen}
		disabled={!workspacePath}
		onclick={() => onToggleWorkspace()}
	>
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
		</svg>
		<span class="foot-label">{t.sidebar.workspace}</span>
	</button>
	<ToolsToggle {t} phone={false} bind:open={toolsMenuOpen} bind:focusLast={toolsFocusLast} bind:buttonEl={toolsToggleBtnEl} />
	<button
		type="button"
		class="foot-action foot-settings"
		class:is-active={runtime.settingsOpen}
		title={updateChecker.updateVisible ? `${t.sidebar.settings} · ${t.sidebar.updateAvailable}` : t.sidebar.settings}
		aria-label={updateChecker.updateVisible ? `${t.sidebar.settings} · ${t.sidebar.updateAvailable}` : t.sidebar.settings}
		onclick={onOpenSettings}
	>
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="3"></circle>
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
		</svg>
		<span class="foot-label">{t.sidebar.settings}</span>
		{#if updateChecker.updateVisible}
			<span class="foot-badge is-dot" aria-hidden="true"></span>
		{/if}
	</button>
</div>

<style>
	/* Sidebar Footer */
	.foot {
		border-top: 1px solid var(--line);
		padding: 6px 8px;
		display: flex;
		gap: 4px;
		align-items: center;
		container: sidebar-footer / inline-size;
		background: var(--glass-footer);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		position: relative;
		z-index: 20;
	}

	.foot-action {
		height: 36px;
		padding: 0 7px;
		gap: 6px;
		font: 500 12px/1 var(--font);
		white-space: nowrap;
		border: 1px solid transparent;
		background: transparent;
		border-radius: var(--radius-sm);
		color: var(--muted);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: background 0.15s ease, color 0.15s ease;
		position: relative;
		cursor: pointer;
		flex-shrink: 0;
	}

	.foot-settings {
		margin-left: auto;
	}

	/*
	 * A list under 300px tightens the row. Up to there the roomy one has to fit: written out in
	 * English it is 295px wide, and switching any earlier left a band where it overflowed into
	 * icons while a narrower list still showed the words.
	 */

	@container sidebar-footer (max-width: 283px) {
		.foot-action {
			padding-inline: 4px;
			gap: 4px;
		}
	}

	/*
	 * Icons only. Under 240px the words would stand shoulder to shoulder even where they still fit
	 * (Chinese fits down to the 200px minimum), and at any width once the three no longer fit.
	 */

	@container sidebar-footer (max-width: 223px) {
		.foot-label {
			display: none;
		}

		.foot-action {
			padding-inline: 8px;
		}
	}

	.foot.is-compact .foot-label {
		display: none;
	}

	.foot.is-compact .foot-action {
		padding-inline: 8px;
	}

	.foot-action:hover:not(:disabled) {
		border-color: var(--line);
		color: var(--ink);
		background: var(--btn-secondary-hover);
		box-shadow: var(--shadow-xs);
	}

	.foot-action.is-active {
		border-color: var(--accent-border);
		color: var(--accent);
		background: var(--accent-tint);
	}

	.foot-action:focus-visible {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.foot-action:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.foot-badge {
		position: absolute;
		top: -3px;
		right: -3px;
		min-width: 14px;
		height: 14px;
		line-height: 12px;
		padding: 0 3px;
		border-radius: var(--radius-full);
		background: var(--accent);
		color: var(--on-accent);
		font-size: 10px;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1.5px solid var(--sidebar-bg);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
	}

	.foot-badge.is-dot {
		min-width: 0;
		width: 8px;
		height: 8px;
		padding: 0;
		top: 3px;
		right: 3px;
		/* An update is news, not an error. */
		background: var(--accent);
	}
</style>
