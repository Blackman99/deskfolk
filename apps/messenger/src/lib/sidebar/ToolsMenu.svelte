<script lang="ts">
	import Icon from '../Icon.svelte';
	import { untrack } from 'svelte';
	import { isOutside } from '../click-outside.ts';
	import { roveFocus } from '../menu-roving.ts';
	import { screenCopy, type Copy } from '../copy.ts';
	import { spendCopyFor } from '../spend/spend-copy.ts';

	/**
	 * The 工具 popover: routines, spend, usage, a terminal, the Mac's screen on a phone that can reach it,
	 * and — after a line — the archived sessions. One
	 * menu for every button that opens it: the list's footer, the phone's search row, and the rail
	 * the list folds into. The button stays with its owner; this hangs off it, walks with the arrow
	 * keys, closes on Escape, Tab or a click elsewhere, and hands focus back to the button.
	 */
	type Props = {
		t: Copy;
		locale: 'zh' | 'en';
		/** Hangs under its button on a phone, over it elsewhere. */
		phone: boolean;
		/**
		 * The tools open pages, not workbench tabs, so the labels name the page rather than the tab.
		 * A phone's do, and so do a tablet's on a remote connection, which is wider and still has no
		 * workbench.
		 */
		pages: boolean;
		/** The button that opened it: the menu hangs off it and gives focus back to it. */
		anchor: HTMLElement | null;
		open: boolean;
		/**
		 * Where it goes: stacked over the anchor (under it on a phone), or `flyout` — out to the side,
		 * bottoms aligned — for a rail whose own buttons it must not cover.
		 */
		placement?: 'stack' | 'flyout';
		/** ArrowUp on the anchor asks for the last item; cleared once the menu has taken it. */
		focusLast?: boolean;
		archivedCount: number;
		/** What is on screen now, for the phone's pages. */
		current?: { routines?: boolean; spend?: boolean; usage?: boolean; roles?: boolean; terminal?: boolean; screen?: boolean; archived?: boolean };
		onOpenRoutines: () => void;
		onOpenSpend: () => void;
		/** Every agent's usage (ADR 0080): the floating widget's panel, or a phone's page. */
		onOpenUsage?: (() => void) | null;
		/** Roles (ADR 0083): the app's own calls, their models and prompts, as a page of its own. */
		onOpenRoles?: (() => void) | null;
		onOpenTerminal: () => void;
		/** The remote screen; null where this is not a phone on a Mac that offers it. */
		onOpenScreen?: (() => void) | null;
		/** Whose screen that is, for its name: a Mac's, or a Windows PC's. */
		screenHost?: 'mac' | 'windows';
		onOpenArchived: () => void;
	};

	let {
		t,
		locale,
		phone,
		pages,
		anchor,
		open = $bindable(false),
		placement = 'stack',
		focusLast = $bindable(false),
		archivedCount,
		current = {},
		onOpenRoutines,
		onOpenSpend,
		onOpenUsage = null,
		onOpenRoles = null,
		onOpenTerminal,
		onOpenScreen = null,
		screenHost = 'mac',
		onOpenArchived
	}: Props = $props();

	const spendCopy = $derived(spendCopyFor(locale));
	let menuEl = $state<HTMLElement | null>(null);

	function place(): void {
		if (!open || !menuEl || !anchor) return;
		const a = anchor.getBoundingClientRect();
		const m = menuEl.getBoundingClientRect();
		const margin = 8;
		let left: number;
		let top: number;
		if (placement === 'flyout') {
			const beside = a.right + 6;
			left = beside + m.width <= window.innerWidth - margin ? beside : a.left - m.width - 6;
			top = a.bottom - m.height;
		} else {
			const above = a.top - m.height - 6;
			const below = a.bottom + 6;
			const preferred = phone ? below : above;
			const fallback = phone ? above : below;
			top = preferred >= margin && preferred + m.height <= window.innerHeight - margin ? preferred : fallback;
			left = a.left;
		}
		menuEl.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - m.width - margin))}px`;
		menuEl.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - m.height - margin))}px`;
	}

	$effect(() => {
		if (open && menuEl) {
			place();
			const items = itemsOf();
			// Read untracked: clearing it here must not run this again and move focus back to the first.
			const last = untrack(() => focusLast);
			items[last ? items.length - 1 : 0]?.focus();
			focusLast = false;
		}
	});

	$effect(() => {
		if (!open || !anchor || !menuEl) return;
		const observer = new ResizeObserver(place);
		observer.observe(anchor);
		observer.observe(menuEl);
		if (anchor.parentElement) observer.observe(anchor.parentElement);
		return () => observer.disconnect();
	});

	function itemsOf(): HTMLButtonElement[] {
		return Array.from(menuEl?.querySelectorAll<HTMLButtonElement>('.tools-menu-item:not(:disabled)') ?? []);
	}

	function close(): void {
		open = false;
		anchor?.focus();
	}

	function choose(action: () => void): void {
		close();
		action();
	}

	function onMenuKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Escape' || e.key === 'Tab') {
			if (e.key === 'Escape') e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		roveFocus(e, itemsOf);
	}

	/**
	 * A click elsewhere closes it. Escape order is the shell's; this is not. The click that opened
	 * it reaches the window in the same tick, before the menu (or, right after mount, the anchor)
	 * is in the DOM: with nothing to be outside of, it is not an outside click.
	 */
	function onWindowClick(e: MouseEvent): void {
		if (open && menuEl && anchor && isOutside(e.target as Node | null, menuEl, anchor)) open = false;
	}
