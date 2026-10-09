<script lang="ts">
	import type { ModelSource } from './model-source.ts';
	import ConnectorLogo from './settings/ConnectorLogo.svelte';
	import ClaudeSpark from './settings/ClaudeSpark.svelte';

	/** Where a model comes from, in front of its name in a picker (see `model-source.ts`). */
	type Props = { source: ModelSource };
	let { source }: Props = $props();
</script>

<span class="model-source is-{source.kind}" title={source.name} aria-hidden="true" data-model-source={source.kind === 'connector' ? source.id : source.kind}>
	{#if source.kind === 'connector'}
		<ConnectorLogo id={source.id} size={16} />
	{:else if source.kind === 'claude-agent'}
		<ClaudeSpark size={14} />
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
