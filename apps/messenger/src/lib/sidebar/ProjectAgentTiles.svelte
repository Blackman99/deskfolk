<script lang="ts">
	import type { ProjectAgent } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import AgentLogo from '../settings/AgentLogo.svelte';

	/**
	 * Which agent a project session is of (ADR 0095): one tile per agent, its mark and name, the
	 * picked one lit. The new and import sheet's head, and the first-launch wizard's carry-on step.
	 */
	type Props = {
		t: Copy;
		agents: readonly ProjectAgent[];
		agent: ProjectAgent;
		onpick: (agent: ProjectAgent) => void;
	};

	let { t, agents, agent, onpick }: Props = $props();
</script>

<div class="agent-tiles" role="radiogroup" aria-label={t.project.agentHead}>
	{#each agents as each (each)}
		<button
			type="button"
			class="agent-tile"
			class:active={agent === each}
			role="radio"
			aria-checked={agent === each}
			data-project-agent={each}
			onclick={() => onpick(each)}
		>
			<AgentLogo runner={each} size={20} />
			<span>{t.project.agentNames[each]}</span>
		</button>
	{/each}
</div>

<style>
	.agent-tiles {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.agent-tile {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 6px 14px 6px 8px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
	}

	.agent-tile:hover {
		background: var(--row-hover);
	}

	.agent-tile.active {
		border-color: var(--accent);
		background: var(--accent-tint);
	}

	@media (max-width: 680px) {
		.agent-tile {
			min-height: 44px;
		}
	}
</style>
