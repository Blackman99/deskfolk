<script lang="ts">
	/** The line a message answers, above its text: who said it and how it began; a press goes to it. */
	import type { Message, SessionSummary } from '@real-bot/protocol';
	import type { MessageLookup } from './chat-view.ts';
	import type { Copy } from '../copy.ts';
	import { quotePreview } from './quote-reply.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';

	type Props = {
		message: Message;
		t: Copy;
		runtime: MessengerRuntime;
		selected: SessionSummary | null;
		messageLookup: MessageLookup;
		who: (message: Message) => string;
	};

	let { message, t, runtime, selected, messageLookup, who }: Props = $props();
</script>

{#if message.parent_id}
	{@const quoted = messageLookup.byId.get(message.parent_id)}
	<button
		type="button"
		class="quote-ref"
		onclick={() => quoted && runtime.setHighlightedMessage(quoted.id, selected?.id)}
	>
		<span class="quote-ref-who">{quoted ? who(quoted) : t.top.deleted}</span>
		<span class="quote-ref-body">{quotePreview(quoted?.body ?? '')}</span>
	</button>
{/if}

<style>
	.quote-ref {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		margin: 0 0 8px;
		padding: 6px 10px;
		border: none;
		border-left: 2px solid color-mix(in srgb, currentColor 45%, transparent);
		border-radius: 0 var(--radius-md) var(--radius-md) 0;
		background: color-mix(in srgb, currentColor 8%, transparent);
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.quote-ref-who {
		font-size: 11px;
		font-weight: 650;
		opacity: 0.85;
	}

	.quote-ref-body {
		font-size: 12px;
		line-height: 1.35;
		opacity: 0.72;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
