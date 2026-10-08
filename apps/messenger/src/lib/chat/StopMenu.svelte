<script lang="ts">
	import { tick } from 'svelte';
	import { isOutside } from '../click-outside.ts';
	import { roveFocus } from '../menu-roving.ts';
	import type { Copy } from '../copy.ts';
	import type { StopMenuItem } from './stop-menu.ts';

	/**
	 * The stop menu (ADR 0040 P2): a square-and-chevron button that opens the choices of what to stop
	 * — this Bot, this job, every Bot. The choices come from `stop-menu.ts`; picking one hands it to
	 * the owner, which makes the stop, and a refusal it hands back is said by the button until your
	 * next click. Arrow keys walk it, Escape or a click elsewhere closes it and gives focus back to the
	 * button.
	 */
	type Props = {
		items: readonly StopMenuItem[];
		t: Copy;
		/** Opens upward over a composer, downward under a header. */
		placement?: 'above' | 'below';
		/** A word beside the icon, where there is room for one. */
		label?: string | null;
		/** `sm` beside a header's small buttons; `md` beside the composer's send button. */
		size?: 'sm' | 'md';
		disabled?: boolean;
		/** Makes the stop; what it resolves to is a refusal to show (an `ApiError`), or nothing. */
		onPick: (item: StopMenuItem) => Promise<unknown> | void;
	};

	let { items, t, placement = 'above', label = null, size = 'md', disabled = false, onPick }: Props = $props();

	let open = $state(false);
	let failed = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	let menu = $state<HTMLElement | null>(null);

	function entries(): HTMLButtonElement[] {
		return Array.from(menu?.querySelectorAll<HTMLButtonElement>('.stop-menu-item') ?? []);
	}

	async function toggle(): Promise<void> {
		open = !open;
		failed = false;
		if (!open) return;
		await tick();
		entries()[0]?.focus();
	}

	function close(): void {
		open = false;
		trigger?.focus();
	}

	/** The click that picked: it reaches the window after the refusal may already be in. */
	let pickedWith: Event | null = null;

	async function pick(item: StopMenuItem, e: Event): Promise<void> {
		pickedWith = e;
		open = false;
		failed = false;
		try {
			failed = Boolean(await onPick(item));
		} catch {
			failed = true;
		}
	}

	function onKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Escape' || e.key === 'Tab') {
			if (e.key === 'Escape') e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		roveFocus(e, entries);
	}

	function onWindowClick(e: MouseEvent): void {
		// The note sits where the menu was, over whatever is below it: any later click puts it away.
		if (e !== pickedWith) failed = false;
		if (open && menu && trigger && isOutside(e.target as Node | null, menu, trigger)) open = false;
	}

	// Nothing left to choose (it was all stopped meanwhile): the menu goes with it.
	$effect(() => {
		if (items.length === 0) open = false;
	});
</script>

<svelte:window onclick={onWindowClick} />

<div class="stop-menu" class:is-below={placement === 'below'}>
	<button
		bind:this={trigger}
		type="button"
		class="stop-menu-trigger"
		class:has-label={Boolean(label)}
		class:is-sm={size === 'sm'}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label={t.control.menu}
		title={t.control.menu}
		disabled={disabled || items.length === 0}
		onclick={() => void toggle()}
	>
		<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
		{#if label}<span>{label}</span>{/if}
		<svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points={placement === 'below' ? '6 9 12 15 18 9' : '6 15 12 9 18 15'}></polyline></svg>
	</button>
	{#if open}
		<div bind:this={menu} class="stop-menu-list" role="menu" tabindex="-1" aria-label={t.control.menu} onkeydown={onKeyDown}>
			{#each items as item (item.key)}
				<button type="button" role="menuitem" class="stop-menu-item" onclick={(e) => void pick(item, e)}>{item.label}</button>
			{/each}
		</div>
	{:else if failed}
		<span class="stop-menu-error" role="status">{t.control.failed}</span>
	{/if}
</div>

<style>
	.stop-menu {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
	}

	.stop-menu-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		height: 34px;
		min-width: 34px;
		padding: 0 8px;
		color: var(--ink-secondary);
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.stop-menu-trigger.has-label {
		padding: 0 10px;
		border-radius: var(--radius-sm);
		font-size: var(--text-caption);
		font-weight: 500;
	}

	.stop-menu-trigger.is-sm {
		height: 26px;
		min-width: 26px;
	}

	.stop-menu-trigger:hover:not(:disabled),
	.stop-menu-trigger[aria-expanded='true'] {
		color: var(--ink);
		border-color: var(--ink-secondary);
	}

	.stop-menu-trigger:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.stop-menu-list {
		position: absolute;
		right: 0;
		bottom: calc(100% + 6px);
		z-index: 30;
		display: flex;
		flex-direction: column;
		min-width: 200px;
		max-width: min(320px, 90vw);
		padding: 4px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-menu);
	}

	.stop-menu.is-below .stop-menu-list,
	.stop-menu.is-below .stop-menu-error {
		top: calc(100% + 6px);
		bottom: auto;
	}

	/* Where the menu was, so the row it sits in does not move. */
	.stop-menu-error {
		position: absolute;
		right: 0;
		bottom: calc(100% + 6px);
		z-index: 30;
		padding: 4px 8px;
		font-size: var(--text-caption);
		color: var(--danger-text);
		white-space: nowrap;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		box-shadow: var(--shadow-menu);
	}

	.stop-menu-item {
		padding: 7px 10px;
		font-size: var(--text-small);
		color: var(--ink);
		text-align: left;
		background: transparent;
		border: 0;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.stop-menu-item:hover,
	.stop-menu-item:focus-visible {
		background: var(--chip);
		outline: none;
	}

	@media (pointer: coarse) {
		.stop-menu-item {
			padding: 12px;
		}
	}
</style>
