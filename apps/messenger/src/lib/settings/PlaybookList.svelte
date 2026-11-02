<script lang="ts">
	import { tick } from 'svelte';
	import type { Locale, Playbook, PlaybookImpact } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import DangerDialog from '../overlays/DangerDialog.svelte';
	import { formatListTime } from '../sidebar/list-time.ts';
	import PlaybookMenu from './PlaybookMenu.svelte';
	import { playbookName, type Playbooks } from './playbooks.svelte.ts';

	/**
	 * The engines down the left of Roles on a wide window (ADR 0085), kept as the conversations are
	 * kept down the left of the app: one row each — its name, the default starred, when it last
	 * changed, and what it is in a line — the one shown tinted. The + makes a new one
	 * from the one shown; a right-click on a row, or its ⋯, has the rest: make it the default, a new
	 * one from it, rename, its history, remove. Naming one turns its row into a name field of the
	 * same height, as renaming a project session does.
	 */
	interface Props {
		playbooks: Playbooks;
		shown: string;
		onshow: (id: string) => void;
		onmakedefault: (id: string) => void;
		/** Its history beside the map, in the picked step's place. */
		onhistory: (id: string) => void;
		locale: Locale;
		t: Copy;
	}

	let { playbooks, shown, onshow, onmakedefault, onhistory, locale, t }: Props = $props();
	const c = $derived(t.playbooks);
	const nameOf = (playbook: Playbook | undefined) => playbookName(playbook, c.builtin);

	/** The line under a name: what a built-in is for, or what one of yours was made from. */
	function lineOf(playbook: Playbook): string {
		if (playbook.builtin) return c.builtinHint[playbook.id] ?? '';
		return c.basedOn(nameOf(playbooks.find(playbook.base_id)) || (c.builtin[playbook.base_id] ?? playbook.base_id));
	}

	let menu = $state<{ id: string; anchor: HTMLElement; point: { x: number; y: number } | null } | null>(null);
	const menuFor = $derived(menu ? playbooks.find(menu.id) : undefined);

	function openMenu(id: string, anchor: HTMLElement, point: { x: number; y: number } | null): void {
		if (menu?.id === id && !point) {
			menu = null;
			return;
		}
		menu = { id, anchor, point };
	}

	// A name being typed: a new engine made from `from`, or one of yours renamed.
	let naming = $state<{ kind: 'new'; from: string } | { kind: 'rename'; id: string } | null>(null);
	let draft = $state('');
	let failed = $state(false);
	let field = $state<HTMLInputElement | null>(null);
	/** Enter and the blur that follows it are one save, not two; Escape's blur saves nothing. */
	let busy = false;
	let done = false;

	async function startNaming(next: NonNullable<typeof naming>): Promise<void> {
		naming = next;
		draft = next.kind === 'rename' ? (playbooks.find(next.id)?.name ?? '') : '';
		failed = false;
		done = false;
		await tick();
		field?.focus();
		field?.select();
	}

	function stopNaming(): void {
		done = true;
		naming = null;
	}

	async function commit(): Promise<void> {
		const now = naming;
		if (!now || busy || done) return;
		const next = draft.trim();
		// Blank, or the name it already has, leaves things as they were.
		if (!next || (now.kind === 'rename' && next === (playbooks.find(now.id)?.name ?? ''))) {
			stopNaming();
			return;
		}
		busy = true;
		const made = now.kind === 'new' ? await playbooks.create(now.from, next) : await playbooks.rename(now.id, next);
		busy = false;
		if (!made) {
			failed = true;
			field?.focus();
			return;
		}
		stopNaming();
		if (now.kind === 'new') onshow(made.id);
	}

	let removing = $state<Playbook | null>(null);

	async function remove(playbook: Playbook): Promise<void> {
		removing = null;
		await playbooks.remove(playbook.id);
		if (playbook.id === shown) onshow(playbooks.defaultId);
	}

	/** Making an engine with no jobs the default moves every conversation that follows it: said first (ADR 0103). */
	let moving = $state<{ id: string; impact: PlaybookImpact } | null>(null);

	async function makeDefault(id: string): Promise<void> {
		const impact = playbooks.find(id)?.resolved.jobs.on === false ? await playbooks.impactOf(id) : null;
		if (impact && impact.sessions > 0) moving = { id, impact };
		else onmakedefault(id);
	}

	const nowMs = $derived.by(() => {
		void playbooks.list;
		return Date.now();
	});
