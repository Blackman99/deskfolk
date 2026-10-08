<script lang="ts">
	/** A message's reactions under it, one chip per emoji; on your own lines they keep to the right. */
	import { USER_MEMBER, type Message } from '@real-bot/protocol';
	import { groupReactions } from './chat-view.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';

	type Props = {
		message: Message;
		runtime: MessengerRuntime;
		lockedComposer: boolean;
		/** Your own line's: the row keeps to the right, under the bubble. */
		right?: boolean;
	};

	let { message, runtime, lockedComposer, right = false }: Props = $props();

	const rxGroups = $derived(groupReactions(message.reactions, USER_MEMBER));
</script>

{#if rxGroups.length > 0}
	<div class={right ? 'rx-row is-right flex flex-wrap gap-2 mt-2' : 'rx-row flex flex-wrap gap-2 mt-2'}>
		{#each rxGroups as rx}
			{#if lockedComposer}
				<span class="rx-chip is-static" class:is-active={rx.userReacted}>
					<span class="rx-emoji">{rx.emoji}</span>
					<span class="rx-count mono text-11 font-semibold">{rx.count}</span>
				</span>
			{:else}
				<button
					type="button"
					class="rx-chip"
					class:is-active={rx.userReacted}
					onclick={() => void runtime.toggleReaction(message.id, rx.emoji)}
				>
					<span class="rx-emoji">{rx.emoji}</span>
					<span class="rx-count mono text-11 font-semibold">{rx.count}</span>
				</button>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.rx-row.is-right {
		justify-content: flex-end;
	}

	.rx-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 12px;
		background: var(--reaction-bg);
		border: 1px solid var(--line);
		box-shadow: 0 1px 2px rgba(18, 28, 32, 0.04);
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.rx-chip:hover {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.rx-chip.is-active {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}
</style>
