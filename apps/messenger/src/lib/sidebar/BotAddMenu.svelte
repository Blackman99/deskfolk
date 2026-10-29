<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import { dismissOnOutside } from '../dismissable-menu.ts';
	import { roveFocus } from '../menu-roving.ts';

	/**
	 * What the + of the 「Bot」 section offers: a new Bot or a new group, the two kinds of
	 * conversation the section lists together. It hangs under the +, walks with the arrow keys,
	 * closes on Escape, Tab or a press elsewhere, and hands focus back to the +. The positioning and
	 * the look are `ProjectAddMenu`'s; the two could become one anchored menu.
	 */
	type Props = {
		t: Copy;
		/** The + it hangs from. */
		anchor: HTMLElement | null;
		open: boolean;
		onCreateBot: () => void;
		onCreateGroup: () => void;
	};

	let { t, anchor, open = $bindable(false), onCreateBot, onCreateGroup }: Props = $props();
	let menuEl = $state<HTMLElement | null>(null);

	function close(): void {
		open = false;
		anchor?.focus();
	}

	function choose(action: () => void): void {
		open = false;
		action();
	}

	$effect(() => {
		if (!open || !menuEl || !anchor) return;
		const m = menuEl.getBoundingClientRect();
		const margin = 8;
		// Under the +, its right edge on the +'s, kept inside the window.
		const a = anchor.getBoundingClientRect();
		const below = a.bottom + 4;
		const top = below + m.height <= window.innerHeight - margin ? below : a.top - m.height - 4;
		menuEl.style.left = `${Math.max(margin, Math.min(a.right - m.width, window.innerWidth - m.width - margin))}px`;
		menuEl.style.top = `${Math.max(margin, top)}px`;
		return dismissOnOutside(menuEl, () => (open = false), { anchor: () => anchor });
	});
</script>

{#if open}
	<!-- svelte-ignore a11y_interactive_supports_focus -->
	<div
		bind:this={menuEl}
		class="bot-add-menu"
		role="menu"
		aria-label={t.sidebar.createMenu}
		data-bot-add-menu
		onkeydown={(e) => {
			if (e.key === 'Escape' || e.key === 'Tab') {
				if (e.key === 'Escape') e.preventDefault();
				e.stopPropagation();
				close();
				return;
			}
			roveFocus(e, () => Array.from(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []));
		}}
	>
		<button type="button" class="bot-add-item" role="menuitem" data-bot-add="bot" onclick={() => choose(onCreateBot)}>
			<Icon name="bot" />
			<span>{t.sidebar.addBot}</span>
		</button>
		<button type="button" class="bot-add-item" role="menuitem" data-bot-add="group" onclick={() => choose(onCreateGroup)}>
			<Icon name="users" />
			<span>{t.sidebar.addGroup}</span>
		</button>
	</div>
{/if}

<style>
	.bot-add-menu {
		animation: menuIn var(--dur-base) var(--ease-out);
		position: fixed;
		z-index: 100;
		display: flex;
		flex-direction: column;
		min-width: 200px;
		padding: 5px;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-lg);
	}

	.bot-add-item {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 36px;
		padding: 0 10px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font: 500 13px/1.2 var(--font);
		text-align: left;
		white-space: nowrap;
	}

	.bot-add-item:hover,
	.bot-add-item:focus-visible {
		background: var(--row-hover);
		outline: none;
	}

	.bot-add-item :global(.icon) {
		color: var(--muted);
	}
</style>
