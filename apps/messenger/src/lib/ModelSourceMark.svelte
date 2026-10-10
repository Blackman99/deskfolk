<script lang="ts">
	import type { ModelSource } from './model-source.ts';
	import ConnectorLogo from './settings/ConnectorLogo.svelte';
	import ClaudeSpark from './settings/ClaudeSpark.svelte';
	import AgentLogo from './settings/AgentLogo.svelte';

	/** Where a model comes from, or whose a speech service is, in front of its name in a picker (see `model-source.ts`). */
	type Props = {
		source: ModelSource;
		/** Where marks stand in a column of sources (the model picker's): an endpoint of no known vendor as a plain tile, not the word "Custom", so the names line up. */
		tile?: boolean;
	};
	let { source, tile = false }: Props = $props();
</script>

<span class="model-source is-{source.kind}" title={source.name} aria-hidden="true" data-model-source={source.kind === 'connector' || source.kind === 'vendor' ? source.id : source.kind} data-runner={source.kind === 'agent' ? source.runner : undefined}>
	{#if source.kind === 'connector' || source.kind === 'vendor'}
		<ConnectorLogo id={source.id} size={16} />
	{:else if source.kind === 'claude-agent' && tile}
		<AgentLogo runner="claude_code" size={16} />
	{:else if source.kind === 'claude-agent'}
		<ClaudeSpark size={14} />
	{:else if source.kind === 'agent'}
		<AgentLogo runner={source.runner} size={16} />
	{:else if tile}
		<span class="model-source-tile">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><line x1="7" y1="7.5" x2="7.01" y2="7.5"></line><line x1="7" y1="16.5" x2="7.01" y2="16.5"></line></svg>
		</span>
	{:else}
		<!-- Drawn, not written: an option's text stays the model's name, for type-to-find and copying. -->
		<span class="model-source-custom" data-text={source.name}></span>
	{/if}
</span>

<style>
	.model-source {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 16px;
		height: 16px;
	}

	/* An endpoint of no known vendor in a column of logos: a quiet tile the logos' size. */
	.model-source-tile {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--connector-logo-size, 16px);
		height: var(--connector-logo-size, 16px);
		box-sizing: border-box;
		padding: calc(var(--connector-logo-size, 16px) * 0.16);
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink-secondary);
	}

	.model-source-tile svg {
		width: 100%;
		height: 100%;
	}

	/* A word, not a logo: as quiet as a chip, so the vendors' marks stay what stands out. */
	.model-source-custom {
		display: inline-flex;
		align-items: center;
		height: 16px;
		padding: 0 4px;
		box-sizing: border-box;
		border: 1px solid var(--chip-line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink-secondary);
		font-family: var(--font);
		font-size: 10px;
		font-weight: 600;
		line-height: 1;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.model-source-custom::before {
		content: attr(data-text);
	}
</style>
