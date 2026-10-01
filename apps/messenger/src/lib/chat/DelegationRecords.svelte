<script lang="ts">
	import type { Bot, DelegationView } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import MarkdownBody from '../MarkdownBody.svelte';
	import { formatFullTimestamp, formatMessageTime } from './chat-view.ts';

	let { records, botsById, t, onOpenArtifact }: {
		records: DelegationView[];
		botsById: Map<string, Bot>;
		t: Copy;
		onOpenArtifact: (path: string, messageId?: string) => void;
	} = $props();
	const ordered = $derived(records.slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
	const nameOf = (id: string) => botsById.get(id)?.name ?? t.top.deleted;
</script>

{#if ordered.length > 0}
	<section class="delegation-records" aria-label={t.delegation.title}>
		<h2>{t.delegation.title}</h2>
		<ol>
			{#each ordered as row (row.id)}
				<li class="delegation-record" data-delegation-id={row.id}>
					<header>
						<span class="delegation-peers">{nameOf(row.from_bot_id)} → {nameOf(row.to_bot_id)}</span>
						<span class="delegation-kind">{t.delegation.expects[row.expects]}</span>
						<span class="delegation-status" class:is-held={row.wait?.state === 'held'}>{t.delegation[row.status]}</span>
						<time datetime={row.created_at} title={formatFullTimestamp(row.created_at)}>{formatMessageTime(row.created_at)}</time>
					</header>
					<div class="delegation-request">
						{t.delegation.request}{row.ask}{row.wait?.state === 'waiting' ? t.delegation.waitingSuffix : row.wait?.state === 'held' ? t.delegation.heldSuffix : ''}
					</div>
					{#if row.reply}
						<div class="delegation-result">
							<span>{t.delegation.result}</span><MarkdownBody source={row.reply.body} copyLabel={t.chat.copyCode} copiedLabel={t.chat.copied}
								onOpenArtifact={(path) => onOpenArtifact(path, row.result_message_id ?? undefined)} />
						</div>
						<time class="delegation-reply-time" datetime={row.reply.created_at} title={formatFullTimestamp(row.reply.created_at)}>{formatMessageTime(row.reply.created_at)}</time>
					{/if}
					{#if row.wait}
						<div class="delegation-wait" class:is-held={row.wait.state === 'held'}>
							<span>{row.wait.state === 'held' ? t.delegation.held : t.delegation.waiting(nameOf(row.to_bot_id))}</span>
							<span class="delegation-wait-times">
								{t.delegation.since} <time datetime={row.wait.since} title={formatFullTimestamp(row.wait.since)}>{formatMessageTime(row.wait.since)}</time>
								{#if row.wait.due_at}· {t.delegation.due} <time datetime={row.wait.due_at} title={formatFullTimestamp(row.wait.due_at)}>{formatMessageTime(row.wait.due_at)}</time>{/if}
							</span>
						</div>
					{/if}
				</li>
			{/each}
		</ol>
	</section>
{/if}

<style>
	.delegation-records { margin: 16px 0; min-width: 0; }
	h2 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--muted); }
	ol { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
	.delegation-record { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-width: 0; overflow-wrap: anywhere; }
	header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; font-size: 11px; color: var(--muted); margin-bottom: 7px; }
	.delegation-peers { color: var(--ink-secondary); font-weight: 500; }
	header > time { margin-left: auto; }
	.delegation-kind, .delegation-status { font-size: 10px; }
	.delegation-request { font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
	.delegation-result { font-size: 13px; line-height: 1.6; margin-top: 8px; }
	.delegation-result > span { float: left; }
	.delegation-result :global(p:first-child) { margin-top: 0; }
	.delegation-result :global(p:last-child) { margin-bottom: 0; }
	.delegation-reply-time { display: block; font-size: 10px; color: var(--muted); margin-top: 4px; }
	.delegation-wait { display: flex; flex-wrap: wrap; gap: 4px 12px; border-top: 1px solid var(--line); padding-top: 8px; margin-top: 10px; font-size: 11px; color: var(--ink-secondary); }
	.delegation-wait-times { color: var(--muted); }
	.is-held { color: var(--warning, var(--ink-secondary)); }
	@media (max-width: 600px) { .delegation-record { padding: 10px 12px; } .delegation-wait-times { flex-basis: 100%; } }
</style>
