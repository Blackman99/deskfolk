<script lang="ts">
	import { USER_MEMBER, type Bot, type Message } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import { quotePreview, quotedBotName } from './quote-reply.ts';

	type Props = {
		message: Message;
		t: Copy;
		botsById: Map<string, Bot>;
		onCancel: () => void;
	};

	let { message: quoteTarget, t, botsById, onCancel }: Props = $props();

	function quoteLabel(message: Message): string {
		if (message.author === USER_MEMBER) return t.chat.replyToYou;
		const name = quotedBotName(message, botsById);
		return name ? t.chat.replyTo(name) : t.chat.replyToDeleted;
	}
</script>

<div class="composer-quote-bar">
	<div class="composer-quote-meta min-w-0 flex-1 flex flex-col gap-1">
		<span class="composer-quote-who">{quoteLabel(quoteTarget)}</span>
		<span class="composer-quote-body text-12 text-muted overflow-hidden text-ellipsis whitespace-nowrap">{quotePreview(quoteTarget.body)}</span>
	</div>
	<button
		type="button"
		class="composer-quote-cancel"
		title={t.chat.cancelReply}
		aria-label={t.chat.cancelReply}
		onclick={onCancel}
	>
		<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
	</button>
</div>

<style>
	.composer-quote-bar {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 8px 10px 8px 12px;
		margin: 0 0 4px;
		border-bottom: 1px solid var(--line-subtle);
		border-left: 2px solid var(--accent);
	}

	.composer-quote-who {
		font-size: 12px;
		font-weight: 650;
		color: var(--accent);
	}

	.composer-quote-cancel {
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.composer-quote-cancel:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}
</style>
