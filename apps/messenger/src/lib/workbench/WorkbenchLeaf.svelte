<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LeafNode, TabAction, WorkbenchTab } from './layout-types.ts';
	import type { Copy } from '../copy.ts';
	import PaneContextMenu from './PaneContextMenu.svelte';

	type Props = {
		leaf: LeafNode;
		focused: boolean;
		/**
		 * Draw the frame that says "this is the current pane". Only worth it while there is
		 * another pane to tell it from; a lone pane framed in accent is just noise.
		 */
		framed?: boolean;
		t: Copy;
		/** The content of the active tab. The workbench never imports a content component itself. */
		tabBody: Snippet<[WorkbenchTab, string]>;
		tabLabel: Snippet<[WorkbenchTab]>;
		onFocus: (leafId: string) => void;
		onActivate: (leafId: string, tabId: string) => void;
		onCloseTab: (leafId: string, tabId: string) => void;
		onClosePane?: (leafId: string) => void;
		onTabPointerDown?: (event: PointerEvent, leafId: string, tabId: string) => void;
		onStripPointerDown?: (event: PointerEvent, leafId: string) => void;
		onMenu?: (event: MouseEvent, leafId: string) => void;
		/** What an empty pane offers to fill itself with. */
		emptyActions?: Snippet<[string]>;
		/**
		 * The same offer, shaped for the strip's menu: a fixed-width list rather than a wrapping
		 * row of chips, so a long history of shells does not stretch it across the window.
		 */
		menuActions?: Snippet<[string, string]>;
		/**
		 * What a tab offers to do for what it shows. A tab with any gets a ⋯ once the pane is
		 * narrow, which is when a conversation's header folds into its tab.
		 */
		tabActions?: (leafId: string, tab: WorkbenchTab) => TabAction[];
	};

	let {
		leaf,
		focused,
		framed = false,
		t,
		tabBody,
		tabLabel,
		onFocus,
		onActivate,
		onCloseTab,
		onClosePane,
		onTabPointerDown,
		onStripPointerDown,
		onMenu,
		emptyActions,
		menuActions,
		tabActions
	}: Props = $props();

	const active = $derived(leaf.tabs.find((tab) => tab.id === leaf.activeTabId) ?? null);
	let strip = $state<HTMLDivElement>();
	let newTabButton = $state<HTMLButtonElement>();
	let newTabMenu = $state<HTMLDivElement>();
	let newTabQuery = $state<HTMLInputElement>();
	let newTabOpen = $state(false);
	let newTabFilter = $state('');
	/** The same list, laid out in an empty pane rather than hung off the +. */
	let emptyList = $state<HTMLDivElement>();
	let emptyQuery = $state<HTMLInputElement>();
	let emptyFilter = $state('');
	/** The + is there when the pane has something to offer, whether or not the menu is shaped. */
	const canOpen = $derived(Boolean(menuActions ?? emptyActions));
	/** The tab whose ⋯ is open, and the ⋯ it hangs from. */
	let more = $state<{ tabId: string; anchor: HTMLElement } | null>(null);
	const moreTab = $derived(more ? (leaf.tabs.find((tab) => tab.id === more!.tabId) ?? null) : null);

	function toggleMore(tabId: string, anchor: HTMLElement): void {
		more = more?.tabId === tabId ? null : { tabId, anchor };
	}

	/** Under the ⋯, from its left edge, the way the + menu hangs from the +. */
	function moreAt(anchor: HTMLElement): { x: number; y: number } {
		const box = anchor.getBoundingClientRect();
		return { x: box.left, y: box.bottom + 4 };
	}

	/**
	 * The menu is moved to `document.body`. A pane clips overflow, and a floating pane's
	 * transform would make `fixed` resolve against the pane instead of the window.
	 */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		const onDown = (event: PointerEvent) => {
			if (!node.contains(event.target as Node) && event.target !== newTabButton) newTabOpen = false;
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.stopPropagation();
			newTabOpen = false;
			newTabButton?.focus();
		};
		const onReflow = () => placeNewMenu();
		const onPick = (event: MouseEvent) => {
			if ((event.target as HTMLElement | null)?.closest('[role="menuitem"]')) newTabOpen = false;
		};
		window.addEventListener('pointerdown', onDown, true);
		window.addEventListener('resize', onReflow);
		node.addEventListener('keydown', onKey);
		node.addEventListener('click', onPick);
		queueMicrotask(onReflow);
		return {
			destroy() {
				window.removeEventListener('pointerdown', onDown, true);
				window.removeEventListener('resize', onReflow);
				node.removeEventListener('keydown', onKey);
				node.removeEventListener('click', onPick);
				node.remove();
			}
		};
	}

	function toggleNewTab(): void {
		newTabOpen = !newTabOpen;
		if (newTabOpen) newTabFilter = '';
	}

	/**
	 * Hangs under the +. Flips upward or inward when that would run off the window.
	 */
	function placeNewMenu(): void {
		const button = newTabButton;
		const menu = newTabMenu;
		if (!button || !menu) return;
		const anchor = button.getBoundingClientRect();
		const box = menu.getBoundingClientRect();
		const margin = 8;
		let left = anchor.left;
		if (left + box.width > window.innerWidth - margin) left = window.innerWidth - margin - box.width;
		if (left < margin) left = margin;
		const below = anchor.bottom + 4;
		const above = anchor.top - 4 - box.height;
		const top = below + box.height > window.innerHeight - margin && above >= margin ? above : below;
		menu.style.left = `${left}px`;
		menu.style.top = `${Math.max(margin, top)}px`;
	}

	function onNewTabKey(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' && newTabOpen) {
			event.preventDefault();
			focusMenuItem(0);
		} else if (event.key === 'Escape' && newTabOpen) {
			event.preventDefault();
			event.stopPropagation();
			newTabOpen = false;
		}
	}

	/**
	 * Arrow keys walk the rows that are actually on screen; typing filters the running shells.
	 * One handler for both places the list appears: the + menu and an empty pane.
	 */
	function onMenuKey(event: KeyboardEvent, list = newTabMenu, query = newTabQuery): void {
		// In the filter, Home and End move the caret.
		if (event.target === query && (event.key === 'Home' || event.key === 'End')) return;
		const items = menuItems(list);
		const index = items.indexOf(document.activeElement as HTMLElement);
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			focusMenuItem(index < 0 ? 0 : (index + 1) % items.length, list);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			if (index <= 0) query?.focus();
			else focusMenuItem(index - 1, list);
		} else if (event.key === 'Home') {
			event.preventDefault();
			focusMenuItem(0, list);
		} else if (event.key === 'End') {
			event.preventDefault();
			focusMenuItem(items.length - 1, list);
		}
	}

	function menuItems(list = newTabMenu): HTMLElement[] {
		return [...(list?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
	}

	function focusMenuItem(index: number, list = newTabMenu): void {
		const items = menuItems(list);
		const item = items[Math.min(Math.max(index, 0), items.length - 1)];
		item?.focus();
		item?.scrollIntoView({ block: 'nearest' });
	}

	$effect(() => {
		// A pane that changes what it holds should not leave the menu hanging open over it.
		void leaf.tabs.length;
		newTabOpen = false;
		emptyFilter = '';
		more = null;
	});

	$effect(() => {
		if (!newTabOpen) return;
		queueMicrotask(() => newTabQuery?.focus());
	});

	$effect(() => {
		if (!newTabOpen) return;
		// Filtering changes how tall the menu is, so it is placed again.
		void newTabFilter;
		queueMicrotask(() => placeNewMenu());
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
	class:is-framed={framed}
	data-leaf={leaf.id}
	data-testid="wb-leaf"
>
	<div
		class="wb-strip"
		class:is-menu-open={newTabOpen}
		role="tablist"
		aria-orientation="horizontal"
		aria-label={t.pane.tabsIn.replace('{name}', t.pane.title)}
		tabindex="-1"
		bind:this={strip}
		onpointerdown={(event) => onStripPointerDown?.(event, leaf.id)}
	>
		<div class="wb-tabs">
			{#each leaf.tabs as tab, index (tab.id)}
				{@const actions = tabActions?.(leaf.id, tab) ?? []}
				<!-- The close control is a sibling of the tab, never nested inside it: a button
				     inside a button is invalid and svelte-check's a11y pass says so. -->
				<div
					class="wb-tab"
					role="presentation"
					class:is-active={tab.id === leaf.activeTabId}
					data-tab={tab.id}
				>
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
					{#if actions.length > 0}
						<!-- Out of the tab order like the close control: from the keyboard the tab's
						     own context menu key opens the same actions. -->
						<button
							type="button"
							class="wb-tab-more"
							class:is-open={more?.tabId === tab.id}
							tabindex="-1"
							aria-label={t.pane.tabActions}
							title={t.pane.tabActions}
							aria-haspopup="menu"
							aria-expanded={more?.tabId === tab.id}
							onclick={(event) => {
								event.stopPropagation();
								onFocus(leaf.id);
								toggleMore(tab.id, event.currentTarget);
							}}
						>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
								<circle cx="5" cy="12" r="2"></circle>
								<circle cx="12" cy="12" r="2"></circle>
								<circle cx="19" cy="12" r="2"></circle>
							</svg>
						</button>
					{/if}
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
		{#if canOpen && leaf.tabs.length > 0}
			<button
				type="button"
				class="wb-new-tab"
				bind:this={newTabButton}
				aria-label={t.pane.newTab}
				aria-haspopup="menu"
				aria-expanded={newTabOpen}
				aria-controls={newTabOpen ? `wb-new-${leaf.id}` : undefined}
				title={t.pane.newTab}
				onclick={toggleNewTab}
				onkeydown={onNewTabKey}>＋</button
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
		{#if leaf.tabs.length === 0 && onClosePane}
			<button
				type="button"
				class="wb-pane-close"
				aria-label={t.pane.close}
				title={t.pane.close}
				onclick={(event) => {
					event.stopPropagation();
					onClosePane?.(leaf.id);
				}}>×</button
			>
		{/if}
		{#if newTabOpen && canOpen}
			<!-- Listed, and only as wide as the menu: a row of chips grew with every shell. -->
			<div
				class="wb-new-menu"
				id={`wb-new-${leaf.id}`}
				role="menu"
				tabindex="-1"
				aria-label={t.pane.newTab}
				bind:this={newTabMenu}
				use:portal
				onkeydown={onMenuKey}
			>
				<label class="wb-new-query">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
						<circle cx="11" cy="11" r="7"></circle>
						<line x1="16.5" y1="16.5" x2="21" y2="21"></line>
					</svg>
					<input
						bind:this={newTabQuery}
						type="search"
						placeholder={t.pane.findOpen}
						aria-label={t.pane.findOpen}
						bind:value={newTabFilter}
						onkeydown={(event) => {
							if (event.key === 'ArrowDown') {
								event.preventDefault();
								event.stopPropagation();
								focusMenuItem(0);
							}
						}}
					/>
				</label>
				<div class="wb-new-scroll">
					{#if menuActions}
						{@render menuActions(leaf.id, newTabFilter)}
					{:else if emptyActions}
						{@render emptyActions(leaf.id)}
					{/if}
				</div>
			</div>
		{/if}
	</div>
	{#if more && moreTab && tabActions}
		{@const open = more}
		{@const at = moreAt(open.anchor)}
		<PaneContextMenu
			x={at.x}
			y={at.y}
			{t}
			label={t.pane.tabActions}
			actions={tabActions(leaf.id, moreTab)}
			anchor={open.anchor}
			onClose={() => (more = null)}
		/>
	{/if}
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
				<div class="wb-empty-head">
					<span class="wb-empty-glyph" aria-hidden="true">
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"></rect>
							<line x1="12" y1="8.5" x2="12" y2="15.5"></line>
							<line x1="8.5" y1="12" x2="15.5" y2="12"></line>
						</svg>
					</span>
					<p class="wb-empty-title">{t.pane.empty}</p>
					<p class="wb-empty-hint">{menuActions || emptyActions ? t.pane.emptyPick : t.pane.emptyHint}</p>
				</div>
				{#if menuActions}
					<!-- The + menu's own list and filter, set down in the pane: one look for one offer. -->
					<div
						class="wb-empty-card"
						role="menu"
						tabindex="-1"
						aria-label={t.pane.newTab}
						bind:this={emptyList}
						onkeydown={(event) => onMenuKey(event, emptyList, emptyQuery)}
					>
						<label class="wb-new-query">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
								<circle cx="11" cy="11" r="7"></circle>
								<line x1="16.5" y1="16.5" x2="21" y2="21"></line>
							</svg>
							<input
								bind:this={emptyQuery}
								type="search"
								placeholder={t.pane.findOpen}
								aria-label={t.pane.findOpen}
								bind:value={emptyFilter}
								onkeydown={(event) => {
									if (event.key === 'ArrowDown') {
										event.preventDefault();
										event.stopPropagation();
										focusMenuItem(0, emptyList);
									}
								}}
							/>
						</label>
						<div class="wb-new-scroll">
							{@render menuActions(leaf.id, emptyFilter)}
						</div>
					</div>
				{:else if emptyActions}
					<div class="wb-empty-actions">{@render emptyActions(leaf.id)}</div>
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
	/* Along the top, not the bottom: the bottom is where the tab joins the content, and a line
	   there would cut the join the flares exist to make. */
	.wb-leaf.is-focused .wb-tab.is-active {
		box-shadow: inset 0 2px 0 0 var(--accent);
	}
	/*
	 * Drawn as a layer over the content, not as the pane's own outline or border: the strip and
	 * the chat header both paint a background right up to the pane's edge, and an outline on the
	 * pane sits under them. Over the pane's own layers (its settings scrim is 30) and under the
	 * floating panes (40 and up), which draw their own.
	 */
	.wb-leaf.is-framed::after {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 35;
		box-shadow: inset 0 0 0 1px var(--accent);
		pointer-events: none;
	}
	/*
	 * The strip reads the way a browser's does: it sits a shade below the content, and the active
	 * tab is the same colour as the content with its bottom corners flaring outward, so the two
	 * are one surface. The tabs that are not active stay on the strip, recessed.
	 */
	/*
	 * The strip is also what a tab asks how wide its pane is. It is the pane's full width with no
	 * padding of its own — the 4px sides are the end children's margins — so it crosses 680px
	 * exactly when the conversation under it does, and the header folds into the tab at the moment
	 * the tab takes it. A container is a containing block for `fixed` descendants, which is why the
	 * pane itself is not one; nothing fixed lives in the strip, and its menus are portaled.
	 */
	.wb-strip {
		--wb-tab-flare: 8px;
		container: wb-strip / inline-size;
		display: flex;
		align-items: flex-end;
		gap: 0;
		height: 32px;
		padding: 0;
		background: var(--bg);
		flex: 0 0 auto;
		position: relative;
		z-index: 1;
	}
	.wb-strip > :last-child {
		margin-right: 4px;
	}
	/*
	 * The strip is a stacking context of its own, so the menu's z-index only counts inside it, and
	 * the pane body beneath shares the layer the strip sits in: the conversation's header (z 2), a
	 * composer popup, the flow board's switcher all painted over the open menu. While the menu is
	 * open the strip goes above the panes' content and the floating panes, and still below the
	 * window-wide context menus and dialogs (1000).
	 */
	.wb-strip.is-menu-open {
		z-index: 200;
	}
	.wb-tabs {
		display: flex;
		align-items: flex-end;
		min-width: 0;
		margin-left: 4px;
		overflow-x: auto;
		overflow-y: hidden;
		scrollbar-width: none;
	}
	.wb-tabs::-webkit-scrollbar {
		display: none;
	}
	.wb-tab {
		/* What the tab is painted, for a label that rings its picture in the same colour. */
		--wb-tab-surface: var(--bg);
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
	/*
	 * Activating a tab changes its colour and its shape, never its box. A heavier weight made
	 * Latin labels a few pixels wider — `storyboard.md` went from 83 to 88 — and a taller active
	 * tab jumped up two pixels, so every click nudged the strip. The flares and the surface
	 * colour say which tab is active; nothing about its size should.
	 */
	.wb-tab.is-active {
		--wb-tab-surface: var(--pane);
		background: var(--pane);
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
	/*
	 * A tab's picture and its ⋯ are for a narrow pane, where they stand in for the header the
	 * conversation no longer shows. A wide pane keeps the header, and the tab its plain name.
	 */
	.wb-tab-button :global(.wb-tab-icon),
	.wb-tab-more {
		display: none;
	}
	.wb-tab-more {
		place-items: center;
		width: 18px;
		height: 18px;
		flex: 0 0 auto;
		padding: 0;
		border-radius: 50%;
		color: var(--muted);
		background: none;
		opacity: 0;
	}
	.wb-tab-more:hover,
	.wb-tab-more.is-open {
		background: var(--row-hover);
		color: var(--ink);
	}
	/* The strip's own width, which is the pane's: see `.wb-strip`. */
	@container wb-strip (max-width: 680px) {
		.wb-tab-button :global(.wb-tab-icon) {
			display: inline-flex;
		}
		.wb-tab-more {
			display: grid;
		}
		/* It keeps its room while it is hidden, so hovering a tab never moves the strip. */
		.wb-tab:hover .wb-tab-more,
		.wb-tab:focus-within .wb-tab-more,
		.wb-tab-more.is-open {
			opacity: 1;
		}
	}
	.wb-new-tab,
	.wb-pane-menu,
	.wb-pane-close {
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
	.wb-pane-menu,
	.wb-pane-close {
		margin-left: auto;
	}
	.wb-new-tab:hover,
	.wb-pane-menu:hover,
	.wb-pane-close:hover {
		background: var(--row-hover);
		color: var(--ink);
	}
	/*
	 * A menu, not a wrap of chips. Width is fixed so a dozen shells cannot stretch it; the list
	 * scrolls inside. It is portaled to the body: a pane clips overflow, and above the floating
	 * panes (z 40 and up) while staying under the window menus (1000).
	 */
	.wb-new-menu {
		position: fixed;
		z-index: 500;
		display: flex;
		flex-direction: column;
		width: 280px;
		max-width: calc(100vw - 16px);
		max-height: min(420px, calc(100vh - 48px));
		padding: 6px;
		border-radius: 12px;
		background: var(--pane);
		color: var(--ink);
		box-shadow:
			0 16px 40px -8px rgb(0 0 0 / 0.28),
			0 2px 8px rgb(0 0 0 / 0.08),
			inset 0 0 0 1px var(--line);
		overflow: hidden;
	}
	.wb-new-query {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
		margin: 0 0 4px;
		padding: 0 8px;
		height: 30px;
		border-radius: 8px;
		background: var(--bg);
		color: var(--muted);
		box-shadow: inset 0 0 0 1px var(--line);
	}
	.wb-new-query svg {
		flex: 0 0 auto;
	}
	.wb-new-query input {
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--ink);
		font-size: 12px;
		outline: none;
	}
	.wb-new-query input::placeholder {
		color: var(--muted);
	}
	.wb-new-query input::-webkit-search-cancel-button {
		appearance: none;
	}
	.wb-new-query:focus-within {
		box-shadow: inset 0 0 0 1px var(--accent-border);
		color: var(--accent);
	}
	/* The field's own ring would stack on the bar's. The bar is what shows focus. */
	.wb-new-query input:focus-visible {
		box-shadow: none;
		border-color: transparent !important;
	}
	.wb-new-scroll {
		flex: 1 1 auto;
		min-height: 0;
		overflow: auto;
		overscroll-behavior: contain;
	}
	/* Rows the host paints into the menu. An empty pane uses `.pane-open` and ignores these. */
	.wb-new-scroll :global(.wb-menu-section) {
		padding: 8px 8px 2px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		color: var(--muted);
	}
	.wb-new-scroll :global(.wb-menu-section:not(:first-child)) {
		margin-top: 4px;
		border-top: 1px solid var(--line);
		padding-top: 8px;
	}
	.wb-new-scroll :global(.wb-menu-row) {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 32px;
		padding: 5px 8px;
		border-radius: 8px;
		background: transparent;
		color: var(--ink);
		text-align: left;
		cursor: pointer;
	}
	.wb-new-scroll :global(.wb-menu-row:hover:not(:disabled)) {
		background: var(--row-hover);
	}
	.wb-new-scroll :global(.wb-menu-row:focus-visible) {
		background: var(--row-hover);
		outline: none;
		box-shadow: inset 0 0 0 1px var(--accent-border);
		border-color: transparent;
	}
	.wb-new-scroll :global(.wb-menu-row:disabled) {
		color: var(--muted);
		cursor: default;
	}
	.wb-new-scroll :global(.wb-menu-mark) {
		flex: 0 0 auto;
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		border-radius: 6px;
		background: var(--accent-tint);
		color: var(--accent);
	}
	.wb-new-scroll :global(.wb-menu-mark.is-quiet) {
		background: var(--bg);
		color: var(--muted);
	}
	.wb-new-scroll :global(.wb-menu-copy) {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}
	.wb-new-scroll :global(.wb-menu-name) {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 12.5px;
		line-height: 1.3;
	}
	.wb-new-scroll :global(.wb-menu-meta) {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 11px;
		line-height: 1.3;
		color: var(--muted);
	}
	.wb-new-scroll :global(.wb-menu-empty) {
		padding: 10px 8px 8px;
		font-size: 12px;
		color: var(--muted);
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
		gap: 16px;
		padding: 24px 16px;
		text-align: center;
	}
	.wb-empty-head {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		flex: 0 0 auto;
	}
	.wb-empty-glyph {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		margin-bottom: 6px;
		border-radius: 10px;
		background: var(--accent-tint);
		color: var(--accent);
	}
	.wb-empty-title {
		margin: 0;
		color: var(--ink);
		font-size: 14px;
		font-weight: 600;
	}
	.wb-empty-hint {
		margin: 0;
		color: var(--muted);
		font-size: 12px;
	}
	/*
	 * The + menu's card, resting in the pane instead of floating over it: the same padding,
	 * radius and hairline, a lighter shadow. In a short pane it gives up height before the
	 * heading does, and the rows scroll inside it.
	 */
	.wb-empty-card {
		display: flex;
		flex-direction: column;
		flex: 0 1 auto;
		width: min(300px, 100%);
		max-height: 360px;
		min-height: 0;
		padding: 6px;
		border-radius: 12px;
		background: var(--pane);
		color: var(--ink);
		text-align: left;
		box-shadow:
			0 12px 32px -16px rgb(0 0 0 / 0.35),
			inset 0 0 0 1px var(--line);
	}
	.wb-empty-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		justify-content: center;
	}
</style>
