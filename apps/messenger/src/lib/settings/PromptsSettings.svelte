<script lang="ts">
	import { tick } from 'svelte';
	import type { Locale, PromptSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { backdropClick } from '../click-outside.ts';
	import PromptEditor from './PromptEditor.svelte';
	import { editedCount, failuresOf, firstLocale, groupPrompts, overallState, stateChip, type PromptView } from './prompts-view.ts';

	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		/** Every built-in prompt and its state; the settings modal loads them, so its tab can count them too. */
		items: readonly PromptSummary[];
		loadFailed?: boolean;
		closeSettings?: () => void;
	}

	let { runtime, t, items, loadFailed = false, closeSettings }: Props = $props();
	const c = $derived(t.prompts);
	const ui = $derived<Locale>(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const editorBackdrop = backdropClick();

	let query = $state('');
	let onlyEdited = $state(false);
	let toolsOpen = $state(false);
	let open = $state<{ id: string; locale: Locale } | null>(null);
	let editorView = $state<PromptView>('text');
	let editor = $state<PromptEditor>();
	let returnFocus: HTMLElement | null = null;

	const counts = $derived(editedCount(items));
	// The filter is there only while something is edited, so restoring the last one shows them all again.
	const editedOnly = $derived(onlyEdited && counts.edited > 0);
	const groups = $derived(groupPrompts(items, query, editedOnly));
	// A search or the filter shows every tool it keeps; otherwise the fifty stay folded.
	const narrowed = $derived(query.trim() !== '' || editedOnly);
	const botNames = $derived(new Map(runtime.snapshot.bots.map((bot) => [bot.id, bot.name])));
	const openItem = $derived(open ? items.find((item) => item.id === open!.id) : undefined);

	/** A prompt's mark in the list: who edited it, or the conflict; a default carries none. */
	function chipOf(item: PromptSummary): ReturnType<typeof stateChip> {
		const state = overallState(item);
		const shown = item.locales.find((locale) => locale.state === state) ?? item.locales[0]!;
		return stateChip(shown, shown.last_bot_id ? (botNames.get(shown.last_bot_id) ?? null) : null, c);
	}

	async function openEditor(item: PromptSummary, event: MouseEvent): Promise<void> {
		returnFocus = event.currentTarget as HTMLElement;
		editorView = 'text';
		open = { id: item.id, locale: firstLocale(item, ui) };
		await tick();
		document.querySelector<HTMLTextAreaElement>('.prompt-editor-modal .prompt-text')?.focus();
	}

	/** Back on a phone, or ✕: what you typed is saved first. */
	export function backFromEditor(): boolean {
		if (!open) return false;
		void closeEditor();
		return true;
	}

	async function closeEditor(): Promise<void> {
		await editor?.flush();
		open = null;
		if (returnFocus?.isConnected) returnFocus.focus();
	}

	function openMessage(sessionId: string, messageId: string): void {
		void editor?.flush();
		open = null;
		closeSettings?.();
		void runtime.selectSession(sessionId, { messageId });
	}

	function onEditorKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.stopPropagation();
		event.preventDefault();
		void closeEditor();
	}
</script>

