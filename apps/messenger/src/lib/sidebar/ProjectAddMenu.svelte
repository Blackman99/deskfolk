<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import { dismissOnOutside } from '../dismissable-menu.ts';
	import { roveFocus } from '../menu-roving.ts';

	/**
	 * What the 「项目」 section's + offers (ADR 0095): a new session in a folder you pick, or a
	 * terminal session to carry on. It hangs under the + in the corner, walks with the arrow keys,
	 * closes on Escape, Tab or a press elsewhere, and hands focus back to the +.
	 */
	type Props = {
		t: Copy;
		/** The + it hangs from. */
		anchor: HTMLElement | null;
		open: boolean;
		onNew: () => void;
		onImport: () => void;
	};

	let { t, anchor, open = $bindable(false), onNew, onImport }: Props = $props();
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
		// Under the +, its right edge on the +'s, kept inside the window.
		const a = anchor.getBoundingClientRect();
		const m = menuEl.getBoundingClientRect();
		const margin = 8;
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
		class="project-add-menu"
		role="menu"
		aria-label={t.project.add}
		data-project-add-menu
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
		<button type="button" class="project-add-item" role="menuitem" data-project-add="new" onclick={() => choose(onNew)}>
			<Icon name="folder" />
			<span>{t.project.newInFolder}</span>
		</button>
		<button type="button" class="project-add-item" role="menuitem" data-project-add="import" onclick={() => choose(onImport)}>
			<Icon name="file-down" />
			<span>{t.project.importSession}</span>
		</button>
	</div>
{/if}

<style>
	.project-add-menu {
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

	.project-add-item {
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

	.project-add-item:hover,
	.project-add-item:focus-visible {
		background: var(--row-hover);
		outline: none;
	}

	.project-add-item :global(.icon) {
		color: var(--muted);
	}
</style>
