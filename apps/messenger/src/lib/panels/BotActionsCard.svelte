<script lang="ts">
	import type { Bot } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';

	/** The actions tab: archive, the session mute, and the danger zone. */
	type Props = {
		runtime: MessengerRuntime;
		bot: Bot;
		t: Copy;
		selectedKind: string | null;
		archiveProfile: () => Promise<void>;
		restoreProfile: () => Promise<void>;
		onDeleteBot: () => void;
		onClearHistory: () => void;
	};

	let { runtime, bot, t, selectedKind, archiveProfile, restoreProfile, onDeleteBot, onClearHistory }: Props = $props();
</script>

<div class="panel-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{t.detail.sessionActions}</span>
	</div>
	<div class="panel-card-body">
		<div class="action-list-row">
			<div class="action-list-info">
				<span class="action-list-title">{bot.archived_at ? t.sidebar.restore : t.sidebar.archive}</span>
				<span class="action-list-desc">{bot.archived_at ? t.sidebar.restoreBody : t.sidebar.archiveBody}</span>
			</div>
			{#if bot.archived_at}
				<button type="button" class="btn-secondary action-btn" onclick={() => void restoreProfile()}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
					<span>{t.sidebar.restore}</span>
				</button>
			{:else}
				<button type="button" class="btn-secondary action-btn" onclick={() => void archiveProfile()}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
					<span>{t.sidebar.archive}</span>
				</button>
			{/if}
		</div>
		{#if runtime.selectedId}
			<div class="action-list-row session-mute-row mt-4 pt-4">
				<div class="action-list-info">
					<span class="action-list-title">{t.notifications.sessionMute}</span>
				</div>
				<input
					type="checkbox"
					checked={runtime.isSessionMuted(runtime.selectedId)}
					onchange={(e) => {
						if (runtime.selectedId) {
							void runtime.setSessionMuted(runtime.selectedId, (e.currentTarget as HTMLInputElement).checked);
						}
					}}
				/>
			</div>
		{/if}
	</div>
</div>

<div class="panel-card danger-zone-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{t.detail.dangerZone}</span>
	</div>
	<div class="panel-card-body">
		<div class="action-list-stack flex flex-col gap-6">
			{#if selectedKind === 'you-bot'}
				<div class="action-list-row">
					<div class="action-list-info">
						<span class="action-list-title">{t.detail.clearHistory}</span>
						<span class="action-list-desc">{t.detail.clearHistoryBody}</span>
					</div>
					<button
						type="button"
						class="btn-secondary btn-history-clear action-btn"
						onclick={onClearHistory}
					>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
						<span>{t.detail.clearHistory}</span>
					</button>
				</div>
			{/if}

			<div class="action-list-row is-danger">
				<div class="action-list-info">
					<span class="action-list-title text-danger">{t.sidebar.delete}</span>
					<span class="action-list-desc">{t.sidebar.deleteBody}</span>
				</div>
				<button type="button" class="deny action-btn" onclick={onDeleteBot}>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
					<span>{t.sidebar.delete}</span>
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	.session-mute-row {
		border-top: 1px solid var(--line);
	}
</style>
