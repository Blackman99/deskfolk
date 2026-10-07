<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { changedLines, type Locale, type PromptDetail, type PromptRevision } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import { ApiError } from '../api.ts';
	import { changedBy, markChanges, promptErrorText, type MarkedLine, type PromptView } from './prompts-view.ts';

	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		id: string;
		locale: Locale;
		/** Switch the language shown; the editor saves what you typed first. */
		onLocale: (locale: Locale) => void;
		/** Open the conversation a Bot's change came from, at its message. */
		onOpenMessage: (sessionId: string, messageId: string) => void;
		/** The view shown; bound, so switching the language keeps you where you were. */
		view?: PromptView;
		/** A change to show opened, and scrolled to, in the history when it first loads. */
		revealRevision?: string | null;
	}

	let { runtime, t, id, locale, onLocale, onOpenMessage, view = $bindable('text'), revealRevision = null }: Props = $props();
	const c = $derived(t.prompts);
	const ui = $derived<Locale>(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh');

	const SAVE_AFTER_MS = 1000;
	/** One sitting in this editor: your saves in it fold into one change in the history. */
	const editSession = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s${Date.now()}`;

	/** The text you edit, what it changes from the default, and every change so far: one at a time. */
	const VIEWS: readonly PromptView[] = ['text', 'compare', 'history'];

	let detail = $state<PromptDetail | null>(null);
	let loadFailed = $state(false);
	let text = $state('');
	let status = $state<'idle' | 'saving' | 'saved' | 'unsaved'>('idle');
	let problem = $state<string | null>(null);
	let stale = $state<string | null>(null);
	let copied = $state(false);
	let showFormat = $state(false);
	let showConflict = $state(false);
	let confirmingReset = $state(false);
	let busy = $state(false);
	let opened = $state<string | null>(untrack(() => revealRevision));
	let timer: ReturnType<typeof setTimeout> | null = null;

	const dirty = $derived(detail !== null && text !== detail.text);
	const edited = $derived(detail?.base_text != null);
	const compare = $derived(detail && view === 'compare' ? markChanges(changedLines(detail.default_text, text)) : []);
	const conflictDiff = $derived(detail?.conflict_default && detail.base_text != null && showConflict ? markChanges(changedLines(detail.base_text, detail.conflict_default)) : []);
	const failures = $derived(detail?.locales.find((state) => state.locale === locale)?.parse_failures ?? null);

	async function load(keepTyping = false): Promise<void> {
		const api = runtime.client;
		if (!api) return;
		try {
			const next = await api.getPrompt(id, locale);
			if (runtime.client !== api) return;
			loadFailed = false;
			// What you are typing stays put; a change made elsewhere shows once you stop.
			if (keepTyping && dirty) return;
			detail = next;
			text = next.text;
		} catch {
			loadFailed = true;
		}
	}

	$effect(() => {
		void id;
		void locale;
		detail = null;
		status = 'idle';
		problem = null;
		stale = null;
		void load();
	});

	// The change you were sent to: in view once the history first shows it.
	let revealed = false;
	$effect(() => {
		if (revealed || !detail || view !== 'history' || !revealRevision) return;
		revealed = true;
		const target = revealRevision;
		void tick().then(() => {
			const row = [...document.querySelectorAll<HTMLElement>('.prompt-revision')].find((el) => el.dataset.revision === target);
			row?.scrollIntoView?.({ block: 'nearest' });
		});
	});

	// A change from anywhere (a Bot's approved edit, the phone, a merge): reload unless you are mid-edit.
	let seenRevision: number | null = null;
	$effect(() => {
		const revision = runtime.promptsRevision;
		const first = seenRevision === null;
		if (revision === seenRevision) return;
		seenRevision = revision;
		if (!first && status !== 'saving') void load(true);
	});

	function schedule(): void {
		if (timer) clearTimeout(timer);
		status = 'unsaved';
		problem = null;
		timer = setTimeout(() => void save(), SAVE_AFTER_MS);
	}

	export async function flush(): Promise<void> {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (dirty) await save();
	}

	async function save(): Promise<void> {
		timer = null;
		const api = runtime.client;
		if (!api || !detail || !dirty || busy) return;
		const sent = text;
		status = 'saving';
		try {
			const next = await api.putPrompt(id, locale, { text: sent, if_revision: detail.head_revision_id, edit_session: editSession });
			detail = next;
			if (text === sent) text = next.text;
			status = text === next.text ? 'saved' : 'unsaved';
			problem = null;
		} catch (error) {
			if (error instanceof ApiError && error.status === 409) {
				// Someone else changed it: show theirs, keep yours to copy.
				stale = sent;
				await load();
				status = 'idle';
				return;
			}
			status = 'unsaved';
			problem = promptErrorText(error, c);
		}
	}

	async function act(run: () => Promise<PromptDetail>): Promise<void> {
		if (busy) return;
		busy = true;
		problem = null;
		try {
			const next = await run();
			detail = next;
			text = next.text;
			status = 'saved';
		} catch (error) {
			if (error instanceof ApiError && error.status === 409) await load();
			problem = promptErrorText(error, c);
		} finally {
			busy = false;
			confirmingReset = false;
		}
	}

	async function copyStale(): Promise<void> {
		if (!stale) return;
		try {
			await navigator.clipboard.writeText(stale);
			copied = true;
		} catch {
			copied = false;
		}
	}

	function switchLocale(next: Locale): void {
		if (next === locale) return;
		void flush().then(() => onLocale(next));
	}

	/** Leaving the text saves what you typed, so the history shows it and nothing waits on a timer. */
	function showView(next: PromptView): void {
		if (next === view) return;
		if (view === 'text') void flush();
		view = next;
	}

	/** Arrow keys walk the views, as in any row of tabs. */
	async function onTabKeydown(event: KeyboardEvent): Promise<void> {
		const at = VIEWS.indexOf(view);
		const next =
			event.key === 'ArrowRight' ? VIEWS[(at + 1) % VIEWS.length]
			: event.key === 'ArrowLeft' ? VIEWS[(at + VIEWS.length - 1) % VIEWS.length]
			: event.key === 'Home' ? VIEWS[0]
			: event.key === 'End' ? VIEWS[VIEWS.length - 1]
			: null;
		if (!next) return;
		event.preventDefault();
		showView(next);
		await tick();
		document.getElementById(`prompt-tab-${next}`)?.focus();
	}

	/** Whether a change changed the words at all: keeping your version over a newer default does not. */
	function changesText(revision: PromptRevision): boolean {
		return (revision.before_text ?? detail!.default_text) !== (revision.after_text ?? detail!.default_text);
	}

	function revisionTitle(revision: PromptRevision): string {
		return `${changedBy(revision.actor, revision.bot_name, c)} · ${c.op[revision.op]}`;
	}

	onDestroy(() => {
		if (timer) {
			clearTimeout(timer);
			if (dirty) void save();
		}
	});
</script>

<!-- A changed line with the part that changed marked, so a space added or taken out shows. -->
{#snippet diffText(line: MarkedLine)}{#if line.kind === 'gap'}⋯{:else if line.mark}{line.text.slice(0, line.mark.start)}<mark>{line.text.slice(line.mark.start, line.mark.end)}</mark>{line.text.slice(line.mark.end)}{:else}{line.text || ' '}{/if}{/snippet}

<div class="prompt-editor" aria-busy={busy}>
	{#if !detail}
		<p class="muted prompt-loading" role="status">{loadFailed ? c.loadFailed : ''}</p>
	{:else}
		<div class="prompt-top">
			<div class="prompt-meta">
				<p class="prompt-summary">{detail.summary[ui]}</p>
				{#if detail.locales.length > 1}
					<div class="prompt-locales" role="group" aria-label={c.language[locale]}>
						{#each detail.locales as state (state.locale)}
							<button
								type="button"
								class="prompt-locale"
								class:is-active={state.locale === locale}
								aria-pressed={state.locale === locale}
								onclick={() => switchLocale(state.locale)}
							>{c.language[state.locale]}{state.state !== 'default' ? ' •' : ''}</button>
						{/each}
					</div>
				{:else}
					<span class="prompt-only" title={c.onlyLanguage(c.language[detail.locales[0]!.locale])}>{c.onlyLanguageShort(c.language[detail.locales[0]!.locale])}</span>
				{/if}
			</div>

			{#if failures && (failures.since_edit ?? 0) + failures.last_7_days > 0}
				<p class="prompt-failures">{failures.since_edit !== null ? c.parseFailuresSinceEdit(failures.since_edit) : c.parseFailuresWeek(failures.last_7_days)}</p>
			{/if}

			{#if stale !== null}
				<div class="prompt-banner is-warn" role="status">
					<span>{c.changedElsewhere}</span>
					<button type="button" class="prompt-link" onclick={() => void copyStale()}>{copied ? c.copied : c.copyMine}</button>
				</div>
			{/if}

			{#if detail.conflict_default}
				<div class="prompt-banner is-conflict" role="status">
					<strong>{c.conflictTitle}</strong>
					<span>{c.conflictBody}</span>
					<div class="prompt-actions">
						<button type="button" class="prompt-button" onclick={() => (showConflict = !showConflict)}>{showConflict ? c.conflictHide : c.conflictShow}</button>
						<button type="button" class="prompt-button" disabled={busy} onclick={() => void act(() => runtime.client!.keepMyPrompt(id, locale, detail!.head_revision_id))}>{c.conflictKeep}</button>
						<button type="button" class="prompt-button" disabled={busy} onclick={() => (confirmingReset = true)}>{c.conflictTake}</button>
					</div>
					{#if showConflict}
						<ol class="prompt-diff">
							{#each conflictDiff as line, at (at)}
								<li class="diff-{line.kind}">{@render diffText(line)}</li>
							{/each}
						</ol>
					{/if}
				</div>
			{/if}

			{#if confirmingReset}
				<div class="prompt-banner is-warn" role="alertdialog" aria-label={c.resetConfirmTitle}>
					<strong>{c.resetConfirmTitle}</strong>
					<span>{c.resetConfirmBody}</span>
					<div class="prompt-actions">
						<button type="button" class="prompt-button is-danger" disabled={busy} onclick={() => void act(() => runtime.client!.resetPrompt(id, locale, detail!.head_revision_id))}>{c.reset}</button>
						<button type="button" class="prompt-button" onclick={() => (confirmingReset = false)}>{c.cancel}</button>
					</div>
				</div>
			{/if}
		</div>

		<div class="prompt-tabbar">
			<div class="prompt-tabs" role="tablist" aria-label={detail.title[ui]}>
				{#each VIEWS as name (name)}
					<button
						type="button"
						role="tab"
						id="prompt-tab-{name}"
						class="prompt-tab"
						class:is-active={view === name}
						aria-selected={view === name}
						aria-controls="prompt-panel-{name}"
						tabindex={view === name ? 0 : -1}
						data-view={name}
						onclick={() => showView(name)}
						onkeydown={(event) => void onTabKeydown(event)}
					>
						{c.view[name]}
						{#if name === 'history' && detail.revisions.length > 0}
							<span class="prompt-tab-count">{detail.revisions.length}</span>
						{/if}
					</button>
				{/each}
			</div>
			<div class="prompt-tabbar-end">
				<span class="prompt-save-state" class:is-error={problem !== null} aria-live="polite">
					{status === 'saving' ? c.saving : status === 'saved' ? c.saved : status === 'unsaved' ? c.unsaved : ''}
				</span>
				{#if edited}
					<button type="button" class="prompt-button" disabled={busy} onclick={() => (confirmingReset = true)}>{c.reset}</button>
				{/if}
			</div>
		</div>

		<!-- Kept while another view shows, so the text keeps its own undo and scroll. -->
		<div class="prompt-view is-text" role="tabpanel" id="prompt-panel-text" aria-labelledby="prompt-tab-text" hidden={view !== 'text'}>
			<textarea
				class="prompt-text"
				aria-label={c.editorLabel}
				spellcheck="false"
				maxlength={detail.max_chars}
				bind:value={text}
				oninput={schedule}
				onblur={() => void flush()}
			></textarea>
			{#if problem}
				<p class="field-error" role="alert">{problem}</p>
			{/if}
			{#if detail.placeholders.length > 0 || detail.format}
				<div class="prompt-foot">
					{#if detail.placeholders.length > 0}
						<div class="prompt-placeholders">
							<span class="prompt-foot-label" title={c.placeholdersHint}>{c.placeholdersTitle}</span>
							<ul>
								{#each detail.placeholders as placeholder (placeholder.name)}
									<li><code>{`{${placeholder.name}}`}</code> {placeholder.meaning[ui]} · {c.placeholderRule[placeholder.required]}</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if detail.format}
						<details class="prompt-format" bind:open={showFormat}>
							<summary>{c.formatTitle}</summary>
							<p class="muted">{c.formatNote}</p>
							<pre>{detail.format}</pre>
						</details>
					{/if}
				</div>
			{/if}
		</div>

		{#if view === 'compare'}
			<div class="prompt-view" role="tabpanel" id="prompt-panel-compare" aria-labelledby="prompt-tab-compare">
				{#if compare.length === 0}
					<p class="muted prompt-empty">{c.sameAsDefault}</p>
				{:else}
					<ol class="prompt-diff is-full">
						{#each compare as line, at (at)}
							<li class="diff-{line.kind}">{@render diffText(line)}</li>
						{/each}
					</ol>
				{/if}
			</div>
		{:else if view === 'history'}
			<div class="prompt-view" role="tabpanel" id="prompt-panel-history" aria-labelledby="prompt-tab-history">
				<section class="prompt-history" aria-label={c.history}>
					{#if detail.revisions.length === 0}
						<p class="muted prompt-empty">{c.noHistory}</p>
					{/if}
					<ul>
						{#each detail.revisions as revision (revision.id)}
							<li class="prompt-revision" data-revision={revision.id}>
								<div class="prompt-revision-head">
									<span class="prompt-revision-title">{revisionTitle(revision)}</span>
									<span class="muted" title={formatFullTimestamp(revision.created_at)}>{formatMessageTime(revision.created_at)}</span>
								</div>
								{#if revision.reason}
									<p class="prompt-revision-reason">{revision.reason}</p>
								{/if}
								<div class="prompt-actions">
									{#if changesText(revision)}
										<button type="button" class="prompt-link" onclick={() => (opened = opened === revision.id ? null : revision.id)}>{opened === revision.id ? c.hideChange : c.showChange}</button>
									{/if}
									{#if revision.undoable}
										<button type="button" class="prompt-link" disabled={busy} onclick={() => void act(() => runtime.client!.undoPromptRevision(revision.id))}>{c.undo}</button>
									{/if}
									{#if (revision.after_text ?? detail.default_text) !== detail.text}
										<button type="button" class="prompt-link" disabled={busy} onclick={() => void act(() => runtime.client!.restorePromptRevision(revision.id))}>{c.restoreVersion}</button>
									{/if}
									{#if revision.session_id && revision.message_id}
										<button type="button" class="prompt-link" onclick={() => onOpenMessage(revision.session_id!, revision.message_id!)}>{c.openMessage}</button>
									{/if}
								</div>
								{#if opened === revision.id && changesText(revision)}
									<ol class="prompt-diff">
										{#each markChanges(changedLines(revision.before_text ?? detail.default_text, revision.after_text ?? detail.default_text)) as line, at (at)}
											<li class="diff-{line.kind}">{@render diffText(line)}</li>
										{/each}
									</ol>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			</div>
		{/if}
	{/if}
</div>

<style>
	/* It fills the editor page: notes on top, a row of views, then the view itself taking the rest. */
	:global(.prompt-editor-body) > .prompt-editor {
		flex: 1 1 auto;
		min-height: 0;
	}

	.prompt-editor {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.prompt-loading {
		margin: 0;
		padding: 16px 20px;
	}

	.prompt-top {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px 20px 12px;
		flex: none;
	}

	.prompt-meta {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.prompt-summary {
		flex: 1;
		min-width: 0;
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		color: var(--ink-secondary);
	}

	.prompt-locales {
		flex: none;
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-md);
		background: var(--chip);
	}

	.prompt-locale {
		padding: 2px 10px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		white-space: nowrap;
		cursor: pointer;
		transition-property: background-color, color, box-shadow;
	}

	.prompt-locale:hover:not(.is-active) {
		color: var(--ink);
	}

	.prompt-locale.is-active {
		background: var(--pane);
		color: var(--accent);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}

	.prompt-only {
		flex: none;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		background: var(--chip);
		font-size: 11px;
		line-height: 1.6;
		color: var(--muted);
		white-space: nowrap;
		cursor: help;
	}

	.prompt-failures {
		margin: 0;
		font-size: 12px;
		color: var(--warn-text);
	}

	.prompt-banner {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px;
		border-radius: var(--radius-md);
		font-size: 12px;
		line-height: 1.45;
	}

	.prompt-banner.is-warn {
		border: 1px solid var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
	}

	.prompt-banner.is-conflict {
		border: 1px solid var(--danger-line);
		background: var(--danger-bg);
		color: var(--danger-text);
	}

	.prompt-banner .prompt-diff {
		max-height: 30vh;
	}

	.prompt-tabbar {
		flex: none;
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 4px 12px;
		padding: 0 20px;
		border-bottom: 1px solid var(--line);
	}

	.prompt-tabs {
		display: flex;
		gap: 4px;
		min-width: 0;
	}

	.prompt-tab {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-bottom: -1px;
		padding: 8px 10px 9px;
		border: 0;
		border-bottom: 2px solid transparent;
		background: none;
		color: var(--muted);
		font-size: 13px;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition-property: color, border-color;
	}

	.prompt-tab:hover:not(.is-active) {
		color: var(--ink);
	}

	.prompt-tab.is-active {
		border-bottom-color: var(--accent);
		color: var(--ink);
		font-weight: 600;
	}

	.prompt-tab:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}

	.prompt-tab-count {
		min-width: 16px;
		padding: 0 5px;
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--muted);
		font-size: 11px;
		font-weight: 600;
		line-height: 16px;
		text-align: center;
		box-sizing: border-box;
	}

	.prompt-tabbar-end {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 36px;
		margin-left: auto;
	}

	.prompt-save-state {
		font-size: 12px;
		color: var(--muted);
		white-space: nowrap;
	}

	.prompt-save-state.is-error {
		color: var(--danger-text);
	}

	.prompt-view {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px 20px 18px;
	}

	.prompt-view[hidden] {
		display: none;
	}

	.prompt-empty {
		margin: 0;
		font-size: 13px;
	}

	.prompt-editor .prompt-text {
		box-sizing: border-box;
		flex: 1 1 auto;
		width: 100%;
		min-height: 220px;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--input-bg);
		color: var(--ink);
		font: 13px/1.6 var(--mono);
		resize: none;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.prompt-editor .prompt-text:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
		outline: none;
	}

	.prompt-foot {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.prompt-placeholders {
		display: flex;
		align-items: baseline;
		gap: 10px;
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.prompt-foot-label {
		flex: none;
		font-weight: 600;
		color: var(--ink);
		cursor: help;
	}

	.prompt-placeholders ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
	}

	.prompt-placeholders code {
		padding: 0 4px;
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink);
		font-family: var(--mono);
	}

	.prompt-format summary {
		width: fit-content;
		cursor: pointer;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.prompt-format p {
		margin: 6px 0 0;
		font-size: 12px;
	}

	.prompt-format pre {
		margin: 6px 0 0;
		padding: 8px 10px;
		border-radius: var(--radius-md);
		background: var(--chip);
		color: var(--ink-secondary);
		font: 12px/1.5 var(--mono);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.prompt-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 12px;
	}

	.prompt-banner .prompt-actions {
		gap: 6px;
	}

	.prompt-button {
		padding: 3px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--pane);
		color: var(--ink-secondary);
		font-size: 12px;
		white-space: nowrap;
		cursor: pointer;
	}

	.prompt-button:hover:not(:disabled) {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.prompt-button.is-danger {
		border-color: var(--danger-line);
		color: var(--danger-text);
	}

	.prompt-button:disabled,
	.prompt-link:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.prompt-link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}

	.prompt-diff {
		list-style: none;
		margin: 0;
		padding: 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		font: 12px/1.5 var(--mono);
		max-height: 40vh;
		overflow: auto;
	}

	/* The comparison is the whole view, so it scrolls with it rather than in a box of its own. */
	.prompt-diff.is-full {
		max-height: none;
		overflow: visible;
		padding: 8px 10px;
	}

	.prompt-diff li {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.prompt-diff .diff-del {
		background: var(--danger-bg);
		color: var(--danger-text);
		text-decoration: line-through;
	}

	.prompt-diff .diff-add {
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	.prompt-diff .diff-gap {
		color: var(--muted);
	}

	.prompt-diff mark {
		padding: 0;
		border-radius: 2px;
		color: inherit;
	}

	.prompt-diff .diff-del mark {
		background: var(--danger-line);
	}

	.prompt-diff .diff-add mark {
		background: var(--ok-line);
	}

	.prompt-history ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.prompt-revision {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.prompt-revision-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.prompt-revision-title {
		font-weight: 600;
		color: var(--ink);
	}

	.prompt-revision-reason {
		margin: 0;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	@media (max-width: 720px) {
		.prompt-top {
			padding: 12px 14px 10px;
		}

		.prompt-tabbar {
			padding: 0 10px;
		}

		.prompt-tab {
			padding: 10px 8px 11px;
		}

		.prompt-view {
			padding: 12px 14px max(18px, env(safe-area-inset-bottom));
		}

		.prompt-editor .prompt-text {
			font-size: 14px;
		}

		.prompt-placeholders {
			flex-direction: column;
			gap: 4px;
		}
	}
</style>
