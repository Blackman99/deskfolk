<script lang="ts">
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
		<svg class="voice-spinner" aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"></path></svg>
	{:else if listening}
		<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"></rect></svg>
	{:else}
		<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M19 10v1a7 7 0 0 1-14 0v-1"></path><line x1="12" y1="18" x2="12" y2="22"></line></svg>
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

	.voice-spinner {
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

		.voice-spinner {
			animation: none;
		}
	}
</style>
