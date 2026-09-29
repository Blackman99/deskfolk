<script lang="ts">
	import type { ActivityCopy, TurnSteps } from './turn-activity.ts';

	interface Props {
		id: string;
		/** The Bot whose turn this is. */
		name: string;
		steps: TurnSteps;
		copy: ActivityCopy;
		/** What a command has printed, while this conversation is the one watching it. */
		outputOf?: (callId: string) => string | null;
		isUser?: boolean;
		onClose: () => void;
	}

	let { id, name, steps, copy, outputOf, isUser = false, onClose }: Props = $props();

	const total = $derived(steps.rows.length + steps.dropped);
	/** A finished command's output opens on demand; the running one shows it as it goes. */
	let opened = $state<string | null>(null);

	/** Follow the end of the list and of a running command's output, the way a terminal does. */
	function pin(node: HTMLElement, _changed: unknown) {
		const stick = () => {
			node.scrollTop = node.scrollHeight;
		};
		stick();
		return { update: stick };
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="turn-steps"
	class:is-user={isUser}
	{id}
	role="region"
	aria-label={copy.stepsTitle(name, total)}
	onkeydown={(event) => {
		if (event.key !== 'Escape') return;
		event.stopPropagation();
		onClose();
	}}
>
	<div class="turn-steps-head">{copy.stepsTitle(name, total)}</div>
	{#if steps.missedStart}
		<p class="turn-steps-note">{copy.missedStart}</p>
	{/if}
	{#if steps.dropped}
		<p class="turn-steps-note">{copy.dropped(steps.dropped)}</p>
	{/if}
	<ol class="turn-steps-list" use:pin={steps.rows.length}>
		{#each steps.rows as row (row.id)}
			{@const output = row.shell && outputOf ? outputOf(row.id) : null}
			<li class="turn-step is-{row.state}">
				<span class="turn-step-mark" aria-hidden="true">
					{#if row.state === 'running'}<span class="turn-step-pulse"></span>{:else if row.state === 'failed'}✕{:else}✓{/if}
				</span>
				<span class="turn-step-text">{row.text}</span>
				<span class="turn-step-meta mono">
					{#if row.exitCode !== null}<span class="turn-step-exit">{copy.exit(row.exitCode)}</span>{/if}
					{#if row.time}<span>{row.time}</span>{/if}
				</span>
				{#if output && row.state !== 'running'}
					<button
						type="button"
						class="turn-step-output-toggle"
						aria-expanded={opened === row.id}
						onclick={() => (opened = opened === row.id ? null : row.id)}
					>{copy.output}</button>
				{/if}
				{#if output && (row.state === 'running' || opened === row.id)}
					<pre class="turn-step-output mono" use:pin={output}>{output}</pre>
				{/if}
			</li>
		{/each}
	</ol>
</div>

<style>
	.turn-steps {
		box-sizing: border-box;
		width: min(560px, 100%);
		margin-top: 6px;
		padding: 8px 10px 9px;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		box-shadow: 0 2px 6px rgba(18, 28, 32, 0.06);
		font-size: 12px;
		color: var(--ink);
		animation: stepsIn 0.16s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.turn-steps.is-user {
		align-self: flex-end;
	}

	.turn-steps-head {
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
		margin-bottom: 6px;
	}

	.turn-steps-note {
		margin: 0 0 6px;
		font-size: 11px;
		color: var(--muted);
	}

	.turn-steps-list {
		/* A dozen rows: enough to see where it has been, not a log viewer pushing the transcript away. */
		max-height: 18em;
		margin: 0;
		padding: 0;
		overflow: auto;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.turn-step {
		display: grid;
		grid-template-columns: 14px minmax(0, 1fr) auto;
		column-gap: 6px;
		align-items: baseline;
		line-height: 1.45;
	}

	.turn-step-mark {
		font-size: 10px;
		color: var(--muted);
		text-align: center;
	}

	.turn-step.is-failed .turn-step-mark,
	.turn-step-exit {
		color: var(--danger);
	}

	.turn-step-pulse {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 4px var(--accent-glow);
		animation: stepPulse 1.2s ease-in-out infinite;
	}

	.turn-step-text {
		min-width: 0;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.turn-step.is-done .turn-step-text {
		color: var(--ink-secondary);
	}

	.turn-step-meta {
		display: inline-flex;
		gap: 6px;
		font-size: 11px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.turn-step-output-toggle {
		grid-column: 2 / -1;
		justify-self: start;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 11px;
		text-decoration: underline dotted;
		cursor: pointer;
	}

	.turn-step-output-toggle:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.turn-step-output {
		grid-column: 2 / -1;
		max-height: 11em;
		margin: 3px 0 2px;
		padding: 6px 8px;
		overflow: auto;
		border-radius: var(--radius-sm);
		/* The same as a command's output under its message (CommandActivity.svelte). */
		background: var(--surface-sunken, rgba(128, 128, 128, 0.1));
		color: var(--muted);
		font-size: 11px;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
	}

	@keyframes stepPulse {
		0%, 100% { opacity: 0.3; }
		50% { opacity: 1; }
	}

	@keyframes stepsIn {
		from { opacity: 0; transform: translateY(-2px); }
		to { opacity: 1; transform: translateY(0); }
	}

	@media (prefers-reduced-motion: reduce) {
		.turn-steps,
		.turn-step-pulse {
			animation: none;
		}
	}
</style>
