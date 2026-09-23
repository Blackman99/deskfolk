<script lang="ts">
	import { ANNOTATION_BATCH_MAX } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';

	interface Props {
		count: number;
		/** `将发到你和 X 的私聊`, or null when the batch goes to the session on screen. */
		destination: string | null;
		sending: boolean;
		error: string | null;
		t: Copy;
		/**
		 * Send the batch — the oldest `ANNOTATION_BATCH_MAX` drafts when there are more — and say
		 * whether it went out. The summary stays until it has.
		 */
		onSend: (summary: string) => Promise<boolean>;
		onClear: () => void;
	}

	let { count, destination, sending, error, t, onSend, onClear }: Props = $props();
	let summary = $state('');
	let confirmClear = $state(false);
	/** The daemon takes at most this many at once; the rest wait for the next send. */
	const capped = $derived(count > ANNOTATION_BATCH_MAX);

	async function send(): Promise<void> {
		if (sending || count === 0) return;
		const sent = summary;
		// A failed send (the daemon draining, a network drop) keeps what was typed for the retry.
		if ((await onSend(sent.trim())) && summary === sent) summary = '';
	}

	function onKey(ev: KeyboardEvent): void {
		if (ev.key === 'Enter' && !ev.shiftKey) {
			ev.preventDefault();
			void send();
		}
	}
</script>

<div class="annot-send flex flex-col gap-6 px-12 py-8" data-annotation-send-bar>
	<div class="flex items-center gap-8 flex-wrap">
		<span class="text-12 font-semibold">{t.stream.annotationSendPending(count)}</span>
		{#if destination}
			<span class="annot-send-dest text-11">{destination}</span>
		{/if}
	</div>
	<div class="annot-send-row flex items-center gap-6">
		<input
			class="annot-send-input flex-1 min-w-0"
			type="text"
			placeholder={t.stream.annotationSendSummary}
			bind:value={summary}
			onkeydown={onKey}
			disabled={sending}
		/>
		<button type="button" class="annot-send-btn" onclick={() => void send()} disabled={sending || count === 0}>
			{sending ? t.stream.annotationSending : t.stream.annotationSend}
		</button>
		{#if confirmClear}
			<span class="text-11">{t.stream.annotationClearConfirm}</span>
			<button type="button" class="artifact-tool-btn annot-send-clear is-danger" onclick={() => { confirmClear = false; onClear(); }} disabled={sending}>{t.stream.annotationClearYes}</button>
			<button type="button" class="artifact-tool-btn annot-send-clear" onclick={() => (confirmClear = false)}>{t.stream.annotationCancel}</button>
		{:else}
			<button type="button" class="artifact-tool-btn annot-send-clear" onclick={() => (confirmClear = true)} disabled={sending}>{t.stream.annotationClear}</button>
		{/if}
	</div>
	{#if capped}
		<p class="annot-send-cap text-11 m-0" data-annotation-send-cap>{t.stream.annotationSendCapped(ANNOTATION_BATCH_MAX)}</p>
	{/if}
	{#if error}
		<p class="annot-send-error text-11 m-0">{error}</p>
	{/if}
</div>

<style>
	.annot-send {
		border-top: 1px solid var(--line);
		background: var(--pane);
	}
	.annot-send-dest {
		color: var(--muted);
	}
	.annot-send-input {
		min-height: 32px;
		padding: 4px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--input-bg);
		color: var(--ink);
		font: inherit;
		font-size: 12.5px;
	}
	.annot-send-input:focus {
		outline: none;
		border-color: var(--accent);
	}
	.annot-send-btn {
		min-height: 32px;
		padding: 0 12px;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		background: var(--accent);
		color: #fff;
		font-weight: 600;
		font-size: 12.5px;
		cursor: pointer;
		white-space: nowrap;
	}
	.annot-send-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.annot-send-clear {
		min-height: 32px;
		white-space: nowrap;
	}
	.annot-send-clear.is-danger {
		color: var(--danger);
	}
	.annot-send-cap {
		color: var(--muted);
	}
	.annot-send-error {
		color: var(--danger);
	}
	@media (max-width: 680px) {
		.annot-send-row {
			flex-wrap: wrap;
		}
		.annot-send-input {
			flex-basis: 100%;
			min-height: 40px;
		}
		.annot-send-btn,
		.annot-send-clear {
			min-height: 40px;
		}
	}
</style>
