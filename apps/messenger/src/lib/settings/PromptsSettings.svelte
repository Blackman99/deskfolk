<script lang="ts">
	import { tick } from 'svelte';
	import type { Locale, PromptSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { backdropClick } from '../click-outside.ts';
	import PromptEditor from './PromptEditor.svelte';
	import { firstLocale, groupPrompts, overallState, stateChip } from './prompts-view.ts';

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
	let toolsOpen = $state(false);
	let open = $state<{ id: string; locale: Locale } | null>(null);
	let editor = $state<PromptEditor>();
	let returnFocus: HTMLElement | null = null;

	const groups = $derived(groupPrompts(items, query));
	const botNames = $derived(new Map(runtime.snapshot.bots.map((bot) => [bot.id, bot.name])));
	const openItem = $derived(open ? items.find((item) => item.id === open!.id) : undefined);

	async function openEditor(item: PromptSummary, event: MouseEvent): Promise<void> {
		returnFocus = event.currentTarget as HTMLElement;
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

	function failuresOf(item: PromptSummary): number {
		return item.locales.reduce((sum, state) => sum + (state.parse_failures ? (state.parse_failures.since_edit ?? state.parse_failures.last_7_days) : 0), 0);
	}

	function onEditorKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.stopPropagation();
		event.preventDefault();
		void closeEditor();
	}
</script>

<div class="prompts-settings">
	<section class="settings-card">
		<div>
			<h3 class="settings-card-title">{c.title}</h3>
			<p class="settings-card-subtitle">{c.subtitle}</p>
		</div>
		<input class="prompts-search" type="search" aria-label={c.search} placeholder={c.search} bind:value={query} />
		{#if loadFailed}
			<p class="field-error" role="alert">{c.loadFailed}</p>
		{/if}
		{#if items.length > 0 && groups.length === 0}
			<p class="muted" role="status">{c.noMatch}</p>
		{/if}
		{#each groups as row (row.group)}
			<div class="prompts-group" data-prompt-group={row.group}>
				{#if row.group === 'tool' && !query}
					<button type="button" class="prompts-group-toggle" aria-expanded={toolsOpen} onclick={() => (toolsOpen = !toolsOpen)}>
						<span class="prompts-group-title">{c.groups.tool}</span>
						<span class="muted">{c.toolsCount(row.items.length)}</span>
						<span class="prompts-caret" aria-hidden="true">{toolsOpen ? '▾' : '▸'}</span>
					</button>
				{:else}
					<h4 class="prompts-group-title">{c.groups[row.group]}</h4>
				{/if}
				{#if row.group !== 'tool' || toolsOpen || query}
					<ul class="prompts-list">
						{#each row.items as item (item.id)}
							{@const state = overallState(item)}
							{@const shown = item.locales.find((l) => l.state === state) ?? item.locales[0]!}
							{@const chip = stateChip(shown, shown.last_bot_id ? (botNames.get(shown.last_bot_id) ?? null) : null, c)}
							<li>
								<button type="button" class="prompts-row" data-prompt={item.id} onclick={(event) => void openEditor(item, event)}>
									<span class="prompts-row-main">
										<span class="prompts-row-title">{item.title[ui]}</span>
										<span class="prompts-row-summary">{item.summary[ui]}</span>
									</span>
									<span class="prompts-chips">
										<span class="prompts-chip is-{chip.tone}">{chip.label}</span>
										{#if failuresOf(item) > 0}
											<span class="prompts-chip is-warn">{c.parseFailures(failuresOf(item))}</span>
										{/if}
									</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/each}
	</section>
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
				<h2 id="prompt-editor-title">{openItem.title[ui]}</h2>
				<button type="button" class="modal-close" aria-label={t.common.close} onclick={() => void closeEditor()}>✕</button>
			</div>
			<div class="modal-body prompt-editor-body">
				{#key `${open.id}:${open.locale}`}
					<PromptEditor
						bind:this={editor}
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
	.prompts-settings {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.settings-card {
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		padding: 16px 18px;
		display: flex;
		flex-direction: column;
		gap: 14px;
		box-shadow: var(--shadow-xs);
		box-sizing: border-box;
	}

	.settings-card-title {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		line-height: 1.3;
	}

	.settings-card-subtitle {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--muted);
		line-height: 1.45;
	}

	.prompts-search {
		box-sizing: border-box;
		width: 100%;
		padding: 6px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--ink);
		font-size: 13px;
	}

	.prompts-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.prompts-group-title {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.prompts-group-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0;
		border: 0;
		background: none;
		cursor: pointer;
		font-size: 12px;
		text-align: left;
	}

	.prompts-caret {
		color: var(--muted);
	}

	.prompts-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.prompts-row {
		box-sizing: border-box;
		width: 100%;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--surface, var(--pane));
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.prompts-row:hover {
		border-color: var(--accent-border);
	}

	.prompts-row-main {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.prompts-row-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.prompts-row-summary {
		font-size: 12px;
		color: var(--muted);
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.prompts-chips {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
		flex: none;
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

	.prompt-editor-modal {
		width: min(760px, calc(100vw - 32px));
		max-height: calc(100vh - 48px);
		display: flex;
		flex-direction: column;
	}

	.prompt-editor-body {
		overflow: auto;
	}

	/* On a phone the editor is an inner page of settings, as the MCP editor is. */
	@media (max-width: 720px) {
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

		.prompt-editor-modal :global(.settings-subpage-head h2) {
			flex: 1;
			text-align: center;
			font-size: 16px;
			font-weight: 650;
		}

		.prompt-editor-modal :global(.modal-close) {
			display: none;
		}

		.settings-subpage-back {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 40px;
			height: 44px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			cursor: pointer;
		}
	}

	@media (max-width: 680px) {
		.settings-card {
			padding: 14px 12px;
			border-radius: var(--radius-md);
			gap: 12px;
		}

		.prompts-row {
			flex-direction: column;
		}

		.prompts-chips {
			flex-direction: row;
			flex-wrap: wrap;
			align-items: center;
		}
	}
</style>
