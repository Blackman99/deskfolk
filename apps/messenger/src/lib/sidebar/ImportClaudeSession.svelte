<script lang="ts">
	import type { ClaudeCodeSessionListing } from '@real-bot/protocol';
	import Button from '../Button.svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { importRequest, importSubtitle } from './import-claude-session.ts';

	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		/** The terminal sessions the sheet read once; null while they are on the way. */
		items: ClaudeCodeSessionListing[] | null;
		loadFailed: boolean;
	};

	let { runtime, t, items, loadFailed }: Props = $props();

	let picked = $state<ClaudeCodeSessionListing | null>(null);
	let pending = $state(false);
	let error = $state<'missing' | 'failed' | null>(null);
	const locale = $derived(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const now = Date.now();

	function pick(session: ClaudeCodeSessionListing): void {
		picked = session;
		error = null;
	}

	async function submit(): Promise<void> {
		if (!picked || pending) return;
		pending = true;
		error = null;
		const failure = await runtime.createProjectSession(importRequest(picked));
		pending = false;
		// A session file that went away since the list was read.
		if (failure) error = failure.status === 404 ? 'missing' : 'failed';
	}
</script>

{#if loadFailed}
	<p class="field-error" data-import-failed>{t.sidebar.importClaudeFailed}</p>
{:else if !items}
	<p class="muted field-hint">{t.sidebar.importClaudeLoading}</p>
{:else if items.length === 0}
	<p class="muted field-hint">{t.sidebar.importClaudeEmpty}</p>
{:else}
	<div class="import-list" role="listbox" aria-label={t.sidebar.importClaudeList}>
		{#each items as session (session.session_id)}
			<button
				type="button"
				class="import-row"
				class:active={picked?.session_id === session.session_id}
				role="option"
				aria-selected={picked?.session_id === session.session_id}
				data-claude-session={session.session_id}
				onclick={() => pick(session)}
			>
				<span class="import-title">{session.title || t.sidebar.importClaudeNoTitle}</span>
				<span class="import-meta muted">{importSubtitle(session, now, locale)}</span>
			</button>
		{/each}
	</div>
	{#if picked}
		<!-- Kept in view at the bottom of the body, however far down the list you picked. -->
		<div class="modal-section import-form" data-import-form>
			<p class="muted field-hint">{t.sidebar.importClaudeHint}</p>
			{#if error}
				<p class="field-error">{error === 'missing' ? t.sidebar.importClaudeMissing : t.sidebar.saveFailed}</p>
			{/if}
			<div>
				<Button variant="primary" disabled={pending} onclick={() => void submit()}>{t.sidebar.importClaudeSubmit}</Button>
			</div>
		</div>
	{/if}
{/if}

<style>
	/* The modal body scrolls; the list is as tall as its rows. */
	.import-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.import-row {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		min-height: 44px;
		padding: 6px 10px;
		border-radius: 8px;
		text-align: left;
		min-width: 0;
	}

	.import-row:hover {
		background: var(--row-hover);
	}

	.import-row.active {
		background: var(--accent-tint);
	}

	/* Down over the body's own bottom padding (18px), so no row shows beneath it. */
	.import-form {
		position: sticky;
		bottom: -18px;
		padding-top: 12px;
		padding-bottom: 18px;
		border-top: 1px solid var(--line);
		background: var(--pane);
	}

	.import-title,
	.import-meta {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.import-meta {
		font-size: 12px;
	}
</style>