</script>

{#if moving}
	{@const target = moving}
	<DangerDialog
		copy={{ title: c.defaultTitle, body: c.defaultBody(target.impact.sessions, target.impact.open_jobs), confirm: c.makeDefault, cancel: c.cancel }}
		{t}
		onDismiss={() => (moving = null)}
		onConfirm={() => { const id = target.id; moving = null; onmakedefault(id); }}
	/>
{/if}

{#if removing}
	{@const target = removing}
	<DangerDialog
		copy={{ title: c.removeTitle(nameOf(target)), body: c.removeBody, confirm: c.remove, cancel: c.cancel }}
		{t}
		onDismiss={() => (removing = null)}
		onConfirm={() => void remove(target)}
	/>
{/if}

{#snippet nameField(line: string)}
	<div class="playbook-row is-naming" class:is-on={naming?.kind === 'rename' && naming.id === shown} data-playbook-naming={naming?.kind}>
		<input
			bind:this={field}
			class="playbook-name-field"
			type="text"
			value={draft}
			maxlength="40"
			placeholder={c.newName}
			aria-label={naming?.kind === 'new' ? c.newName : c.nameLabel}
			aria-invalid={failed}
			title={failed ? (playbooks.error === 'conflict' ? c.conflict : c.failed) : undefined}
			data-playbook-name
			oninput={(event) => {
				draft = event.currentTarget.value;
				failed = false;
			}}
			onkeydown={(event) => {
				// Enter that confirms an input method's candidate is the input method's.
				if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
					event.preventDefault();
					void commit();
				} else if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					stopNaming();
				}
			}}
			onblur={() => void commit()}
		/>
		<span class="playbook-row-line">{line}</span>
	</div>
{/snippet}

<div class="playbook-list" data-playbook-list>
	<div class="playbook-list-head">
		<span>{c.title}</span>
		<button
			type="button"
			class="playbook-list-add"
			title={c.newFromShown(nameOf(playbooks.find(shown)))}
			aria-label={c.newFromShown(nameOf(playbooks.find(shown)))}
			disabled={playbooks.saving}
			data-playbook-add
			onclick={() => void startNaming({ kind: 'new', from: shown })}
		>
			<Icon name="plus" size={16} />
		</button>
	</div>
	<div class="playbook-rows" role="tablist" aria-orientation="vertical" aria-label={c.title}>
		{#each playbooks.items as item (item.id)}
			{#if naming?.kind === 'rename' && naming.id === item.id}
				{@render nameField(lineOf(item))}
			{:else}
				{@const on = item.id === shown}
				{@const isDefault = item.id === playbooks.defaultId}
				<div class="playbook-row-shell" class:is-menu-open={menu?.id === item.id}>
					<button
						type="button"
						role="tab"
						class="playbook-row"
						class:is-on={on}
						aria-selected={on}
						title={lineOf(item)}
						data-playbook-row={item.id}
						onclick={() => onshow(item.id)}
						oncontextmenu={(event) => {
							event.preventDefault();
							// The keyboard's menu key has no pointer: the menu hangs under the row instead.
							const point = event.clientX === 0 && event.clientY === 0 ? null : { x: event.clientX, y: event.clientY };
							openMenu(item.id, event.currentTarget, point);
						}}
					>
						<span class="playbook-row-name">
							{#if isDefault}<span class="playbook-row-star" aria-label={c.isDefault} title={c.isDefault}>★</span>{/if}
							<span class="playbook-row-text">{nameOf(item)}</span>
						</span>
						<span class="playbook-row-time">{formatListTime(item.updated_at, nowMs, locale)}</span>
						<span class="playbook-row-line">{lineOf(item)}</span>
					</button>
					<button
						type="button"
						class="playbook-row-more"
						title={t.chat.moreActions}
						aria-label={t.chat.moreActions}
						aria-haspopup="menu"
						aria-expanded={menu?.id === item.id}
						data-playbook-more={item.id}
						onclick={(event) => openMenu(item.id, event.currentTarget, null)}
					>
						<Icon name="more" />
					</button>
				</div>
			{/if}
		{/each}
		{#if naming?.kind === 'new'}
			{@render nameField(c.basedOn(nameOf(playbooks.find(naming.from))))}
		{/if}
	</div>
</div>

{#if menu && menuFor}
	{@const item = menuFor}
	<PlaybookMenu
		playbook={item}
		isDefault={item.id === playbooks.defaultId}
		anchor={menu.anchor}
		point={menu.point}
		label={nameOf(item)}
		{t}
		onClose={() => (menu = null)}
		onMakeDefault={(id) => void makeDefault(id)}
		onNew={(id) => void startNaming({ kind: 'new', from: id })}
		onRename={(id) => void startNaming({ kind: 'rename', id })}
		onHistory={onhistory}
		onRemove={(id) => (removing = playbooks.find(id) ?? null)}
	/>
{/if}

<style>
	.playbook-list {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.playbook-list-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 10px 4px;
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--muted);
	}

	.playbook-list-add {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.playbook-list-add:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--accent);
	}

	.playbook-list-add:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.playbook-list-add:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	.playbook-rows {
		display: flex;
		flex-direction: column;
	}

	.playbook-row-shell {
		position: relative;
	}

	/* A conversation's row, without the avatar: name and time, then a line. */
	.playbook-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: auto auto;
		gap: 2px 10px;
		width: 100%;
		box-sizing: border-box;
		padding: 8px 10px;
		margin: 1px 0;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
		transition-property: var(--transition-props);
	}

	.playbook-row:hover {
		background: var(--row-hover);
	}

	.playbook-row:active:not(.is-naming) {
		transform: scale(0.985);
		transition-duration: var(--dur-fast);
	}

	.playbook-row:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	/*
	 * The engine shown is marked as the open conversation is on a phone, and as the picked file is in
	 * the workspace's tree: the list stays inside the tab's card, where a lift would not read.
	 */
	.playbook-row.is-on,
	.playbook-row.is-on:hover {
		background: var(--accent-tint);
	}

	.playbook-row.is-naming {
		cursor: default;
	}

	.playbook-row-name {
		display: flex;
		align-items: baseline;
		gap: 4px;
		min-width: 0;
		font-size: 14px;
		font-weight: 600;
		line-height: 1.5;
		color: var(--ink);
	}

	.playbook-row-text {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.playbook-row-star {
		flex: none;
		font-size: 11px;
		color: var(--brand, var(--accent));
	}

	.playbook-row-time {
		align-self: center;
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
		transition: opacity var(--dur-base) var(--ease-out);
	}

	.playbook-row-line {
		grid-column: 1 / -1;
		min-width: 0;
		min-height: 1.4em;
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.playbook-name-field {
		grid-column: 1 / -1;
		min-width: 0;
		/* The name's line: 14px at 1.5. */
		height: 21px;
		padding: 0 6px;
		margin-left: -7px;
		border: 1px solid var(--field-focus-border);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		outline: none;
		box-shadow: var(--field-focus-ring);
	}

	.playbook-name-field[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.playbook-row-more {
		position: absolute;
		top: 9px;
		right: 8px;
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border: 0;
		border-radius: 7px;
		background: var(--pane);
		color: var(--muted);
		box-shadow: inset 0 0 0 1px var(--line), var(--shadow-md);
		cursor: pointer;
		opacity: 0;
		pointer-events: none;
		transition-duration: var(--dur-base);
		transition-timing-function: var(--ease-out);
		transition-property: opacity, transform;
	}

	.playbook-row-more:hover {
		color: var(--ink);
	}

	.playbook-row-more:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	/* Under a pointer the ⋯ shows on hover, as a conversation's does; by touch it is always there. */
	@media (hover: hover) {
		.playbook-row-shell:hover .playbook-row-more,
		.playbook-row-shell:focus-within .playbook-row-more,
		.playbook-row-shell.is-menu-open .playbook-row-more {
			opacity: 1;
			pointer-events: auto;
		}

		.playbook-row-shell:hover .playbook-row-time,
		.playbook-row-shell:focus-within .playbook-row-time,
		.playbook-row-shell.is-menu-open .playbook-row-time {
			opacity: 0;
		}
	}

	@media (hover: none) {
		.playbook-row-more {
			opacity: 1;
			pointer-events: auto;
			box-shadow: none;
			background: transparent;
		}

		.playbook-row-time {
			display: none;
		}
	}
</style>
