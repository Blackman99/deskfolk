<script lang="ts">
	import type { AgentRunTask } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import type { Copy } from '../copy.ts';

	/**
	 * The way into a project session's subagent (ADR 0095, 25), under the line of the turn that sent
	 * it, as a Bot↔Bot direct's is under the line that opened it (`BotDmEntry`): a chip with who it is
	 * and, while it works, that it does; several, a card of chips. It opens as a popup.
	 */
	type Props = {
		t: Copy;
		tasks: readonly AgentRunTask[];
		onOpen: (task: AgentRunTask) => void;
	};

	let { t, tasks, onOpen }: Props = $props();

	const nameOf = (task: AgentRunTask) => task.description || task.agent_type || t.project.taskDoing.subagent;
	/** How it went, when that is worth a word: a chip that says nothing finished as it should. */
	const noteOf = (task: AgentRunTask) => (task.status === 'running' || task.status === 'completed' ? null : t.project.taskStatus[task.status]);
</script>

{#snippet chip(task: AgentRunTask, single: boolean)}
	<button type="button" class="subagent-chip" class:is-plain={single} title={nameOf(task)} data-subagent={task.id} data-subagent-status={task.status} onclick={() => onOpen(task)}>
		<Icon name="bot" size={16} />
		<span class="subagent-name">{nameOf(task)}</span>
		{#if !single && task.status === 'running'}<span class="subagent-live" aria-hidden="true"></span>{/if}
		{#if !single && noteOf(task)}<span class="subagent-note">{noteOf(task)}</span>{/if}
	</button>
{/snippet}

{#if tasks.length === 1}
	{@const task = tasks[0]!}
	<div class="subagent-block">
		<div class="subagent-card is-single">
			{@render chip(task, true)}
			{#if task.status === 'running'}
				<span class="subagent-live" aria-hidden="true"></span>
				<span class="subagent-note">{t.project.taskStatus.running}</span>
			{:else if noteOf(task)}
				<span class="subagent-note">{noteOf(task)}</span>
			{/if}
		</div>
	</div>
{:else if tasks.length > 1}
	<div class="subagent-block">
		<div class="subagent-card is-multiple">
			<div class="subagent-head">
				<Icon name="bot" size={12} />
				<span>{t.project.subagentsOpened}</span>
				<span class="subagent-count mono">{tasks.length}</span>
			</div>
			<div class="subagent-roster">
				{#each tasks as task (task.id)}
					{@render chip(task, false)}
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.subagent-block {
		display: flex;
		flex-wrap: wrap;
		align-self: stretch;
		margin-top: 8px;
	}

	.subagent-card {
		box-sizing: border-box;
		max-width: 100%;
		background: var(--pane);
		border: 1px solid var(--line);
		animation: subagentIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.subagent-card.is-single {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		padding: 3px 10px 3px 6px;
		border-radius: var(--radius-full);
		box-shadow: 0 1px 3px rgba(18, 28, 32, 0.05);
		font-size: 12px;
		line-height: 1;
	}

	.subagent-card.is-multiple {
		display: inline-flex;
		flex-direction: column;
		gap: 7px;
		padding: 7px 10px 9px;
		border-radius: var(--radius-lg);
		box-shadow: 0 2px 6px rgba(18, 28, 32, 0.06);
	}

	.subagent-head {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 12px;
		font-weight: 500;
		line-height: 1;
		color: var(--muted);
		user-select: none;
	}

	.subagent-count {
		padding: 1px 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		font-size: 10px;
		font-weight: 600;
		line-height: 1.2;
	}

	.subagent-roster {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 5px;
	}

	.subagent-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		max-width: 100%;
		padding: 2.5px 8px 2.5px 5px;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--bg);
		color: var(--ink);
		font: inherit;
		font-size: 12px;
		line-height: 1;
		cursor: pointer;
		user-select: none;
		transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
	}

	.subagent-chip :global(svg) {
		flex-shrink: 0;
		color: var(--muted);
	}

	.subagent-chip.is-plain {
		padding: 0;
		border: 0;
		background: transparent;
	}

	.subagent-chip:not(.is-plain):hover {
		background: var(--line-hover);
		border-color: var(--muted-light);
		transform: translateY(-0.5px);
	}

	.subagent-chip.is-plain:hover .subagent-name {
		color: var(--accent);
	}

	.subagent-chip:focus-visible {
		border-radius: var(--radius-full);
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.subagent-name {
		min-width: 0;
		max-width: 240px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		/* Tight enough to sit in its chip; clipped any tighter, a g or a p loses its tail. */
		line-height: 1.35;
		font-weight: 500;
	}

	.subagent-note {
		flex-shrink: 0;
		color: var(--muted);
		white-space: nowrap;
	}

	.subagent-live {
		flex-shrink: 0;
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 4px var(--accent-glow);
	}

	@media (prefers-reduced-motion: reduce) {
		.subagent-card {
			animation: none;
		}
	}

	@keyframes subagentIn {
		from {
			opacity: 0;
			transform: translateY(3px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
