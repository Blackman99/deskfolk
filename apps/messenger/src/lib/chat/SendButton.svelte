<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import type { ComposerAction } from './composer-mode.ts';
	import type { SessionView } from '../session-view.svelte.ts';

	type Props = {
		t: Copy;
		connected: boolean;
		primaryAction: ComposerAction;
		/** A direct's one Stop, beside Send while its Bot has a turn going here. */
		directStop: boolean;
		/** Greyed with nothing to send while something else can be pressed: gone where the composer is narrow. */
		stepsAside: boolean;
		/** A send from this conversation is in flight. */
		sending: boolean | undefined;
		/** The files of the send in flight and how many of their bytes have gone out. */
		upload: SessionView['upload'] | undefined;
		onStop: () => void;
		onSend: () => void;
	};

	let { t, connected, primaryAction, directStop, stepsAside, sending, upload, onStop, onSend }: Props = $props();

	/**
	 * A send the Mac next door answers at once shows nothing. One still on its way after this long —
	 * over the relay, behind a picture already downloading, a file uploading — says so on the
	 * button, where a greyed-out one looked exactly like a composer with nothing to send.
	 */
	const SENDING_SHOW_MS = 250;
	let sendingShown = $state(false);
	$effect(() => {
		if (!sending) {
			sendingShown = false;
			return;
		}
		const timer = setTimeout(() => {
			sendingShown = true;
		}, SENDING_SHOW_MS);
		return () => clearTimeout(timer);
	});
	/** 0–1 across every file of the send in flight, once the link reports it. */
	const uploadFraction = $derived.by(() => {
		if (!upload) return null;
		const total = upload.files.reduce((n, file) => n + file.size, 0);
		return total > 0 ? Math.min(1, upload.loaded / total) : null;
	});
	/** The ring drawn on the send button while files upload. */
	const RING_RADIUS = 8;
	const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
</script>

{#if directStop}
	<button
		type="button"
		class="composer-action stop"
		disabled={!connected}
		aria-label={t.composer.stopGeneration}
		title={t.composer.stopGeneration}
		onclick={() => void onStop()}
	>
		<Icon name="stop" />
	</button>
{/if}
<button
	type="button"
	class="composer-action"
	class:send={primaryAction.kind === 'send'}
	class:stop={primaryAction.kind === 'stop'}
	class:is-sending={primaryAction.kind === 'send' && sendingShown}
	class:steps-aside={stepsAside}
	disabled={primaryAction.disabled}
	aria-busy={primaryAction.kind === 'send' && sendingShown ? 'true' : undefined}
	aria-label={primaryAction.kind === 'stop' ? t.composer.stopGeneration : sendingShown ? t.composer.sending : t.composer.send}
	title={primaryAction.kind === 'stop' ? t.composer.stopGeneration : sendingShown ? t.composer.sending : t.chat.sendHintShortcut}
	onclick={() => primaryAction.kind === 'stop' ? void onStop() : void onSend()}
>
	{#if primaryAction.kind === 'stop'}
		<Icon name="stop" />
	{:else if sendingShown && uploadFraction !== null}
		<svg class="send-progress" aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
			<circle class="send-progress-track" cx="10" cy="10" r={RING_RADIUS} stroke-width="2"></circle>
			<circle
				class="send-progress-fill"
				cx="10"
				cy="10"
				r={RING_RADIUS}
				stroke-width="2"
				stroke-linecap="round"
				stroke-dasharray={RING_LENGTH}
				stroke-dashoffset={RING_LENGTH * (1 - uploadFraction)}
			></circle>
		</svg>
	{:else if sendingShown}
		<Icon name="spinner" class="send-spinner" />
	{:else}
		<Icon name="arrow-up" />
	{/if}
</button>

<style>
	.composer-action {
		width: 34px;
		height: 34px;
		flex: 0 0 34px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 50%;
		margin-bottom: 0;
		transition:
			background-color var(--dur-base) var(--ease-out),
			color var(--dur-base) var(--ease-out),
			transform var(--dur-fast) var(--ease-out);
	}

	.composer-action:active:not(:disabled) {
		transform: scale(0.92);
	}

	/*
	 * Send turning into Stop (and back) swaps the glyph: the new one turns in from a little smaller,
	 * so the change reads as the same button changing its job rather than a different button.
	 */
	.composer-action > :global(.icon:not(.send-spinner)) {
		animation: action-glyph-in var(--dur-base) var(--ease-out);
	}

	@keyframes action-glyph-in {
		from {
			opacity: 0;
			transform: scale(0.55) rotate(-60deg);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.composer-action.send {
		background: var(--accent);
		color: var(--on-accent);
	}

	.composer-action.send:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.composer-action.stop {
		background: var(--ink);
		color: var(--pane);
	}

	.composer-action.stop:hover:not(:disabled) {
		background: var(--ink-secondary);
	}

	.composer-action:disabled {
		background: var(--chip);
		color: var(--muted);
		cursor: not-allowed;
	}

	/* On its way: still the send button, not a composer with nothing to send. */
	.composer-action.is-sending:disabled {
		background: var(--accent);
		color: var(--on-accent);
		cursor: progress;
	}

	.composer-action :global(.send-spinner) {
		animation: suggestSpin 0.9s linear infinite;
	}

	/* Filled clockwise from twelve o'clock. */
	.send-progress {
		transform: rotate(-90deg);
	}

	.send-progress-track {
		stroke: currentColor;
		opacity: 0.35;
	}

	.send-progress-fill {
		stroke: currentColor;
		transition: stroke-dashoffset 0.2s linear;
	}

	.composer-action:focus-visible {
		outline: none;
		box-shadow: var(--focus-ring);
	}

	@keyframes suggestSpin {
		to {
			transform: rotate(360deg);
		}
	}

	@container conversation (max-width: 680px) {
		:global(.composer) .composer-action {
			width: 34px;
			height: 34px;
			flex-basis: 34px;
		}

		@media (pointer: coarse) {
			:global(.composer) .composer-action {
				width: 40px;
				height: 40px;
				flex-basis: 40px;
			}

			/* Stop and send side by side under one thumb: held a little further apart. */
			.composer-action.stop + .composer-action.send {
				margin-left: 4px;
			}
		}

		/* A thumb's row holds no button that does nothing: Stop or ✨ takes the place. */
		:global(.composer) .composer-action.steps-aside {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.composer-action {
			transition: none;
		}

		.composer-action :global(.send-spinner) {
			animation: none;
		}

		.send-progress-fill {
			transition: none;
		}
	}
</style>
