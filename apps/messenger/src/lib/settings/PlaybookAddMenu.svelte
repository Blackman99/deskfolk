<script lang="ts">
	import { MediaQuery } from 'svelte/reactivity';
	import type { CustomStep, PlaybookHook } from '@real-bot/protocol';
	import BottomSheet from '../BottomSheet.svelte';
	import { PHONE_SHEET_QUERY } from '../bottom-sheet.ts';
	import type { Copy } from '../copy.ts';
	import { dismissOnOutside } from '../dismissable-menu.ts';
	import Icon from '../Icon.svelte';
	import { roveFocus } from '../menu-roving.ts';
	import { blankStep, templateStep, templatesFor, type CustomStepTemplateId } from './custom-step-templates.ts';
	import { CUSTOM_STEPS_MAX } from '@real-bot/protocol';

	/**
	 * What the map's 「加一个环节」 card offers (ADR 0105): the starter templates that fit its round and
	 * a blank step. Choosing one hands back a draft — nothing is saved until the panel's Save. A
	 * dropdown under the card; on a phone, a sheet from the bottom. Past the limit it only says so.
	 */
	interface Props {
		hook: PlaybookHook;
		anchor: HTMLElement;
		/** The engine already holds as many steps of your own as it may. */
		full: boolean;
		t: Copy;
		onClose: () => void;
		onchoose: (step: CustomStep) => void;
	}

	let { hook, anchor, full, t, onClose, onchoose }: Props = $props();
	const c = $derived(t.playbooks.own);
	const phone = new MediaQuery(PHONE_SHEET_QUERY);
	let menuEl = $state<HTMLElement | null>(null);

	function choose(step: CustomStep): void {
		onClose();
		onchoose(step);
	}

	function chooseTemplate(id: CustomStepTemplateId): void {
		choose(templateStep(id, c.templates[id]!.name, c.rulesPrompt));
	}

	function close(): void {
		onClose();
		anchor.focus();
	}

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy: () => node.remove() };
	}

	$effect(() => {
		if (phone.current || !menuEl) return;
		const m = menuEl.getBoundingClientRect();
		const margin = 8;
		const a = anchor.getBoundingClientRect();
		const below = a.bottom + 4;
		const top = below + m.height <= window.innerHeight - margin ? below : a.top - m.height - 4;
		menuEl.style.left = `${Math.max(margin, Math.min(a.left, window.innerWidth - m.width - margin))}px`;
		menuEl.style.top = `${Math.max(margin, top)}px`;
		return dismissOnOutside(menuEl, onClose, { anchor: () => anchor });
	});
</script>

{#snippet rows()}
	{#if full}
		<p class="add-full" data-playbook-add-full>{c.full(CUSTOM_STEPS_MAX)}</p>
	{:else}
		<p class="add-title">{c.templatesTitle}</p>
		{#each templatesFor(hook) as id (id)}
			<button type="button" class="add-item" role="menuitem" data-playbook-template={id} onclick={() => chooseTemplate(id)}>
				<span class="add-item-name">{c.templates[id]!.name}</span>
				<span class="add-item-hint">{c.templates[id]!.hint}</span>
			</button>
		{/each}
		<div class="add-sep" role="separator"></div>
		<button type="button" class="add-item" role="menuitem" data-playbook-template="blank" onclick={() => choose(blankStep(hook, c.blankName))}>
			<span class="add-item-name"><Icon name="plus" size={12} /> {c.blank}</span>
		</button>
	{/if}
{/snippet}

{#if phone.current}
	<BottomSheet title={c.addMenu} closeLabel={t.common.close} {onClose}>
		{@render rows()}
	</BottomSheet>
{:else}
	<!-- svelte-ignore a11y_interactive_supports_focus -->
	<div
		bind:this={menuEl}
		use:portal
		class="add-menu"
		role="menu"
		aria-label={c.addMenu}
		data-playbook-add-menu={hook}
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
		{@render rows()}
	</div>
{/if}

<style>
	.add-menu {
		animation: menuIn var(--dur-base) var(--ease-out);
		position: fixed;
		z-index: 100;
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 280px;
		max-width: calc(100vw - 16px);
		padding: 5px;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-menu, var(--shadow-lg));
		-webkit-user-select: none;
		user-select: none;
	}

	.add-title,
	.add-full {
		margin: 0;
		padding: 4px 10px;
		font-size: 11px;
		line-height: 1.45;
		color: var(--muted);
	}

	.add-item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		width: 100%;
		padding: 6px 10px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font: 500 13px/1.3 var(--font);
		text-align: left;
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.add-item:hover,
	.add-item:focus-visible {
		background: var(--line-subtle);
		color: var(--accent);
		outline: none;
	}

	.add-item-name {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.add-item-hint {
		font-size: 11px;
		font-weight: 400;
		line-height: 1.4;
		color: var(--muted);
	}

	@media (max-width: 720px) {
		.add-item {
			min-height: 48px;
			padding: 10px 12px;
			font-size: 15px;
		}
	}

	.add-sep {
		height: 1px;
		margin: 3px 8px;
		background: var(--line-subtle);
	}
</style>
