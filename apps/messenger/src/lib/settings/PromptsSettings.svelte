<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { Locale, PromptGroup, PromptSummary } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import PromptEditorPage from './PromptEditorPage.svelte';
	import PromptRowList from './PromptRowList.svelte';
	import SettingsSectionList from './SettingsSectionList.svelte';
	import SettingsSectionTabs from './SettingsSectionTabs.svelte';
	import { editedCount, firstLocale, groupPrompts, promptChip, type PromptView } from './prompts-view.ts';

	/**
	 * Settings › Prompts, by group as Models is by section: a wide window shows the groups as tabs
	 * under the search, a phone lists them and opens one as a page of its own. A search or the
	 * edited filter looks through every group, so while one is on, what it keeps shows by group in
	 * one list instead.
	 */
	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		/** Every built-in prompt and its state; the settings modal loads them, so its tab can count them too. */
		items: readonly PromptSummary[];
		loadFailed?: boolean;
		closeSettings?: () => void;
		/** What the dialog says over any page: pending credentials, a failed save, setup not done. */
		notices?: Snippet;
	}

	let { runtime, t, items, loadFailed = false, closeSettings, notices }: Props = $props();
	const c = $derived(t.prompts);
	const ui = $derived<Locale>(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh');

	const phone = new MediaQuery('(max-width: 720px)');
	let query = $state('');
	let onlyEdited = $state(false);
	let open = $state<{ id: string; locale: Locale } | null>(null);
	let editorView = $state<PromptView>('text');
	/** A change to open in the history the first time the editor shows it (a card's 「在设置里看」). */
	let editorReveal = $state<string | null>(null);
	/** Opened from a card: focus goes into the editor once it shows. */
	let focusEditor = false;
	let editorPage = $state<PromptEditorPage>();
	let returnFocus: HTMLElement | null = null;

	const counts = $derived(editedCount(items));
	// The filter is there only while something is edited, so restoring the last one shows them all again.
	const editedOnly = $derived(onlyEdited && counts.edited > 0);
	const groups = $derived(groupPrompts(items, query, editedOnly));
	const narrowed = $derived(query.trim() !== '' || editedOnly);
	/** Every prompt by group, whatever the search: the tabs, and the phone's list of groups. */
	const byGroup = $derived(groupPrompts(items, ''));
	const sections = $derived(byGroup.map((row) => row.group));
	let picked = $state<PromptGroup>('turn');
	const section = $derived(sections.includes(picked) ? picked : (sections[0] ?? 'turn'));
	/** On a phone, a group's page is open over the list of them. */
	let opened = $state(false);
	let scroller = $state<HTMLElement>();
	const sectioned = $derived(sections.length > 1 && !narrowed);
	const listing = $derived(phone.current && sectioned && !opened);
	const inGroup = $derived(phone.current && sectioned && opened);
	const botNames = $derived(new Map(runtime.snapshot.bots.map((bot) => [bot.id, bot.name])));
	const openItem = $derived(open ? items.find((item) => item.id === open!.id) : undefined);

	const itemsOf = (group: PromptGroup) => byGroup.find((row) => row.group === group)?.items ?? [];
	/** A tab counts what you edited in its group, as Prompts in the settings list does over all of them. */
	const editedIn = (group: PromptGroup) => editedCount(itemsOf(group)).edited;
	const conflictIn = (group: PromptGroup) => editedCount(itemsOf(group)).conflict;

	/** A group's line on the phone's list: how many prompts, and how many of them are edited. */
	function summary(group: PromptGroup): string {
		const list = itemsOf(group);
		const counted = editedCount(list);
		return c.groupSummary(list.length, counted.edited, counted.conflict);
	}

	function openSection(next: PromptGroup): void {
		picked = next;
		opened = true;
		if (scroller) scroller.scrollTop = 0;
	}

	/** The open group's name for the page head on a phone; null on the list, and on a wide window. */
	export function sectionTitle(): string | null {
		return inGroup ? c.groups[section] : null;
	}

	/** Back on a phone from a group's page goes to the list of groups. */
	export function backFromSection(): boolean {
		if (!inGroup) return false;
		opened = false;
		return true;
	}

	const chipOf = (item: PromptSummary) => promptChip(item, botNames, c);

	// Sent here from a card's 「在设置里看」: that prompt's history, at the change the card let through.
	$effect(() => {
		const target = runtime.promptsTarget?.prompt;
		if (!target) return;
		returnFocus = null;
		editorView = 'history';
		editorReveal = target.revisionId;
		open = { id: target.id, locale: target.locale };
		focusEditor = true;
		runtime.promptsTarget = null;
	});

	// Focus was on the card under settings: once the editor is up (the list may still be loading),
	// it moves there, so Escape and Tab work in the editor rather than behind it.
	$effect(() => {
		if (!focusEditor || !open || !openItem) return;
		focusEditor = false;
		// Under the editor, its group: where closing it, or Back on a phone, lands.
		picked = openItem.group;
		opened = true;
		void tick().then(() => document.querySelector<HTMLElement>('.prompt-editor-backdrop')?.focus());
	});

	async function openEditor(item: PromptSummary, event: MouseEvent): Promise<void> {
		returnFocus = event.currentTarget as HTMLElement;
		// Opened from a search, its group is the tab showing once the search is cleared.
		picked = item.group;
		editorView = 'text';
		editorReveal = null;
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
		await editorPage?.flush();
		open = null;
		if (returnFocus?.isConnected) returnFocus.focus();
	}

	function openMessage(sessionId: string, messageId: string): void {
		void editorPage?.flush();
		open = null;
		closeSettings?.();
		void runtime.selectSession(sessionId, { messageId });
	}
</script>

{#snippet icon(of: PromptGroup, size: number)}
	<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
		{#if of === 'turn'}
			<polyline points="17 1 21 5 17 9"></polyline>
			<path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
			<polyline points="7 23 3 19 7 15"></polyline>
			<path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
		{:else if of === 'agent'}
			<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
			<polyline points="7 9 10 12 7 15"></polyline>
			<line x1="12" y1="15" x2="17" y2="15"></line>
		{:else if of === 'call'}
			<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
		{:else}
			<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
		{/if}
	</svg>
{/snippet}

<!-- A group's prompts: one line each, or for the tool descriptions, their names in a grid. -->
{#snippet groupBody(group: PromptGroup, list: PromptSummary[])}
	{#if group === 'tool'}
		<p class="prompts-group-note">{c.toolsNote}</p>
		<ul class="prompts-tools">
			{#each list as item (item.id)}
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
	{:else}
		<PromptRowList items={list} {ui} {botNames} {t} onopen={(item, event) => void openEditor(item, event)} />
	{/if}
{/snippet}

<div class="prompts-settings">
	<!-- The search sits over the groups, not in one: it looks through all of them. On a phone it is on the list of groups. -->
	{#if !inGroup}
		<div class="prompts-top">
			{@render notices?.()}
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
	{/if}

	{#if !phone.current && sectioned}
		<SettingsSectionTabs
			id="prompts"
			{sections}
			active={section}
			label={(of) => c.groups[of]}
			count={editedIn}
			warn={conflictIn}
			{icon}
			ariaLabel={t.settings.tabPrompts}
			onpick={openSection}
		/>
	{/if}

	<div class="prompts-scroll" role="region" aria-label={t.settings.tabPrompts} bind:this={scroller}>
		{#if inGroup}
			{@render notices?.()}
		{/if}
		{#if listing}
			<SettingsSectionList {sections} label={(of) => c.groups[of]} {summary} {icon} ariaLabel={t.settings.tabPrompts} onpick={openSection} />
		{:else if sectioned}
			<div
				class="prompts-panel"
				class:is-subpage={phone.current}
				id="prompts-panel"
				role={phone.current ? undefined : 'tabpanel'}
				aria-labelledby={phone.current ? undefined : `prompts-tab-${section}`}
				data-prompt-group={section}
			>
				{@render groupBody(section, itemsOf(section))}
			</div>
		{:else}
			{#if items.length > 0 && groups.length === 0}
				<p class="muted prompts-empty" role="status">{c.noMatch}</p>
			{/if}
			{#each groups as row (row.group)}
				<section class="prompts-group" data-prompt-group={row.group}>
					<div class="prompts-group-head">
						<h4 class="prompts-group-title">{c.groups[row.group]}</h4>
						<span class="prompts-group-count">{row.items.length}</span>
					</div>
					{@render groupBody(row.group, row.items)}
				</section>
			{/each}
		{/if}
	</div>
</div>

{#if open && openItem}
	<PromptEditorPage
		bind:this={editorPage}
		bind:view={editorView}
		{runtime}
		{t}
		item={openItem}
		{open}
		reveal={editorReveal}
		onclose={() => void closeEditor()}
		onlocale={(locale) => {
			editorReveal = null;
			open = { id: open!.id, locale };
		}}
		onopenmessage={openMessage}
	/>
{/if}

<style>
	/*
	 * The groups scroll under a fixed search row and their tabs, as Models' sections do under theirs
	 * (the modal body stops scrolling and leaves its padding to this page).
	 */
	:global(.modal-body) > .prompts-settings {
		flex: 1;
		min-height: 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.prompts-top {
		display: flex;
		flex-direction: column;
		gap: 10px;
		flex: none;
		padding: 18px 24px 12px;
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
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		display: flex;
		flex-direction: column;
		gap: 18px;
		padding: 16px 24px 20px;
	}

	/* Straight under the search, with no tabs between: the list starts where it always did. */
	.prompts-top + .prompts-scroll {
		padding-top: 2px;
	}

	.prompts-panel {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
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

	.prompts-group-note {
		margin: 0;
		padding: 0 4px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
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

	@media (max-width: 720px) {
		.prompts-top {
			padding: 14px 16px 12px;
		}

		.prompts-scroll {
			gap: 16px;
			padding: 16px 16px max(20px, env(safe-area-inset-bottom));
			scrollbar-gutter: auto;
			scrollbar-width: none;
		}

		.prompts-scroll::-webkit-scrollbar {
			display: none;
		}

		/* A group opened from the list comes in from the side, as Models' sections do. */
		.prompts-panel.is-subpage {
			animation: prompt-subpage-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
		}

		.prompts-tools {
			grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
		}

	}

	@keyframes prompt-subpage-in {
		from { transform: translateX(20%); opacity: 0.72; }
		to { transform: translateX(0); opacity: 1; }
	}
</style>
