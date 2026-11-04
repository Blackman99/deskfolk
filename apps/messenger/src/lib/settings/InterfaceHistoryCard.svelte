<script lang="ts">
	import type { InterfaceRevisionHead } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import type { Snapshot } from '../snapshot.ts';
	import Button from '../Button.svelte';
	import { showToast } from '../toast.svelte.ts';
	import SettingsCard from './SettingsCard.svelte';

	/** The newest changes, who made them, and the way back: undo the latest, or restore an older one. */
	type Props = { runtime: MessengerRuntime; t: Copy; recent: InterfaceRevisionHead[]; bots: Snapshot['bots']; locale: 'zh' | 'en' };

	let { runtime, t, recent, bots, locale }: Props = $props();
	const c = $derived(t.ui.history);
	const SHOWN_CHANGES = 3;
	let busy = $state<string | null>(null);

	function who(head: InterfaceRevisionHead): string {
		if (head.actor === 'user') return c.you;
		const bot = head.bot_id ? bots.find((item) => item.id === head.bot_id) : undefined;
		return bot ? c.bot.replace('{name}', bot.name) : c.someBot;
	}

	function when(iso: string): string {
		const date = new Date(iso);
		return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale === 'en' ? 'en' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	async function run(head: InterfaceRevisionHead, kind: 'undo' | 'restore'): Promise<void> {
		const api = runtime.client;
		if (!api || busy) return;
		busy = head.id;
		try {
			if (kind === 'undo') await api.undoInterfaceRevision(head.id);
			else await api.restoreInterfaceRevision(head.id);
			showToast(kind === 'undo' ? c.undone : c.restored, { tone: 'neutral' });
		} catch (error) {
			showToast(error instanceof Error ? error.message : String(error), { tone: 'error' });
		} finally {
			busy = null;
		}
	}
</script>

<SettingsCard class="interface-history">
	<h3 class="interface-card-title">{t.ui.sections.history}</h3>
	{#if recent.length === 0}
		<p class="interface-empty">{c.empty}</p>
	{:else}
		<ul class="history-list">
			{#each recent as head (head.id)}
				<li class="history-row" data-revision={head.id}>
					<div class="history-main">
						<div class="history-line">
							<strong class="history-who">{who(head)}</strong>
							<span class="history-op">{c.ops[head.op]}</span>
							<time class="history-time" datetime={head.created_at}>{when(head.created_at)}</time>
						</div>
						{#if head.changes.length > 0}
							<ul class="history-changes">
								{#each head.changes.slice(0, SHOWN_CHANGES) as line, at (at)}
									<li>{line}</li>
								{/each}
								{#if head.changes.length > SHOWN_CHANGES}
									<li class="history-more">{c.more.replace('{n}', String(head.changes.length - SHOWN_CHANGES))}</li>
								{/if}
							</ul>
						{/if}
					</div>
					<div class="history-actions">
						{#if head.undoable}
							<Button size="sm" variant="secondary" data-action="undo" data-floor="interface-undo" disabled={busy !== null} onclick={() => void run(head, 'undo')}>{c.undo}</Button>
						{/if}
						<Button size="sm" variant="ghost" data-action="restore" disabled={busy !== null} onclick={() => void run(head, 'restore')}>{c.restore}</Button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</SettingsCard>

<style>
	.interface-card-title {
		margin: 0;
		font-size: var(--text-body);
		font-weight: 650;
		color: var(--ink);
	}

	.interface-empty {
		margin: 0;
		font-size: var(--text-small);
		color: var(--muted);
	}

	.history-list,
	.history-changes {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.history-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 8px 0;
		border-top: 1px solid var(--line-subtle);
	}

	.history-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.history-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 8px;
		font-size: var(--text-small);
	}

	.history-who {
		color: var(--ink);
		font-weight: 600;
	}

	.history-op,
	.history-time {
		color: var(--muted);
		font-size: var(--text-caption);
	}

	.history-changes {
		display: flex;
		flex-direction: column;
		gap: 1px;
		font: var(--text-caption) / 1.5 var(--mono);
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.history-more {
		color: var(--muted);
		font-family: inherit;
	}

	.history-actions {
		flex: none;
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 4px;
	}

	@media (max-width: 540px) {
		.history-row {
			flex-direction: column;
		}

		.history-actions {
			justify-content: flex-start;
		}
	}
</style>
