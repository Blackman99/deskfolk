<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { ComposerVoice } from './composer-voice.svelte.ts';
	import { formatClock } from './voice-recorder.ts';

	/** Above the box while the microphone is on or its text is coming, and what went wrong if it did (ADR 0073). */
	type Props = {
		voice: ComposerVoice;
		t: Copy;
	};

	let { voice, t }: Props = $props();
</script>

{#if voice.phase !== 'idle'}
	<div class="voice-status" role="status" data-voice-status={voice.phase}>
		{#if voice.phase === 'transcribing'}
			<span class="voice-status-text">{t.speech.transcribing}</span>
		{:else}
			<span class="voice-dot" aria-hidden="true"></span>
			<span class="voice-status-text">{t.speech.recording(formatClock(voice.seconds))}</span>
		{/if}
		<button type="button" class="voice-status-act" onclick={() => voice.cancel()}>{t.speech.micCancel}</button>
	</div>
{:else if voice.notice}
	<div class="voice-status is-notice" role="alert" data-voice-notice>
		<span class="voice-status-text">{voice.notice}</span>
		<button type="button" class="voice-status-act" onclick={() => voice.dismiss()}>{t.speech.dismiss}</button>
	</div>
{/if}

<style>
	.voice-status {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 4px 6px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--ink-secondary);
		min-width: 0;
	}

	.voice-status.is-notice {
		color: var(--warn-text);
	}

	.voice-status-text {
		flex: 1;
		min-width: 0;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	.voice-dot {
		flex-shrink: 0;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--danger);
		animation: voicePulse 1.2s ease-in-out infinite;
	}

	@keyframes voicePulse {
		50% {
			opacity: 0.35;
		}
	}

	.voice-status-act {
		flex-shrink: 0;
		padding: 2px 8px;
		border-radius: var(--radius-sm);
		font-size: 12px;
		font-weight: 500;
		color: var(--ink-secondary);
	}

	.voice-status-act:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.voice-status-act:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	@media (prefers-reduced-motion: reduce) {
		.voice-dot {
			animation: none;
		}
	}
</style>
