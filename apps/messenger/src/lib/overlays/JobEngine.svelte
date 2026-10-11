<script lang="ts">
	import type { Copy } from '../copy.ts';
	import type { JobEngineWhy } from './job-engine.ts';

	/**
	 * The app's own share of the job (ADR 0086): the engine its calls run under (ADR 0085), why it is
	 * that one, the steps it leaves off and how many conversations run it, and the way to Roles to
	 * change it.
	 */
	interface Props {
		name: string;
		why: JobEngineWhy;
		/** The steps it switches off, named. */
		off: readonly string[];
		sessions: number;
		t: Copy;
		onOpen?: () => void;
	}

	let { name, why, off, sessions, t, onOpen }: Props = $props();

	const c = $derived(t.plan.job.engine);
</script>

<section class="job-engine" aria-label={c.title}>
	<h4 class="job-block-title">{c.title}</h4>
	<div class="job-engine-line">
		<span class="job-engine-chip">{c.chip(name)}</span>
		<span class="job-engine-why">{c[why]}</span>
	</div>
	<p class="job-block-note">{off.length > 0 ? c.off(off.join('、')) : c.allOn} · {c.sessions(sessions)}</p>
	{#if onOpen}
		<button type="button" class="job-engine-open" onclick={onOpen}>{c.open}</button>
	{/if}
</section>

<style>
	.job-engine {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 5px;
		min-width: 0;
	}

	.job-block-title {
		margin: 0;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.02em;
		color: var(--muted);
	}

	.job-engine-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		font-size: 12px;
	}

	.job-engine-chip {
		padding: 1px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		font-weight: 600;
		color: var(--ink);
	}

	.job-engine-why {
		color: var(--muted);
	}

	.job-block-note {
		margin: 0;
		font-size: 11px;
		line-height: 1.45;
		color: var(--muted);
	}

	.job-engine-open {
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}

	.job-engine-open:hover {
		text-decoration: underline;
	}
</style>
