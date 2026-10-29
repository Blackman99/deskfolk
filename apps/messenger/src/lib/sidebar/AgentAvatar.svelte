<script lang="ts">
	import type { ProjectAgent } from '@real-bot/protocol';
	import AgentLogo from '../settings/AgentLogo.svelte';
	import type { SessionStatusResult } from './session-status.ts';

	/**
	 * A project session's portrait in the list (ADR 0095): its agent's tile in a Bot avatar's place
	 * and shape, a size smaller — a bright brand tile at a portrait's full size outweighed the row —
	 * with the run's status dot on its corner where a Bot's avatar carries its own.
	 */
	type Props = { agent: ProjectAgent; title: string; status?: SessionStatusResult | null };
	let { agent, title, status = null }: Props = $props();
</script>

<span class="row-avatar size-md layout-single agent-avatar" {title}>
	<AgentLogo runner={agent} size={32} />
	{#if status}
		<span class="avatar-status-dot is-{status.kind}" class:is-busy={status.isBusy}></span>
	{/if}
</span>

<style>
	/*
	 * Four fifths of the row's --avatar-size, centred in the avatar's place and still taking all of
	 * it, so the text and the row's height stay a Bot's, the status dot sits on the tile's corner,
	 * and a phone's larger avatar reaches it.
	 */
	.row-avatar.agent-avatar {
		--agent-logo-size: calc(var(--avatar-size) * 0.8);
		width: var(--agent-logo-size);
		height: var(--agent-logo-size);
		margin-block: calc((var(--avatar-size) - var(--agent-logo-size)) / 2);
		justify-self: center;
	}

	.agent-avatar :global(.agent-logo) {
		border-radius: var(--radius-bot);
	}

	/* The spark is sized by number; here it follows the tile instead. */
	.agent-avatar :global(.claude-spark) {
		width: 100%;
		height: 100%;
	}
</style>
