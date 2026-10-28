<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { stepSaid, stepTitle, type TraceStepGroup } from './trace-steps.ts';

	interface Props {
		group: TraceStepGroup;
		t: Copy;
		open: boolean;
		lit: boolean;
		dim: boolean;
		onToggle: () => void;
	}

	let { group, t, open, lit, dim, onToggle }: Props = $props();

	/** The newest use says what the step stands at; the count says how many there were. */
	const step = $derived(group.steps.at(-1)!);
</script>

<!--
	One of the app's own calls (ADR 0083): smaller than a turn's card, its conclusion on one line, and
	slanted, so the app's own work reads apart from the Bots' boxes and your lines.
-->
<button
	type="button"
	class="trace-step is-{step.outcome}"
	class:is-anomalous={group.anomalous}
	class:is-open={open}
	class:is-lit={lit}
	class:is-dim={dim}
	data-step={group.id}
	data-role={step.role}
	aria-expanded={open}
	title={stepSaid(step, t)}
	onclick={onToggle}
>
	<span class="trace-step-shape" aria-hidden="true"><span class="trace-step-outline"></span></span>
	<span class="trace-step-head">
		<span class="trace-step-dot" aria-hidden="true"></span>
		<span class="trace-step-title">{stepTitle(step, t)}</span>
		{#if group.steps.length > 1}
			<span class="trace-step-count mono">{t.traceSteps.times(group.steps.length)}</span>
		{/if}
	</span>
	<span class="trace-step-said">{stepSaid(step, t)}</span>
	{#if step.outcome !== 'ok' && step.verdict}
		<!-- Read all the same, by the word lists: the reading stands, and why the model's did not. -->
		<span class="trace-step-why">{t.traceSteps.failed(step.fail_kind)}</span>
	{/if}
</button>

<style>
	.trace-step {
		--slant: 8px;
		--step-edge: var(--line);
		--step-fill: var(--pane);
		position: relative;
		isolation: isolate;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		width: 100%;
		padding: 6px calc(var(--slant) + 7px);
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
		transition: opacity 0.15s ease;
	}

	/* A slanted outline is cut, and a cut box loses its border: the outline is a layer under the text,
	   inside one that is not cut, so a ring drawn round it is not cut away with it. */
	.trace-step-shape {
		position: absolute;
		inset: 0;
		z-index: -1;
	}

	.trace-step-outline,
	.trace-step-outline::after {
		position: absolute;
		clip-path: polygon(var(--slant) 0, 100% 0, calc(100% - var(--slant)) 100%, 0 100%);
	}

	.trace-step-outline {
		inset: 0;
		background: var(--step-edge);
	}

	/* On the board's own colour: the warning fill is a wash in the dark, and the edge would show through. */
	.trace-step-outline::after {
		content: '';
		inset: 1px;
		background: linear-gradient(var(--step-fill), var(--step-fill)), var(--pane);
	}

	.trace-step:hover {
		--step-fill: var(--line-subtle);
	}

	.trace-step.is-open {
		--step-edge: var(--accent);
	}

	.trace-step.is-anomalous {
		--step-edge: var(--warn);
		--step-fill: var(--warn-bg);
	}

	/* A ring the outline's shape: four shadows of it. */
	.trace-step.is-lit .trace-step-shape {
		filter: drop-shadow(2px 0 0 var(--warn)) drop-shadow(-2px 0 0 var(--warn)) drop-shadow(0 2px 0 var(--warn))
			drop-shadow(0 -2px 0 var(--warn));
	}

	.trace-step.is-dim {
		opacity: 0.32;
	}

	.trace-step-head {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-width: 0;
	}

	.trace-step-dot {
		width: 6px;
		height: 6px;
		flex: none;
		border-radius: var(--radius-full);
		background: var(--ok);
	}

	.trace-step.is-failed .trace-step-dot,
	.trace-step.is-unreadable .trace-step-dot,
	.trace-step.is-anomalous .trace-step-dot {
		background: var(--warn);
	}

	.trace-step-title {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		color: var(--muted);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.02em;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.trace-step-count {
		flex: none;
		color: var(--muted);
		font-size: 10px;
	}

	.trace-step-said {
		display: -webkit-box;
		width: 100%;
		overflow: hidden;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		font-size: 12px;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.trace-step-why {
		color: var(--warn-text);
		font-size: 11px;
	}
</style>
