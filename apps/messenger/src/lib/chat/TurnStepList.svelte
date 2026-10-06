<script lang="ts">
	import type { StepRow } from './turn-activity.ts';
	import { commandOutput } from './command-output.ts';

	/**
	 * What a working message's last line opens onto: the steps going on now, each said whole, and
	 * what a running command is printing as it prints it.
	 */
	interface Props {
		id: string;
		/** Who is doing it, and how many things: the list's heading and its region name. */
		title: string;
		rows: StepRow[];
		/** What a command has printed, while this conversation is the one watching it. */
		outputOf?: (callId: string) => string | null;
		onClose: () => void;
	}

	let { id, title, rows, outputOf, onClose }: Props = $props();

	/** Follow the end of the list, the way a terminal does. */
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
	{id}
	role="region"
	aria-label={title}
	onkeydown={(event) => {
		if (event.key !== 'Escape') return;
		event.stopPropagation();
		onClose();
	}}
>
	<div class="turn-steps-head">{title}</div>
	<ol class="turn-steps-list" use:pin={rows.length}>
		{#each rows as row (row.id)}
			{@const output = row.shell && outputOf ? outputOf(row.id) : null}
			<li class="turn-step">
				<span class="turn-step-mark" aria-hidden="true"><span class="turn-step-pulse"></span></span>
				<span class="turn-step-text">{row.text}</span>
				<span class="turn-step-meta mono">
					{#if row.time}<span>{row.time}</span>{/if}
				</span>
				{#if output}
					<pre class="turn-step-output code-out mono" use:commandOutput={{ text: output, command: null, live: true }}></pre>
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

	.turn-steps-head {
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
		margin-bottom: 6px;
	}

	.turn-steps-list {
		/* Steps side by side are few; a running command's output scrolls inside its own box. */
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

	.turn-step-meta {
		display: inline-flex;
		gap: 6px;
		font-size: 11px;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.turn-step-output {
		grid-column: 2 / -1;
		max-height: 11em;
		margin: 3px 0 2px;
		padding: 6px 8px;
		overflow: auto;
		border-radius: var(--radius-sm);
		/* The same as a command's output under its message (CommandActivity.svelte). */
		background: var(--chip);
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
