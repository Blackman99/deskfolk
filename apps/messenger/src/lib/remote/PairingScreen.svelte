<script lang="ts">
	import { formatFingerprint } from './fingerprint.ts';
	import { previewPairing } from './pairing.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Copy } from '../copy.ts';

	let { runtime, t }: { runtime: MessengerRuntime; t: Copy } = $props();
	let raw = $state('');
	const preview = $derived(raw.trim() ? previewPairing(raw) : runtime.pairing);

	async function submit(): Promise<void> {
		await runtime.submitPairing(raw);
	}
</script>

<main class="pairing-screen">
	<div class="modal-dialog pairing-card">
		<div class="modal-head">
			<h1>{t.remote.pairTitle}</h1>
		</div>
		<div class="modal-body">
			<p class="pairing-lead">{t.remote.pairLead}</p>
			<p class="pairing-hint">{t.remote.pairHint}</p>
			<label class="pairing-label" for="pairing-qr">{t.remote.pairPaste}</label>
			<textarea
				id="pairing-qr"
				class="pairing-input"
				rows="6"
				spellcheck="false"
				autocomplete="off"
				bind:value={raw}
				disabled={runtime.pairingBusy}
			></textarea>
			{#if preview.phase === 'rejected'}
				<p class="field-error" role="alert">
					{preview.reason === 'url'
						? t.remote.pairUrl
						: preview.reason === 'expired'
							? t.remote.pairExpired
							: preview.reason === 'rejected'
								? t.remote.pairRejected
								: t.remote.pairInvalid}
				</p>
			{/if}
			{#if preview.phase === 'confirm'}
				<p class="pairing-origin">{preview.relayOrigin}</p>
				<p class="pairing-fingerprint" data-testid="host-fingerprint">{formatFingerprint(preview.fingerprint)}</p>
			{/if}
			{#if runtime.pairing.phase === 'waiting'}
				<p role="status">{t.remote.pairWaiting}</p>
			{/if}
		</div>
		<div class="modal-foot">
			<button type="button" class="btn-primary" disabled={runtime.pairingBusy || !raw.trim()} onclick={() => void submit()}>
				{runtime.pairingBusy ? t.remote.pairWaiting : t.remote.pairSubmit}
			</button>
		</div>
	</div>
</main>

<style>
	.pairing-screen {
		min-height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: var(--bg);
	}

	/* On a phone the card is the screen: 24px of background on every side buys nothing. */
	@media (max-width: 680px) {
		.pairing-screen {
			align-items: stretch;
			padding: 0;
		}

		.pairing-card {
			width: 100%;
			border: 0;
			border-radius: 0;
			box-shadow: none;
			min-height: 100%;
		}

		.pairing-card :global(.modal-head) {
			height: calc(52px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 16px 0;
		}

		.pairing-card :global(.modal-body) {
			padding: 16px 16px calc(20px + env(safe-area-inset-bottom));
		}
	}
	.pairing-card {
		width: min(520px, 100%);
	}
	.pairing-lead,
	.pairing-hint,
	.pairing-origin {
		margin: 0 0 8px;
		color: var(--muted);
		font-size: 13px;
	}
	.pairing-label {
		display: block;
		margin: 12px 0 6px;
		font-weight: 600;
	}
	.pairing-input {
		width: 100%;
		resize: vertical;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 10px;
		background: var(--pane);
		font-family: var(--mono);
		font-size: 12px;
	}
	.pairing-fingerprint {
		font-family: var(--mono);
		font-size: 12px;
		line-height: 1.6;
		word-break: break-all;
		color: var(--ink);
	}
	.modal-foot {
		padding: 12px 20px 18px;
		display: flex;
		justify-content: flex-end;
	}
	.btn-primary {
		background: var(--accent);
		color: #fff;
		border-radius: 8px;
		padding: 8px 14px;
		font-weight: 600;
		min-height: 44px;
	}
</style>
