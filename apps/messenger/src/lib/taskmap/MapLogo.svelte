<script lang="ts">
	import type { ModelSource } from '../model-source.ts';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import ConnectorLogo from '../settings/ConnectorLogo.svelte';

	/**
	 * Whose model a character works on, at the map's sizes (ADR 0097): an endpoint's vendor, Claude
	 * Agent's spark on its tile, a local agent's logo; an endpoint of no known vendor gets the plain
	 * tile a custom agent has, never another vendor's mark.
	 */
	type Props = { source: ModelSource; size: number };
	let { source, size }: Props = $props();
</script>

{#if source.kind === 'connector' || source.kind === 'vendor'}
	<ConnectorLogo id={source.id} {size} />
{:else if source.kind === 'claude-agent'}
	<AgentLogo runner="claude_code" {size} />
{:else if source.kind === 'agent'}
	<AgentLogo runner={source.runner} {size} />
{:else}
	<AgentLogo runner="custom" {size} />
{/if}
