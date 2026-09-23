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
	let newTabOpen = $state(false);

	/** Anything outside the little menu closes it, the way every other menu in the app behaves. */
	function closeOnOutside(node: HTMLElement) {
		const onDown = (event: PointerEvent) => {
			if (!node.contains(event.target as Node)) newTabOpen = false;
		};
		window.addEventListener('pointerdown', onDown, true);
		return {
			destroy() {
				window.removeEventListener('pointerdown', onDown, true);
			}
		};
	}

	$effect(() => {
		// A pane that changes what it holds should not leave the menu hanging open over it.
		void leaf.tabs.length;
		newTabOpen = false;
	});

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
					{#if tab.id === leaf.activeTabId}
						<span class="wb-tab-flare is-left" aria-hidden="true"></span>
						<span class="wb-tab-flare is-right" aria-hidden="true"></span>
					{/if}
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
		{#if emptyActions && leaf.tabs.length > 0}
			<button
				type="button"
				class="wb-new-tab"
				aria-label={t.pane.newTab}
				aria-expanded={newTabOpen}
				title={t.pane.newTab}
				onclick={() => (newTabOpen = !newTabOpen)}>＋</button
			>
		{/if}
		{#if onMenu}
			<button
				type="button"
				class="wb-pane-menu"
				aria-haspopup="menu"
				aria-label={t.pane.title}
				onclick={(event) => onMenu(event, leaf.id)}>⋯</button
			>
		{/if}
		{#if newTabOpen && emptyActions}
			<!-- The same three things an empty pane offers, so there is one answer to "put
			     something here" whether the pane is empty or already holds a tab. -->
			<div class="wb-new-menu" role="menu" use:closeOnOutside>
				{@render emptyActions(leaf.id)}
			</div>
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
		/*
		 * No `contain` here, deliberately.
		 *
		 * `contain: layout` and `contain: paint` both make the element a containing block for
		 * `position: fixed` descendants, and the app has several — the message and conversation
		 * context menus, the calendar's dialog backdrop — that are placed from `clientX` /
		 * `clientY`, which are viewport coordinates. Inside a contained pane those resolve
		 * against the pane instead, so a right-click menu in the second column opened one
		 * column's width to the right of the pointer. What containment bought was reflow
		 * isolation between panes, which `overflow: hidden` and the minimums already cover well
		 * enough to not be worth a menu landing in the wrong place.
		 */
	}
	.wb-leaf.is-focused .wb-tab.is-active .wb-tab-button {
		font-weight: 600;
	}
	/* Along the top, not the bottom: the bottom is where the tab joins the content, and a line
	   there would cut the join the flares exist to make. */
	.wb-leaf.is-focused .wb-tab.is-active {
		box-shadow: inset 0 2px 0 0 var(--accent);
	}
	.wb-leaf.is-focused {
		outline: 1px solid var(--accent-border);
		outline-offset: -1px;
	}
	/*
	 * The strip reads the way a browser's does: it sits a shade below the content, and the active
	 * tab is the same colour as the content with its bottom corners flaring outward, so the two
	 * are one surface. The tabs that are not active stay on the strip, recessed.
	 */
	.wb-strip {
		--wb-tab-flare: 8px;
		display: flex;
		align-items: flex-end;
		gap: 0;
		height: 32px;
		padding: 0 4px;
		background: var(--bg);
		flex: 0 0 auto;
		position: relative;
		z-index: 1;
	}
	.wb-tabs {
		display: flex;
		align-items: flex-end;
		min-width: 0;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
	}
	.wb-tabs::-webkit-scrollbar {
		display: none;
	}
	.wb-tab {
		position: relative;
		display: flex;
		align-items: center;
		flex: 0 1 auto;
		min-width: 0;
		height: 28px;
		padding: 0 2px 0 8px;
		border-radius: 8px 8px 0 0;
	}
	/* A hairline between neighbours, the way a browser separates tabs that share a colour. It
	   goes away next to the active tab and under the pointer, where the shape already says it. */
	.wb-tab::after {
		content: '';
		position: absolute;
		right: 0;
		top: 8px;
		bottom: 8px;
		width: 1px;
		background: var(--line);
	}
	.wb-tab:last-child::after,
	.wb-tab:hover::after,
	.wb-tab.is-active::after,
	.wb-tab:has(+ .wb-tab.is-active)::after,
	.wb-tab:has(+ .wb-tab:hover)::after {
		display: none;
	}
	.wb-tab:not(.is-active):hover {
		background: var(--row-hover);
	}
	.wb-tab.is-active {
		background: var(--pane);
		height: 30px;
	}
	/*
	 * The two pieces that carry the active tab's base out into the content. Each is a square of
	 * content colour with a quarter disc bitten out of the side away from the tab, which is what
	 * turns the join into a curve instead of a step.
	 */
	.wb-tab.is-active .wb-tab-flare {
		position: absolute;
		bottom: 0;
		width: var(--wb-tab-flare);
		height: var(--wb-tab-flare);
		pointer-events: none;
	}
	.wb-tab.is-active .wb-tab-flare.is-left {
		left: calc(var(--wb-tab-flare) * -1);
		background: radial-gradient(
			circle var(--wb-tab-flare) at 0 0,
			transparent 99%,
			var(--pane) 100%
		);
	}
	.wb-tab.is-active .wb-tab-flare.is-right {
		right: calc(var(--wb-tab-flare) * -1);
		background: radial-gradient(
			circle var(--wb-tab-flare) at 100% 0,
			transparent 99%,
			var(--pane) 100%
		);
	}
	.wb-tab-button {
		max-width: 180px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		padding: 0 4px 0 0;
		height: 100%;
		font-size: 12px;
		color: var(--muted);
		background: none;
		cursor: default;
	}
	.wb-tab.is-active .wb-tab-button {
		color: var(--ink);
	}
	.wb-tab-close {
		width: 18px;
		height: 18px;
		flex: 0 0 auto;
		margin-right: 2px;
		border-radius: 50%;
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
		color: var(--ink);
	}
	.wb-new-tab,
	.wb-pane-menu {
		flex: 0 0 auto;
		width: 24px;
		height: 24px;
		margin-bottom: 2px;
		border-radius: 50%;
		color: var(--muted);
		background: none;
		font-size: 14px;
		line-height: 1;
	}
	.wb-new-tab {
		margin-left: 4px;
	}
	.wb-pane-menu {
		margin-left: auto;
	}
	.wb-new-tab:hover,
	.wb-pane-menu:hover {
		background: var(--row-hover);
		color: var(--ink);
	}
	.wb-new-menu {
		position: absolute;
		top: 30px;
		left: 8px;
		z-index: 30;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 8px;
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow:
			0 12px 30px -4px rgb(0 0 0 / 0.22),
			inset 0 0 0 1px var(--line);
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
		color: var(--ink);
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
