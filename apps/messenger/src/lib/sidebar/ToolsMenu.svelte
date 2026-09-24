<script lang="ts">
	import { untrack } from 'svelte';
	import { isOutside } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import { spendCopyFor } from '../spend/spend-copy.ts';

	/**
	 * The 工具 popover: routines, spend, a terminal, and — after a line — the archived sessions. One
	 * menu for every button that opens it: the list's footer, the phone's search row, and the rail
	 * the list folds into. The button stays with its owner; this hangs off it, walks with the arrow
	 * keys, closes on Escape, Tab or a click elsewhere, and hands focus back to the button.
	 */
	type Props = {
		t: Copy;
		locale: 'zh' | 'en';
		/** Phone labels name the page; desktop labels name the tab. */
		phone: boolean;
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
		current?: { routines?: boolean; spend?: boolean; terminal?: boolean; archived?: boolean };
		onOpenRoutines: () => void;
		onOpenSpend: () => void;
		onOpenTerminal: () => void;
		onOpenArchived: () => void;
	};

	let {
		t,
		locale,
		phone,
		anchor,
		open = $bindable(false),
		placement = 'stack',
		focusLast = $bindable(false),
		archivedCount,
		current = {},
		onOpenRoutines,
		onOpenSpend,
		onOpenTerminal,
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
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
		e.preventDefault();
		const items = itemsOf();
		if (!items.length) return;
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? index + 1 : index - 1;
		items[(next + items.length) % items.length]?.focus();
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
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<rect x="3" y="4" width="18" height="17" rx="2"></rect>
				<line x1="3" y1="9" x2="21" y2="9"></line>
				<line x1="8" y1="2" x2="8" y2="6"></line>
				<line x1="16" y1="2" x2="16" y2="6"></line>
			</svg>
			<span>{phone ? t.calendar.open : t.routines.title}</span>
		</button>
		<button
			type="button"
			class="tools-menu-item"
			role="menuitem"
			aria-current={current.spend ? 'true' : undefined}
			onclick={() => choose(onOpenSpend)}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<line x1="12" y1="1" x2="12" y2="23"></line>
				<path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
			</svg>
			<span>{spendCopy.open}</span>
		</button>
		<button
			type="button"
			class="tools-menu-item"
			role="menuitem"
			aria-current={current.terminal ? 'true' : undefined}
			onclick={() => choose(onOpenTerminal)}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<polyline points="4 17 10 11 4 5"></polyline>
				<line x1="12" y1="19" x2="20" y2="19"></line>
			</svg>
			<span>{phone ? t.terminal.title : t.terminal.newTab}</span>
		</button>
		<div class="tools-menu-divider" role="separator"></div>
		<button
			type="button"
			class="tools-menu-item tools-menu-archived"
			role="menuitem"
			aria-current={current.archived ? 'true' : undefined}
			onclick={() => choose(onOpenArchived)}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<polyline points="21 8 21 21 3 21 3 8"></polyline>
				<rect x="1" y="3" width="22" height="5"></rect>
				<line x1="10" y1="12" x2="14" y2="12"></line>
			</svg>
			<span>{t.sidebar.archivedSessions}</span>
			{#if archivedCount > 0}
				<span class="tools-menu-badge">{archivedCount}</span>
			{/if}
		</button>
	</div>
{/if}

<style>
	.tools-menu {
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

	.tools-menu-item:hover,
	.tools-menu-item:focus-visible {
		background: var(--line-subtle);
		outline: none;
	}

	.tools-menu-item svg {
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
		border-radius: 999px;
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 11.5px;
		font-weight: 600;
	}

	@media (max-width: 680px) {
		.tools-menu-item {
			min-height: 44px;
			font-size: 14px;
		}
	}
</style>
