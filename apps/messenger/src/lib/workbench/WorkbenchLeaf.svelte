<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LeafNode, WorkbenchTab } from './layout-types.ts';
	import type { Copy } from '../copy.ts';

	type Props = {
		leaf: LeafNode;
		focused: boolean;
		t: Copy;
		/** The content of the active tab. The workbench never imports a content component itself. */
		tabBody: Snippet<[WorkbenchTab, string]>;
		tabLabel: Snippet<[WorkbenchTab]>;
		onFocus: (leafId: string) => void;
		onActivate: (leafId: string, tabId: string) => void;
		onCloseTab: (leafId: string, tabId: string) => void;
		onTabPointerDown?: (event: PointerEvent, leafId: string, tabId: string) => void;
		onStripPointerDown?: (event: PointerEvent, leafId: string) => void;
		onMenu?: (event: MouseEvent, leafId: string) => void;
		/** What an empty pane offers to fill itself with. */
		emptyActions?: Snippet<[string]>;
	};

	let {
		leaf,
		focused,
		t,
		tabBody,
		tabLabel,
		onFocus,
		onActivate,
		onCloseTab,
		onTabPointerDown,
		onStripPointerDown,
		onMenu,
		emptyActions
	}: Props = $props();

	const active = $derived(leaf.tabs.find((tab) => tab.id === leaf.activeTabId) ?? null);
	let strip = $state<HTMLDivElement>();

	/**
	 * Arrow keys move focus; Enter or Space switches. The pattern's usual default is to switch as
	 * focus moves, but a tab here costs a terminal reattach or a Monaco mount, so arrowing across
	 * five of them must not start five of those.
	 */
	function onTabKey(event: KeyboardEvent, index: number): void {
		let next = index;
		if (event.key === 'ArrowRight') next = (index + 1) % leaf.tabs.length;
		else if (event.key === 'ArrowLeft') next = (index - 1 + leaf.tabs.length) % leaf.tabs.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = leaf.tabs.length - 1;
		else if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			onCloseTab(leaf.id, leaf.tabs[index]!.id);
			return;
		} else return;
		event.preventDefault();
		strip?.querySelector<HTMLElement>(`#wb-tab-${CSS.escape(leaf.tabs[next]!.id)}`)?.focus();
	}
</script>

<div
	class="wb-leaf"
	class:is-focused={focused}
	data-leaf={leaf.id}
	data-testid="wb-leaf"
>
	<div
		class="wb-strip"
		role="tablist"
		aria-orientation="horizontal"
		aria-label={t.pane.tabsIn.replace('{name}', t.pane.title)}
		tabindex="-1"
		bind:this={strip}
		onpointerdown={(event) => onStripPointerDown?.(event, leaf.id)}
	>
		<div class="wb-tabs">
			{#each leaf.tabs as tab, index (tab.id)}
				<!-- The close control is a sibling of the tab, never nested inside it: a button
				     inside a button is invalid and svelte-check's a11y pass says so. -->
				<div class="wb-tab" role="presentation" class:is-active={tab.id === leaf.activeTabId}>
					<button
						type="button"
						role="tab"
						id={`wb-tab-${tab.id}`}
						class="wb-tab-button"
						aria-selected={tab.id === leaf.activeTabId}
						aria-controls={`wb-panel-${leaf.id}`}
						tabindex={tab.id === leaf.activeTabId ? 0 : -1}
						onpointerdown={(event) => {
							onFocus(leaf.id);
							onTabPointerDown?.(event, leaf.id, tab.id);
						}}
						onclick={() => onActivate(leaf.id, tab.id)}
						onauxclick={(event) => {
							if (event.button === 1) onCloseTab(leaf.id, tab.id);
						}}
						onkeydown={(event) => onTabKey(event, index)}
					>
						{@render tabLabel(tab)}
					</button>
					<button
						type="button"
						class="wb-tab-close"
						tabindex="-1"
						aria-label={t.pane.closeTab}
						onclick={(event) => {
							event.stopPropagation();
							onCloseTab(leaf.id, tab.id);
						}}>×</button
					>
				</div>
			{/each}
		</div>
		{#if onMenu}
			<button
				type="button"
				class="wb-pane-menu"
				aria-haspopup="menu"
				aria-label={t.pane.title}
				onclick={(event) => onMenu(event, leaf.id)}>⋯</button
			>
		{/if}
	</div>
	<div
		class="wb-body"
		role="tabpanel"
		id={`wb-panel-${leaf.id}`}
		aria-labelledby={active ? `wb-tab-${active.id}` : undefined}
		tabindex="0"
	>
		{#if active}
			{@render tabBody(active, leaf.id)}
		{:else}
			<div class="wb-empty">
				<p class="wb-empty-title">{t.pane.empty}</p>
				{#if emptyActions}
					<div class="wb-empty-actions">{@render emptyActions(leaf.id)}</div>
				{:else}
					<p class="wb-empty-hint">{t.pane.emptyHint}</p>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.wb-leaf {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		position: relative;
		overflow: hidden;
		background: var(--pane);
		/* Keeps one pane's reflow out of the rest, and makes the pane the containing block for
		   any fixed-position widget inside it, which is what a pane-scoped overlay needs. */
		contain: layout style paint;
	}
	.wb-leaf.is-focused .wb-tab.is-active .wb-tab-button {
		font-weight: 600;
	}
	.wb-leaf.is-focused .wb-tab.is-active {
		box-shadow: inset 0 -2px 0 0 var(--accent);
	}
	.wb-leaf.is-focused {
		outline: 1px solid var(--accent-border);
		outline-offset: -1px;
	}
	.wb-strip {
		display: flex;
		align-items: center;
		gap: 2px;
		height: 28px;
		padding: 0 4px;
		background: var(--pane);
		box-shadow: inset 0 -1px 0 0 var(--hairline);
		flex: 0 0 auto;
	}
	.wb-tabs {
		display: flex;
		align-items: center;
		gap: 2px;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.wb-tabs::-webkit-scrollbar {
		display: none;
	}
	.wb-tab {
		display: flex;
		align-items: center;
		flex: 0 0 auto;
		border-radius: 6px;
	}
	.wb-tab.is-active {
		background: var(--row-hover);
	}
	.wb-tab-button {
		max-width: 160px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		padding: 0 4px 0 8px;
		height: 22px;
		font-size: 12px;
		color: var(--muted);
		background: none;
		cursor: default;
	}
	.wb-tab.is-active .wb-tab-button {
		color: var(--text);
	}
	.wb-tab-close {
		width: 16px;
		height: 16px;
		margin-right: 4px;
		border-radius: 4px;
		font-size: 12px;
		line-height: 1;
		color: var(--muted);
		background: none;
		opacity: 0;
	}
	.wb-tab:hover .wb-tab-close,
	.wb-tab:focus-within .wb-tab-close,
	.wb-tab.is-active .wb-tab-close {
		opacity: 1;
	}
	.wb-tab-close:hover {
		background: var(--row-hover);
		color: var(--text);
	}
	.wb-pane-menu {
		flex: 0 0 auto;
		margin-left: auto;
		width: 22px;
		height: 22px;
		border-radius: 6px;
		color: var(--muted);
		background: none;
	}
	.wb-pane-menu:hover {
		background: var(--row-hover);
		color: var(--text);
	}
	.wb-body {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		position: relative;
	}
	.wb-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 6px;
		padding: 24px;
		text-align: center;
	}
	.wb-empty-title {
		color: var(--text);
		font-size: 14px;
	}
	.wb-empty-hint {
		color: var(--muted);
		font-size: 12px;
	}
	.wb-empty-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: center;
	}
</style>