</script>

<svelte:window onclick={onWindowClick} onresize={place} />

{#if open}
	<div
		bind:this={menuEl}
		id="sidebar-tools-menu"
		class="tools-menu"
		aria-label={t.sidebar.tools}
		role="menu"
		tabindex="-1"
		onkeydown={onMenuKeyDown}
	>
		<button
			type="button"
			class="tools-menu-item"
			role="menuitem"
			aria-current={current.routines ? 'true' : undefined}
			onclick={() => choose(onOpenRoutines)}
		>
			<Icon name="calendar" />
			<span>{pages ? t.calendar.open : t.routines.title}</span>
		</button>
		<button
			type="button"
			class="tools-menu-item"
			role="menuitem"
			aria-current={current.spend ? 'true' : undefined}
			onclick={() => choose(onOpenSpend)}
		>
			<Icon name="dollar" />
			<span>{spendCopy.open}</span>
		</button>
		{#if onOpenUsage}
			<button
				type="button"
				class="tools-menu-item"
				role="menuitem"
				aria-current={current.usage ? 'true' : undefined}
				data-tools-usage
				onclick={() => choose(onOpenUsage)}
			>
				<Icon name="gauge" />
				<span>{t.usage.open}</span>
			</button>
		{/if}
		<button
			type="button"
			class="tools-menu-item"
			role="menuitem"
			aria-current={current.terminal ? 'true' : undefined}
			onclick={() => choose(onOpenTerminal)}
		>
			<Icon name="terminal" />
			<span>{pages ? t.terminal.title : t.terminal.newTab}</span>
		</button>
		{#if onOpenScreen}
			<button
				type="button"
				class="tools-menu-item"
				role="menuitem"
				aria-current={current.screen ? 'true' : undefined}
				onclick={() => choose(onOpenScreen)}
			>
				<Icon name="monitor" />
				<span>{screenCopy(t, screenHost).title}</span>
			</button>
		{/if}
		{#if onOpenRoles}
			<button
				type="button"
				class="tools-menu-item"
				role="menuitem"
				aria-current={current.roles ? 'true' : undefined}
				data-tools-roles
				onclick={() => choose(onOpenRoles)}
			>
				<Icon name="nodes" />
				<span>{t.routing.tab}</span>
			</button>
		{/if}
		<div class="tools-menu-divider" role="separator"></div>
		<button
			type="button"
			class="tools-menu-item tools-menu-archived"
			role="menuitem"
			aria-current={current.archived ? 'true' : undefined}
			onclick={() => choose(onOpenArchived)}
		>
			<Icon name="archive" />
			<span>{t.sidebar.archivedSessions}</span>
			{#if archivedCount > 0}
				<span class="tools-menu-badge">{archivedCount}</span>
			{/if}
		</button>
	</div>
{/if}

<style>
	.tools-menu {
		animation: menuIn var(--dur-base) var(--ease-out);
		position: fixed;
		z-index: 100;
		display: flex;
		flex-direction: column;
		width: 208px;
		max-width: calc(100vw - 16px);
		max-height: calc(100dvh - 16px);
		overflow-y: auto;
		padding: 5px;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-lg);
	}

	.tools-menu-item {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 38px;
		flex-shrink: 0;
		padding: 0 10px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font: 500 13px/1.2 var(--font);
		text-align: left;
		cursor: pointer;
	}

	.tools-menu-item:hover:not(:disabled),
	.tools-menu-item:focus-visible {
		background: var(--line-subtle);
		outline: none;
	}

	.tools-menu-item:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.tools-menu-item :global(.icon) {
		flex-shrink: 0;
		color: var(--muted);
	}

	.tools-menu-divider {
		height: 1px;
		margin: 5px;
		background: var(--line);
		flex-shrink: 0;
	}

	.tools-menu-badge {
		margin-left: auto;
		padding: 1px 7px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 12px;
		font-weight: 600;
	}

	@media (max-width: 680px) {
		.tools-menu-item {
			min-height: 44px;
			font-size: 14px;
		}
	}
</style>
