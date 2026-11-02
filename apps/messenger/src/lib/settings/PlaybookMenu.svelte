<script lang="ts">
	import type { Playbook } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import { dismissOnOutside } from '../dismissable-menu.ts';
	import { roveFocus } from '../menu-roving.ts';
	import { computeContextMenuPosition } from '../sidebar/session-context-menu.ts';

	/**
	 * What one engine on Roles' list offers, as a conversation's row does (ADR 0085): make it the
	 * default, a new one made from it, a rename, its history, and removing it. A built-in has no name
	 * of its own to change and cannot go; the default cannot go either, and says why. It hangs where
	 * the row was right-clicked, or under the row's ⋯; walks with the arrow keys, closes on Escape,
	 * Tab or a press elsewhere, and hands focus back to the row.
	 */
	type Props = {
		playbook: Playbook;
		isDefault: boolean;
		/** The row's ⋯, or the row itself when it was right-clicked: focus goes back there. */
		anchor: HTMLElement;
		/** Where a right-click opened it; null hangs it under the anchor. */
		point: { x: number; y: number } | null;
		label: string;
		t: Copy;
		onClose: () => void;
		/** Each is handed the engine's id: the menu is gone by the time it runs. */
		onMakeDefault: (id: string) => void;
		onNew: (id: string) => void;
		onRename: (id: string) => void;
		onHistory: (id: string) => void;
		onRemove: (id: string) => void;
	};

	let { playbook, isDefault, anchor, point, label, t, onClose, onMakeDefault, onNew, onRename, onHistory, onRemove }: Props = $props();
	const c = $derived(t.playbooks);
	let menuEl = $state<HTMLElement | null>(null);

	function close(): void {
		// Read before closing: the anchor is the list's, and it lets go of it as the menu closes.
		const back = anchor;
		onClose();
		back.focus();
	}

	function choose(action: (id: string) => void): void {
		const id = playbook.id;
		onClose();
		action(id);
	}

	/** Moved to `document.body`: a floating pane's transform would make `fixed` resolve against the pane, and a pane clips overflow. */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}

	$effect(() => {
		if (!menuEl) return;
		const m = menuEl.getBoundingClientRect();
		const margin = 8;
		if (point) {
			const at = computeContextMenuPosition(point.x, point.y, m.width, m.height, window.innerWidth, window.innerHeight, margin);
			menuEl.style.left = `${at.x}px`;
			menuEl.style.top = `${at.y}px`;
			return dismissOnOutside(menuEl, onClose);
		}
		// Under the ⋯, its right edge on the ⋯'s, kept inside the window.
		const a = anchor.getBoundingClientRect();
		const below = a.bottom + 4;
		const top = below + m.height <= window.innerHeight - margin ? below : a.top - m.height - 4;
		menuEl.style.left = `${Math.max(margin, Math.min(a.right - m.width, window.innerWidth - m.width - margin))}px`;
		menuEl.style.top = `${Math.max(margin, top)}px`;
		return dismissOnOutside(menuEl, onClose, { anchor: () => anchor });
	});
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
	bind:this={menuEl}
	use:portal
	class="playbook-menu"
	role="menu"
	aria-label={label}
	data-playbook-menu={playbook.id}
	oncontextmenu={(e) => e.preventDefault()}
	onkeydown={(e) => {
		if (e.key === 'Escape' || e.key === 'Tab') {
			if (e.key === 'Escape') e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		roveFocus(e, () => Array.from(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []));
	}}
>
	{#if !isDefault}
		<button type="button" class="playbook-menu-item" role="menuitem" data-playbook-action="default" onclick={() => choose(onMakeDefault)}>
			<Icon name="star" />
			<span>{c.makeDefault}</span>
		</button>
	{/if}
	<button type="button" class="playbook-menu-item" role="menuitem" data-playbook-action="new" onclick={() => choose(onNew)}>
		<Icon name="plus" />
		<span>{c.newFrom}</span>
	</button>
	{#if !playbook.builtin}
		<button type="button" class="playbook-menu-item" role="menuitem" data-playbook-action="rename" onclick={() => choose(onRename)}>
			<Icon name="edit" />
			<span>{c.rename}</span>
		</button>
	{/if}
	<button type="button" class="playbook-menu-item" role="menuitem" data-playbook-action="history" onclick={() => choose(onHistory)}>
		<Icon name="history" />
		<span>{c.history}</span>
		{#if playbook.revision > 0}<span class="playbook-menu-note">{c.revision(playbook.revision)}</span>{/if}
	</button>
	{#if !playbook.builtin}
		<div class="playbook-menu-sep" role="separator"></div>
		<button
			type="button"
			class="playbook-menu-item is-danger"
			role="menuitem"
			data-playbook-action="remove"
			disabled={isDefault}
			title={isDefault ? c.removeIsDefault : undefined}
			onclick={() => choose(onRemove)}
		>
			<Icon name="trash" />
			<span>{c.remove}</span>
		</button>
	{/if}
</div>

<style>
	.playbook-menu {
		animation: menuIn var(--dur-base) var(--ease-out);
		position: fixed;
		z-index: 100;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 176px;
		padding: 5px;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-menu, var(--shadow-lg));
		user-select: none;
	}

	.playbook-menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 10px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font: 500 13px/1.3 var(--font);
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.playbook-menu-item :global(.icon) {
		flex-shrink: 0;
		opacity: 0.75;
	}

	.playbook-menu-item:hover:not(:disabled),
	.playbook-menu-item:focus-visible {
		background: var(--line-subtle);
		color: var(--accent);
		outline: none;
	}

	.playbook-menu-item:hover:not(:disabled) :global(.icon),
	.playbook-menu-item:focus-visible :global(.icon) {
		opacity: 1;
	}

	.playbook-menu-item.is-danger:hover:not(:disabled),
	.playbook-menu-item.is-danger:focus-visible {
		background: var(--danger-bg);
		color: var(--danger-text);
	}

	.playbook-menu-item:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.playbook-menu-note {
		margin-left: auto;
		padding-left: 12px;
		font-size: 12px;
		font-weight: 400;
		color: var(--muted);
	}

	.playbook-menu-sep {
		height: 1px;
		margin: 3px 8px;
		background: var(--line-subtle);
	}
</style>
