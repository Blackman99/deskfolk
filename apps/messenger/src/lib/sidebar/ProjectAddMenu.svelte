<script lang="ts">
	import type { ProjectAgent } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import type { Copy } from '../copy.ts';
	import { PROJECT_AGENTS } from './project-groups.ts';
	import { dismissOnOutside } from '../dismissable-menu.ts';
	import { roveFocus } from '../menu-roving.ts';

	/**
	 * What a + in the 「项目」 section offers (ADR 0095): a new session of each agent (ADR 0099),
	 * in a folder you pick next on the section's +, right in the directory on a directory's; and on
	 * the section's, a terminal session to carry on. It hangs under the +, walks with the arrow
	 * keys, closes on Escape, Tab or a press elsewhere, and hands focus back to the +.
	 */
	type Props = {
		t: Copy;
		/** The + it hangs from. */
		anchor: HTMLElement | null;
		open: boolean;
		/** What it is for, read out: the section's + or a directory's. */
		label: string;
		/** A folder is picked after: each "new" says so with an ellipsis. */
		picksFolder: boolean;
		onNew: (agent: ProjectAgent) => void;
		/** Carrying on a terminal session; a directory's + leaves it out. */
		onImport?: () => void;
	};

	let { t, anchor, open = $bindable(false), label, picksFolder, onNew, onImport }: Props = $props();
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
		aria-label={label}
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
		{#each PROJECT_AGENTS as agent (agent)}
			<button type="button" class="project-add-item" role="menuitem" data-project-add="new" data-project-agent={agent} onclick={() => choose(() => onNew(agent))}>
				<AgentLogo runner={agent} size={18} />
				<span>{t.project.newWith(t.project.agentNames[agent])}{picksFolder ? '…' : ''}</span>
			</button>
		{/each}
		{#if onImport}
			<div class="project-add-sep" role="separator"></div>
			<button type="button" class="project-add-item" role="menuitem" data-project-add="import" onclick={() => choose(onImport)}>
				<Icon name="file-down" />
				<span>{t.project.importSession}</span>
			</button>
		{/if}
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

	.project-add-sep {
		height: 1px;
		margin: 4px 6px;
		background: var(--line);
	}
</style>
