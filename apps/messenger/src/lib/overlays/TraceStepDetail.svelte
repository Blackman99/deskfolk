<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Snippet } from 'svelte';
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
		/** The call itself — its model and prompts — to change here; the host renders it. */
		callEditor?: Snippet<[BuiltinModelRole]>;
		onClose: () => void;
	}

	let { group, t, fetchRun, onJump, callEditor, onClose }: Props = $props();

	/** The call's settings unfolded under the step; they stay unfolded from step to step. */
	let editing = $state(false);
	let panelEl = $state<HTMLElement>();
	let callEl = $state<HTMLElement>();

	/**
	 * Unfolded, the panel scrolls to the call's settings. They load in after the press (the editor,
	 * then the prompts), so it keeps them at its top while they grow, until your own wheel or touch.
	 */
	$effect(() => {
		const panel = panelEl;
		const call = callEl;
		if (!editing || !panel || !call) return;
		const align = () => (panel.scrollTop = call.offsetTop - 10);
		align();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(align);
		observer.observe(call);
		const stop = () => observer.disconnect();
		const timer = setTimeout(stop, 1500);
		panel.addEventListener('wheel', stop, { passive: true });
		panel.addEventListener('touchstart', stop, { passive: true });
		return () => {
			stop();
			clearTimeout(timer);
			panel.removeEventListener('wheel', stop);
			panel.removeEventListener('touchstart', stop);
		};
	});

	/** Which use is shown, when the step stands for several; the newest to start with. */
	let picked = $state<string | null>(null);
	const step = $derived<TraceStep>(group.steps.find((row) => row.id === picked) ?? group.steps.at(-1)!);

	/** Open from the start: the panel has the room. Folded, it stays folded from step to step. */
	let rawOpen = $state(true);
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

<!-- The inspector beside the board, or its sheet over the board's bottom on a narrow job (JobLayout places it). -->
<section class="trace-step-detail" aria-label={stepTitle(step, t)} bind:this={panelEl}>
	<header class="trace-step-detail-head">
		<span class="trace-step-detail-title">{stepTitle(step, t)}</span>
		<span class="trace-step-detail-time mono" title={formatFullTimestamp(step.created_at)}>{formatMessageTime(step.created_at)}</span>
		<button type="button" class="trace-step-detail-close" title={t.traceSteps.close} aria-label={t.traceSteps.close} onclick={onClose}>
			<Icon name="x" size={12} />
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
		{#if step.playbook_id}
			<!-- The engine it ran under, and how many times that engine had been changed then (ADR 0085). -->
			<span class="trace-step-chip" data-step-engine={step.playbook_id}>{t.playbooks.inForce(t.playbooks.builtin[step.playbook_id] ?? t.playbooks.custom, step.playbook_revision ?? 0)}</span>
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
		{#if callEditor}
			<button type="button" data-edit-call={step.role} aria-expanded={editing} onclick={() => (editing = !editing)}>
				{editing ? t.traceSteps.editHide : t.traceSteps.edit}
			</button>
		{/if}
	</div>
	{#if editing && callEditor}
		<div class="trace-step-call" bind:this={callEl}>
			<!-- Named here: on a narrow board the call's own card leaves its name to a page head. -->
			<p class="trace-step-detail-note">{t.traceSteps.editNote(t.builtinModels.roles[step.role].name)}</p>
			{@render callEditor(step.role)}
		</div>
	{/if}
</section>

<style>
	/*
	 * The whole of the inspector beside the board (ADR 0086), from its top down, scrolling inside; on
	 * a narrow job the inspector is a sheet over the board's bottom of a set height, so opening it
	 * moves its card once and an answer arriving does not cover the card again.
	 */
	.trace-step-detail {
		flex: 1;
		min-height: 0;
		box-sizing: border-box;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
		overflow-y: auto;
		overscroll-behavior: contain;
		background: var(--pane);
		font-size: 12px;
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
		color: var(--warn-text);
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

	/* The call's own settings, under what this use of it did. */
	.trace-step-call {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--line);
	}
</style>
