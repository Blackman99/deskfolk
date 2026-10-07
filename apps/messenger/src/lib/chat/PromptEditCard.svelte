<script lang="ts">
	import type { Approval, PromptRevisionRef } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { parsePromptCard, promptCardTarget, type PromptTarget } from '../settings/prompts-view.ts';

	interface Props {
		/** The card's text: what changes, as the daemon wrote it (prompt-tools.ts). */
		body: string;
		t: Copy;
		approval: Approval | null;
		api: MessengerApi | null;
		/** Settings at this prompt's history, at the change the card let through; null when the card names none. */
		onOpenSettings: (target: PromptTarget | null) => void;
	}

	let { body, t, approval, api, onOpenSettings }: Props = $props();
	const c = $derived(t.prompts.card);
	const card = $derived(parsePromptCard(body));
	/** Past this many changed lines the card shows the first few until you ask for all. */
	const SHORT = 12;
	const lineCount = $derived(card.hunks.reduce((sum, hunk) => sum + hunk.lines.length + 1, 0));
	let expanded = $state(false);

	let revision = $state<PromptRevisionRef | null>(null);
	let undone = $state(false);
	let undoFailed = $state(false);
	let busy = $state(false);

	// Once you allow it, the change it made, for its Undo.
	$effect(() => {
		const allowed = approval?.status === 'allowed_once' ? approval.id : null;
		if (!allowed || !api) return;
		void api.promptRevisionForApproval(allowed).then(
			(found) => {
				revision = found;
			},
			() => {}
		);
	});

	async function undo(): Promise<void> {
		if (!api || !revision || busy) return;
		busy = true;
		try {
			await api.undoPromptRevision(revision.id);
			undone = true;
		} catch {
			undoFailed = true;
		} finally {
			busy = false;
		}
	}

	function openInSettings(): void {
		const prompt = revision ? { id: revision.prompt_id, locale: revision.locale } : promptCardTarget(approval?.target);
		onOpenSettings(prompt ? { ...prompt, revisionId: revision?.id ?? null } : null);
	}

	function shownHunks() {
		if (expanded || lineCount <= SHORT) return card.hunks;
		const out: typeof card.hunks = [];
		let left = SHORT;
		for (const hunk of card.hunks) {
			if (left <= 0) break;
			out.push({ title: hunk.title, lines: hunk.lines.slice(0, Math.max(0, left - 1)) });
			left -= hunk.lines.length + 1;
		}
		return out;
	}
</script>

<div class="prompt-card">
	<p class="prompt-card-head">{card.head}</p>
	{#if card.reach}<p class="prompt-card-reach">{card.reach}</p>{/if}
	{#if card.reason}<p class="prompt-card-reason">{card.reason}</p>{/if}
	{#each shownHunks() as hunk, at (at)}
		<div class="prompt-card-hunk">
			<p class="prompt-card-hunk-title">{hunk.title}</p>
			<ol class="prompt-card-lines">
				{#each hunk.lines as line, n (n)}
					<li class="is-{line.kind}"><span class="prompt-card-mark" aria-hidden="true">{line.kind === 'del' ? '−' : '+'}</span>{line.text || ' '}</li>
				{/each}
			</ol>
		</div>
	{/each}
	{#if card.more}<p class="prompt-card-more">{card.more}</p>{/if}
	{#if lineCount > SHORT}
		<button type="button" class="prompt-card-link" onclick={() => (expanded = !expanded)}>{expanded ? c.collapse : c.expand}</button>
	{/if}
	{#if approval?.status === 'allowed_once'}
		<div class="prompt-card-acts">
			{#if undone}
				<span class="prompt-card-note">{c.undone}</span>
			{:else if undoFailed}
				<span class="prompt-card-note">{c.undoFailed}</span>
			{:else if revision?.undoable}
				<button type="button" class="prompt-card-link" disabled={busy} onclick={() => void undo()}>{c.undo}</button>
			{/if}
			<button type="button" class="prompt-card-link" onclick={openInSettings}>{c.openSettings}</button>
		</div>
	{/if}
</div>

<style>
	.prompt-card {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		font-size: 13px;
	}

	.prompt-card-head {
		margin: 0;
		font-weight: 600;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.prompt-card-reach,
	.prompt-card-reason,
	.prompt-card-more,
	.prompt-card-note {
		margin: 0;
		font-size: 12px;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	/* How far the change reaches is what to weigh before allowing it. */
	.prompt-card-reach {
		color: var(--ink);
	}

	.prompt-card-hunk-title {
		margin: 0;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
	}

	.prompt-card-lines {
		list-style: none;
		margin: 2px 0 0;
		padding: 4px 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		font: 12px/1.5 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
	}

	.prompt-card-lines li {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.prompt-card-lines .is-del {
		background: var(--danger-bg);
		color: var(--danger-text);
	}

	.prompt-card-lines .is-add {
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	.prompt-card-mark {
		display: inline-block;
		width: 1.2em;
		user-select: none;
	}

	.prompt-card-acts {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 2px;
	}

	.prompt-card-link {
		align-self: flex-start;
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font-size: 12px;
		cursor: pointer;
	}

	.prompt-card-link:disabled {
		opacity: 0.6;
		cursor: default;
	}
</style>