<div class="prompts-settings">
	<div class="prompts-top">
		<p class="prompts-intro">{c.intro}</p>
		<div class="prompts-toolbar">
			<input class="prompts-search" type="search" aria-label={c.search} placeholder={c.search} bind:value={query} />
			{#if counts.edited > 0}
				<div class="prompts-filter" role="group" aria-label={c.filter.edited}>
					<button type="button" class="prompts-filter-btn" class:is-active={!editedOnly} aria-pressed={!editedOnly} onclick={() => (onlyEdited = false)}>{c.filter.all}</button>
					<button type="button" class="prompts-filter-btn" class:is-active={editedOnly} aria-pressed={editedOnly} data-prompts-filter="edited" onclick={() => (onlyEdited = true)}>
						{c.filter.edited}
						<span class="prompts-filter-count" class:is-warn={counts.conflict}>{counts.edited}</span>
					</button>
				</div>
			{/if}
		</div>
		{#if loadFailed}
			<p class="field-error" role="alert">{c.loadFailed}</p>
		{/if}
	</div>

	<div class="prompts-scroll" role="region" aria-label={t.settings.tabPrompts}>
		{#if items.length > 0 && groups.length === 0}
			<p class="muted prompts-empty" role="status">{c.noMatch}</p>
		{/if}
		{#each groups as row (row.group)}
			<section class="prompts-group" data-prompt-group={row.group}>
				{#if row.group === 'tool'}
					{@const toolsShown = toolsOpen || narrowed}
					{@const toolsEdited = row.items.filter((item) => overallState(item) !== 'default').length}
					{#if narrowed}
						<div class="prompts-group-head">
							<h4 class="prompts-group-title">{c.groups.tool}</h4>
							<span class="prompts-group-count">{row.items.length}</span>
						</div>
					{:else}
						<button type="button" class="prompts-group-head prompts-group-toggle" aria-expanded={toolsOpen} onclick={() => (toolsOpen = !toolsOpen)}>
							<span class="prompts-group-title">{c.groups.tool}</span>
							<span class="prompts-group-count">{row.items.length}</span>
							{#if toolsEdited > 0}
								<span class="prompts-chip is-edited">{c.filter.edited} {toolsEdited}</span>
							{/if}
							<svg class="prompts-caret" class:is-open={toolsOpen} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
						</button>
					{/if}
					{#if toolsShown}
						<p class="prompts-group-note">{c.toolsNote}</p>
						<ul class="prompts-tools">
							{#each row.items as item (item.id)}
								{@const chip = chipOf(item)}
								<li>
									<button
										type="button"
										class="prompts-tool"
										data-prompt={item.id}
										title={chip.tone === 'default' ? undefined : chip.label}
										onclick={(event) => void openEditor(item, event)}
									>
										<span class="prompts-tool-name">{item.title[ui]}</span>
										{#if chip.tone !== 'default'}
											<span class="prompts-dot is-{chip.tone}" aria-hidden="true"></span>
											<span class="sr-only">{chip.label}</span>
										{/if}
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				{:else}
					<div class="prompts-group-head">
						<h4 class="prompts-group-title">{c.groups[row.group]}</h4>
						<span class="prompts-group-count">{row.items.length}</span>
					</div>
					<ul class="prompts-list">
						{#each row.items as item (item.id)}
							{@const chip = chipOf(item)}
							{@const failures = failuresOf(item)}
							<li>
								<button type="button" class="prompts-row" data-prompt={item.id} onclick={(event) => void openEditor(item, event)}>
									<span class="prompts-row-title">{item.title[ui]}</span>
									<span class="prompts-row-summary" title={item.summary[ui]}>{item.summary[ui]}</span>
									<span class="prompts-row-end">
										{#if chip.tone !== 'default'}
											<span class="prompts-chip is-{chip.tone}">{chip.label}</span>
										{/if}
										{#if failures > 0}
											<span class="prompts-chip is-warn">{c.parseFailures(failures)}</span>
										{/if}
										<svg class="prompts-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
									</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/each}
	</div>
</div>

{#if open && openItem}
	<div
		class="modal-backdrop prompt-editor-backdrop z-[110]"
		role="dialog"
		aria-modal="true"
		aria-labelledby="prompt-editor-title"
		tabindex="-1"
		onmousedowncapture={editorBackdrop.press}
		onclick={(event) => {
			if (editorBackdrop.isOutside(event)) void closeEditor();
		}}
		onkeydown={onEditorKeydown}
	>
		<div class="modal-dialog prompt-editor-modal settings-subpage">
			<div class="modal-head settings-subpage-head">
				<button type="button" class="settings-subpage-back" aria-label={c.back} onclick={() => void closeEditor()}>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
				</button>
				<div class="prompt-editor-heading">
					<h2 id="prompt-editor-title">{openItem.title[ui]}</h2>
					<code class="prompt-editor-id">{openItem.id}</code>
				</div>
				<button type="button" class="modal-close" aria-label={t.common.close} onclick={() => void closeEditor()}>✕</button>
			</div>
			<div class="modal-body prompt-editor-body">
				{#key `${open.id}:${open.locale}`}
					<PromptEditor
						bind:this={editor}
						bind:view={editorView}
						{runtime}
						{t}
						id={open.id}
						locale={open.locale}
						onLocale={(locale) => (open = { id: open!.id, locale })}
						onOpenMessage={openMessage}
					/>
				{/key}
			</div>
		</div>
	</div>
{/if}

<style>
	/* The list scrolls under a fixed search row, as the MCP list does (the modal body stops scrolling). */
	:global(.modal-body) > .prompts-settings {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.prompts-top {
		display: flex;
		flex-direction: column;
		gap: 10px;
		flex: none;
	}

	.prompts-intro {
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--muted);
	}

	.prompts-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.prompts-settings .prompts-search {
		flex: 1;
		min-width: 0;
		width: auto;
		padding: 7px 12px;
		font-size: 13px;
	}

	.prompts-filter {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 3px;
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-md);
		background: var(--chip);
	}

	.prompts-filter-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 4px 10px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition-property: background-color, color, box-shadow;
	}

	.prompts-filter-btn:hover:not(.is-active) {
		color: var(--ink);
	}

	.prompts-filter-btn.is-active {
		background: var(--pane);
		color: var(--accent);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}

	.prompts-filter-count {
		min-width: 16px;
		padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		color: var(--accent);
		font-size: 11px;
		font-weight: 600;
		line-height: 16px;
		text-align: center;
		box-sizing: border-box;
	}

	.prompts-filter-count.is-warn {
		background: var(--warn-bg);
		color: var(--warn-text);
	}

	.prompts-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding: 2px 2px 8px;
	}

	.prompts-empty {
		margin: 8px 2px;
		font-size: 13px;
	}

	.prompts-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex: none;
	}

	.prompts-group-head {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 22px;
		padding: 0 4px;
	}

	.prompts-group-title {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.prompts-group-count {
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		color: var(--muted);
	}

	.prompts-group-toggle {
		align-self: flex-start;
		margin: 0 -4px;
		padding: 2px 8px;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		text-align: left;
		cursor: pointer;
		transition-property: background-color, color;
	}

	.prompts-group-toggle:hover {
		background: var(--row-hover);
	}

	.prompts-caret {
		color: var(--muted);
		transition: transform 0.15s ease;
	}

	.prompts-caret.is-open {
		transform: rotate(90deg);
	}

	.prompts-group-note {
		margin: 0;
		padding: 0 4px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	/* One card per group, a hairline between its rows, one line a row: title, then what it is. */
	.prompts-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: fit-content(42%) minmax(0, 1fr) auto;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		overflow: hidden;
	}

	.prompts-list > li {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: subgrid;
	}

	.prompts-list > li + li {
		border-top: 1px solid var(--line-subtle);
	}

	.prompts-row {
		grid-column: 1 / -1;
		display: grid;
		grid-template-columns: subgrid;
		align-items: center;
		column-gap: 14px;
		min-width: 0;
		padding: 9px 10px 9px 12px;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
		transition-property: background-color;
	}

	.prompts-row:hover {
		background: var(--row-hover);
	}

	.prompts-row:focus-visible,
	.prompts-tool:focus-visible,
	.prompts-group-toggle:focus-visible,
	.prompts-filter-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.prompts-row-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.prompts-row-summary {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		color: var(--muted);
	}

	.prompts-row-end {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
	}

	.prompts-chevron {
		flex: none;
		color: var(--muted);
		opacity: 0.6;
	}

	.prompts-row:hover .prompts-chevron {
		opacity: 1;
	}

	.prompts-chip {
		padding: 1px 7px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		white-space: nowrap;
	}

	.prompts-chip.is-edited {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.prompts-chip.is-conflict,
	.prompts-chip.is-warn {
		border-color: var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
	}

	/* Tool descriptions: fifty names that all mean "what this tool is for", so names only, in a grid. */
	.prompts-tools {
		list-style: none;
		margin: 0;
		padding: 6px;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
		gap: 2px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
	}

	.prompts-tool {
		box-sizing: border-box;
		width: 100%;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 8px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink-secondary);
		text-align: left;
		cursor: pointer;
		transition-property: background-color, color;
	}

	.prompts-tool:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	.prompts-tool-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 12px/1.5 var(--mono);
	}

	.prompts-dot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: var(--radius-full);
		background: var(--accent);
	}

	.prompts-dot.is-conflict {
		background: var(--warn-text);
	}

	/* The editor: a page over settings, tall enough that a long prompt reads as a document. */
	.modal-dialog.prompt-editor-modal {
		width: min(860px, calc(100vw - 48px));
		height: min(820px, calc(100vh - 48px));
		display: flex;
		flex-direction: column;
	}

	.prompt-editor-modal > :global(.modal-head) {
		gap: 12px;
	}

	/* ✕ on a wide window, Back on a phone — as the MCP editor has it. */
	.settings-subpage-back {
		display: none;
	}

	.prompt-editor-heading {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 10px;
	}

	.prompt-editor-heading h2 {
		margin: 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 16px;
		font-weight: 650;
		color: var(--ink);
	}

	.prompt-editor-id {
		flex: none;
		padding: 0 6px;
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--muted);
		font: 11px/1.6 var(--mono);
	}

	.modal-body.prompt-editor-body {
		padding: 0;
		gap: 0;
		overflow: hidden;
	}

	@media (max-width: 720px) {
		.prompts-scroll {
			gap: 16px;
		}

		/* A row is the title over one line of what it is; marks stay on the right. */
		.prompts-list {
			display: flex;
			flex-direction: column;
		}

		.prompts-list > li {
			display: block;
		}

		.prompts-row {
			width: 100%;
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-areas: 'title end' 'summary end';
			row-gap: 2px;
			column-gap: 10px;
			padding: 10px 10px 10px 12px;
		}

		.prompts-row-title {
			grid-area: title;
		}

		.prompts-row-summary {
			grid-area: summary;
		}

		.prompts-row-end {
			grid-area: end;
		}

		.prompts-tools {
			grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
		}

		/* On a phone the editor is an inner page of settings, as the MCP editor is. */
		.prompt-editor-backdrop {
			padding: 0;
			align-items: stretch;
			background: var(--sidebar-bg);
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
		}

		.modal-dialog.prompt-editor-modal {
			width: 100%;
			max-width: none;
			height: 100%;
			max-height: none;
			border: 0;
			border-radius: 0;
			box-shadow: none;
			background: var(--sidebar-bg);
		}

		.prompt-editor-modal > :global(.settings-subpage-head) {
			height: calc(56px + env(safe-area-inset-top));
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 8px 0;
			gap: 4px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
		}

		.prompt-editor-heading {
			justify-content: center;
			padding-right: 40px;
		}

		.prompt-editor-id {
			display: none;
		}

		.prompt-editor-modal :global(.modal-close) {
			display: none;
		}

		.settings-subpage-back {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			flex: none;
			width: 40px;
			height: 44px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			cursor: pointer;
		}

		.settings-subpage-back:active {
			background: var(--row-hover);
		}
	}
</style>
