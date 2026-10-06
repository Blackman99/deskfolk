<script lang="ts">
	import { onDestroy } from 'svelte';
	import { changedLines, type Locale, type PromptDetail, type PromptRevision } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import { ApiError } from '../api.ts';
	import { changedBy, promptErrorText } from './prompts-view.ts';

	interface Props {
		runtime: MessengerRuntime;
		t: Copy;
		id: string;
		locale: Locale;
		/** Switch the language shown; the editor saves what you typed first. */
		onLocale: (locale: Locale) => void;
		/** Open the conversation a Bot's change came from, at its message. */
		onOpenMessage: (sessionId: string, messageId: string) => void;
	}

	let { runtime, t, id, locale, onLocale, onOpenMessage }: Props = $props();
	const c = $derived(t.prompts);
	const ui = $derived<Locale>(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh');

	const SAVE_AFTER_MS = 1000;
	/** One sitting in this editor: your saves in it fold into one change in the history. */
	const editSession = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s${Date.now()}`;

	let detail = $state<PromptDetail | null>(null);
	let loadFailed = $state(false);
	let text = $state('');
	let status = $state<'idle' | 'saving' | 'saved' | 'unsaved'>('idle');
	let problem = $state<string | null>(null);
	let stale = $state<string | null>(null);
	let copied = $state(false);
	let comparing = $state(false);
	let showFormat = $state(false);
	let showConflict = $state(false);
	let confirmingReset = $state(false);
	let busy = $state(false);
	let opened = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;

	const dirty = $derived(detail !== null && text !== detail.text);
	const edited = $derived(detail?.base_text != null);
	const compare = $derived(detail && comparing ? changedLines(detail.default_text, text) : []);
	const conflictDiff = $derived(detail?.conflict_default && detail.base_text != null && showConflict ? changedLines(detail.base_text, detail.conflict_default) : []);
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

<div class="prompt-editor" aria-busy={busy}>
	{#if !detail}
		<p class="muted prompt-loading" role="status">{loadFailed ? c.loadFailed : ''}</p>
	{:else}
		<div class="prompt-head">
			<p class="prompt-summary">{detail.summary[ui]}</p>
			<div class="prompt-meta">
				<code class="prompt-id">{detail.id}</code>
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
					<span class="prompt-only">{c.onlyLanguage(c.language[detail.locales[0]!.locale])}</span>
				{/if}
				<span class="prompt-save-state" class:is-error={problem !== null} aria-live="polite">
					{status === 'saving' ? c.saving : status === 'saved' ? c.saved : status === 'unsaved' ? c.unsaved : ''}
				</span>
			</div>
		</div>

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
							<li class="diff-{line.kind}">{line.kind === 'gap' ? '⋯' : line.text || ' '}</li>
						{/each}
					</ol>
				{/if}
			</div>
		{/if}

		{#if failures && (failures.since_edit ?? 0) + failures.last_7_days > 0}
			<p class="prompt-failures">{failures.since_edit !== null ? c.parseFailuresSinceEdit(failures.since_edit) : c.parseFailuresWeek(failures.last_7_days)}</p>
		{/if}

		<label class="prompt-field">
			<span class="prompt-field-label">{c.editorLabel}</span>
			<textarea
				class="prompt-text"
				spellcheck="false"
				maxlength={detail.max_chars}
				bind:value={text}
				oninput={schedule}
				onblur={() => void flush()}
			></textarea>
		</label>
		{#if problem}
			<p class="field-error" role="alert">{problem}</p>
		{/if}

		{#if detail.placeholders.length > 0}
			<div class="prompt-placeholders">
				<span class="prompt-block-title">{c.placeholdersTitle}</span>
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

		<div class="prompt-actions">
			<button type="button" class="prompt-button" onclick={() => (comparing = !comparing)}>{comparing ? c.hideCompare : c.compareDefault}</button>
			{#if edited}
				<button type="button" class="prompt-button" disabled={busy} onclick={() => (confirmingReset = true)}>{c.reset}</button>
			{/if}
		</div>
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
		{#if comparing}
			{#if compare.length === 0}
				<p class="muted">{c.sameAsDefault}</p>
			{:else}
				<ol class="prompt-diff">
					{#each compare as line, at (at)}
						<li class="diff-{line.kind}">{line.kind === 'gap' ? '⋯' : line.text || ' '}</li>
					{/each}
				</ol>
			{/if}
		{/if}

		<section class="prompt-history" aria-label={c.history}>
			<h4 class="prompt-block-title">{c.history}</h4>
			{#if detail.revisions.length === 0}
				<p class="muted">{c.noHistory}</p>
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
							<button type="button" class="prompt-link" onclick={() => (opened = opened === revision.id ? null : revision.id)}>{opened === revision.id ? c.hideChange : c.showChange}</button>
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
						{#if opened === revision.id}
							<ol class="prompt-diff">
								{#each changedLines(revision.before_text ?? detail.default_text, revision.after_text ?? detail.default_text) as line, at (at)}
									<li class="diff-{line.kind}">{line.kind === 'gap' ? '⋯' : line.text || ' '}</li>
								{/each}
							</ol>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.prompt-editor {
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
	}

	.prompt-summary {
		margin: 0;
		font-size: 13px;
		line-height: 1.45;
		color: var(--ink-secondary);
	}

	.prompt-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 6px;
	}

	.prompt-id {
		padding: 0 5px;
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--muted);
		font-size: 11px;
	}

	.prompt-locales {
		display: inline-flex;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		overflow: hidden;
	}

	.prompt-locale {
		padding: 2px 10px;
		border: 0;
		background: var(--pane);
		color: var(--ink-secondary);
		font-size: 12px;
		cursor: pointer;
	}

	.prompt-locale.is-active {
		background: var(--accent-tint);
		color: var(--accent);
		font-weight: 600;
	}

	.prompt-only,
	.prompt-save-state {
		font-size: 12px;
		color: var(--muted);
	}

	.prompt-save-state {
		margin-left: auto;
	}

	.prompt-save-state.is-error {
		color: var(--danger-text);
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

	.prompt-failures {
		margin: 0;
		font-size: 12px;
		color: var(--warn-text);
	}

	.prompt-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.prompt-field-label,
	.prompt-block-title {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.prompt-text {
		box-sizing: border-box;
		width: 100%;
		min-height: 240px;
		max-height: 60vh;
		padding: 10px 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--ink);
		font: 13px/1.55 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		resize: vertical;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.prompt-placeholders ul,
	.prompt-history ul {
		list-style: none;
		margin: 4px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.prompt-placeholders code {
		padding: 0 4px;
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink);
	}

	.prompt-format summary {
		cursor: pointer;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.prompt-format pre {
		margin: 6px 0 0;
		padding: 8px 10px;
		border-radius: var(--radius-md);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 12px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.prompt-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.prompt-button {
		padding: 3px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--pane);
		color: var(--ink-secondary);
		font-size: 12px;
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
		font: 12px/1.5 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		max-height: 40vh;
		overflow: auto;
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

	.prompt-revision {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
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
</style>
