<script lang="ts">
	import type { BuiltinModelRole, CallRun, TraceStep } from '@real-bot/protocol';
	import { JsonViewer } from 'svelte-json-discovery';
	import type { Copy } from '../copy.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import { themeManager } from '../theme.ts';
	import { answerJson, stepSaid, stepTitle, type TraceStepGroup } from './trace-steps.ts';

	interface Props {
		group: TraceStepGroup;
		t: Copy;
		/** The whole use, the model's answer included; absent where nothing can fetch it. */
		fetchRun?: (id: string) => Promise<CallRun>;
		onJump: (sessionId: string, messageId: string) => void;
		/** Opens the call on the Roles page, where its model and prompts are set. */
		onEditCall?: (role: BuiltinModelRole) => void;
		onClose: () => void;
	}

	let { group, t, fetchRun, onJump, onEditCall, onClose }: Props = $props();

	/** Which use is shown, when the step stands for several; the newest to start with. */
	let picked = $state<string | null>(null);
	const step = $derived<TraceStep>(group.steps.find((row) => row.id === picked) ?? group.steps.at(-1)!);

	let rawOpen = $state(false);
	let raw = $state<{ id: string; text: string | null } | null>(null);
	let rawFailed = $state(false);
	$effect(() => {
		const id = step.id;
		if (!rawOpen || !fetchRun || raw?.id === id) return;
		rawFailed = false;
		fetchRun(id).then(
			(run) => {
				if (step.id === id) raw = { id, text: run.raw };
			},
			() => {
				if (step.id === id) rawFailed = true;
			}
		);
	});

	/** A JSON answer unfolds as a tree, in the app's light or dark rather than the system's. */
	const rawJson = $derived(raw?.text ? answerJson(raw.text) : null);
	let theme = $state(themeManager.resolved);
	$effect(() => themeManager.subscribe(() => (theme = themeManager.resolved)));
</script>

