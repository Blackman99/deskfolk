<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';
	import type { ComposerVoice } from './composer-voice.svelte.ts';

	/** The composer's microphone (ADR 0073): press to record, press again to stop and transcribe. */
	type Props = {
		voice: ComposerVoice;
		t: Copy;
		disabled: boolean;
	};

	let { voice, t, disabled }: Props = $props();

	const listening = $derived(voice.phase === 'recording' || voice.phase === 'starting');
	const label = $derived(listening ? t.speech.micStop : voice.phase === 'transcribing' ? t.speech.transcribing : t.speech.micStart);
</script>

<button
	type="button"
	class="voice-btn"
	class:is-listening={listening}
	title={label}
	aria-label={label}
	aria-pressed={listening}
	aria-busy={voice.phase === 'transcribing' || voice.phase === 'starting' ? true : undefined}
	data-voice-button
	style:--voice-level={voice.level.toFixed(2)}
	disabled={voice.phase === 'transcribing' || (disabled && voice.phase === 'idle')}
	onclick={() => void voice.toggle()}
>
	{#if voice.phase === 'transcribing'}
		<Icon name="spinner" class="voice-spinner" />
	{:else if listening}
		<Icon name="stop" />
	{:else}
		<Icon name="mic" size={20} />
	{/if}
</button>

<style>
	.voice-btn {
		position: relative;
		background: transparent;
		border: none;
		color: var(--muted);
		width: 34px;
		height: 34px;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex: 0 0 34px;
		padding: 0;
		transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
	}

	.voice-btn:hover:not(:disabled) {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.voice-btn:active:not(:disabled) {
		transform: scale(0.96);
	}

	.voice-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.voice-btn[aria-busy='true'] {
		opacity: 1;
		color: var(--accent);
		cursor: progress;
	}

	.voice-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	/* Listening: the button turns to stop, and a ring breathes with how loud it is. */
	.voice-btn.is-listening,
	.voice-btn.is-listening:hover:not(:disabled) {
		color: var(--danger);
		background: var(--danger-bg);
	}

	.voice-btn.is-listening::after {
		content: '';
		position: absolute;
		inset: -2px;
		border-radius: 50%;
		border: 2px solid var(--danger);
		opacity: calc(0.25 + var(--voice-level, 0) * 0.75);
		transform: scale(calc(1 + var(--voice-level, 0) * 0.18));
		transition: transform 0.08s linear, opacity 0.08s linear;
		pointer-events: none;
	}

	.voice-btn :global(.voice-spinner) {
		animation: voiceSpin 0.9s linear infinite;
	}

	@keyframes voiceSpin {
		to {
			transform: rotate(360deg);
		}
	}

	@container conversation (max-width: 680px) {
		@media (pointer: coarse) {
			.voice-btn {
				width: 40px;
				height: 40px;
				flex-basis: 40px;
			}
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.voice-btn,
		.voice-btn.is-listening::after {
			transition: none;
		}

		.voice-btn :global(.voice-spinner) {
			animation: none;
		}
	}
</style>