<!-- A panel over the board's right edge, or a sheet over its bottom on a phone (TraceView places it). -->
<section class="trace-step-detail" aria-label={stepTitle(step, t)}>
	<header class="trace-step-detail-head">
		<span class="trace-step-detail-title">{stepTitle(step, t)}</span>
		<span class="trace-step-detail-time mono" title={formatFullTimestamp(step.created_at)}>{formatMessageTime(step.created_at)}</span>
		<button type="button" class="trace-step-detail-close" title={t.traceSteps.close} aria-label={t.traceSteps.close} onclick={onClose}>
			<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
		</button>
	</header>
	{#if group.steps.length > 1}
		<div class="trace-step-uses" role="tablist">
			{#each group.steps as use, index (use.id)}
				<button
					type="button"
					role="tab"
					class="trace-step-use"
					class:is-warn={use.outcome !== 'ok'}
					aria-selected={use.id === step.id}
					title={t.traceSteps.useOf(index + 1, group.steps.length)}
					onclick={() => (picked = use.id)}
				>{index + 1}</button>
			{/each}
		</div>
	{/if}
	<p class="trace-step-detail-said">{stepSaid(step, t)}</p>
	{#if step.outcome !== 'ok' && step.verdict}
		<p class="trace-step-detail-why">{t.traceSteps.failed(step.fail_kind)}</p>
	{/if}
	<div class="trace-step-chips">
		{#if step.model}
			<span class="trace-step-chip mono" title={t.traceSteps.model}>{step.model}</span>
		{/if}
		{#if step.thinking_level}
			<span class="trace-step-chip" title={t.traceSteps.thinking}>{t.traceSteps.thinking} {step.thinking_level}</span>
		{/if}
		{#if step.prompt_id}
			<span class="trace-step-chip" title={step.prompt_id}>{t.traceSteps.prompt} · {step.prompt_revision ? t.traceSteps.promptEdited : t.traceSteps.promptDefault}</span>
		{/if}
		{#if step.ms !== null}
			<span class="trace-step-chip mono">{t.traceSteps.took(step.ms)}</span>
		{/if}
	</div>
	{#if step.cached}
		<p class="trace-step-detail-note">{t.traceSteps.cached}</p>
	{/if}
	{#if fetchRun && !step.cached}
		<details class="trace-step-raw" bind:open={rawOpen}>
			<summary>{t.traceSteps.raw}</summary>
			{#if rawFailed}
				<p class="trace-step-detail-note">{t.traceSteps.rawFailed}</p>
			{:else if raw?.id !== step.id}
				<p class="trace-step-detail-note">{t.traceSteps.rawLoading}</p>
			{:else if rawJson}
				<div class="trace-step-json"><JsonViewer data={rawJson} expanded={2} {theme} /></div>
			{:else if raw.text}
				<pre class="mono">{raw.text}</pre>
			{:else}
				<p class="trace-step-detail-note">{t.traceSteps.rawNone}</p>
			{/if}
		</details>
	{/if}
	<div class="trace-step-actions">
		{#if step.message_id && step.session_id}
			<button type="button" onclick={() => onJump(step.session_id!, step.message_id!)}>{t.traceSteps.jump}</button>
		{/if}
		{#if onEditCall}
			<button type="button" data-edit-call={step.role} onclick={() => onEditCall(step.role)}>{t.traceSteps.edit}</button>
		{/if}
	</div>
</section>

<style>
	/*
	 * Over the board's right edge, from the top down to the tools at most, scrolling inside. On a
	 * narrow board a sheet over the bottom of a set height, so opening it moves its card once and
	 * an answer arriving does not cover the card again.
	 */
	.trace-step-detail {
		position: absolute;
		z-index: 2;
		top: 10px;
		right: 10px;
		width: var(--trace-panel-width, 400px);
		max-height: calc(100% - 56px);
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px;
		overflow-y: auto;
		overscroll-behavior: contain;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-lg);
		font-size: 12px;
	}

	@container trace (max-width: 560px) {
		.trace-step-detail {
			top: auto;
			right: 0;
			bottom: 0;
			left: 0;
			width: auto;
			height: 60%;
			max-height: none;
			padding-bottom: calc(10px + env(safe-area-inset-bottom));
			border-width: 1px 0 0;
			border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		}
	}

	.trace-step-detail-head {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.trace-step-detail-title {
		flex: 1;
		min-width: 0;
		font-weight: 600;
	}

	.trace-step-detail-time {
		color: var(--muted);
		font-size: 11px;
	}

	.trace-step-detail-close {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.trace-step-detail-close:hover {
		background: var(--line-subtle);
		color: var(--text);
	}

	.trace-step-uses {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.trace-step-use {
		min-width: 22px;
		padding: 1px 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		font-size: 11px;
		cursor: pointer;
	}

	.trace-step-use[aria-selected='true'] {
		border-color: var(--accent);
		color: var(--text);
	}

	.trace-step-use.is-warn {
		border-color: var(--warn);
	}

	.trace-step-detail-said {
		margin: 0;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.trace-step-detail-why {
		margin: 0;
		color: var(--warn);
	}

	.trace-step-detail-note {
		margin: 0;
		color: var(--muted);
		font-size: 11px;
	}

	.trace-step-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.trace-step-chip {
		max-width: 100%;
		overflow: hidden;
		padding: 1px 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--muted);
		font-size: 11px;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.trace-step-raw summary {
		color: var(--muted);
		font-size: 11px;
		cursor: pointer;
	}

	.trace-step-raw pre {
		margin: 4px 0 0;
		padding: 6px 8px;
		overflow: auto;
		border-radius: var(--radius-sm);
		background: var(--chip);
		font-size: 11px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* The tree keeps its own colours; its surface, font and size are the pane's, as the text's are. */
	.trace-step-json {
		--discovery-monospace-font-family: var(--mono);
		--discovery-monospace-font-size: 11px;
	}

	.trace-step-json :global(.view-struct) {
		margin: 4px 0 0;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		background: var(--chip);
	}

	/*
	 * Nothing scrolls sideways, inside a panel that scrolls down: a string wraps under its key, a
	 * line still too long breaks where it must, and a folded value stays the one line it is, cut
	 * at the edge, until it is unfolded.
	 */
	.trace-step-json :global(.view-struct .entry-line) {
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.trace-step-json :global(.view-struct .value:not(.struct-expand-value) > .string) {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.trace-step-json :global(.view-struct .struct-expand-value) {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.trace-step-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.trace-step-actions button {
		padding: 3px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--accent);
		font-size: 11px;
		cursor: pointer;
	}

	.trace-step-actions button:hover {
		background: var(--accent-tint);
	}
</style>
