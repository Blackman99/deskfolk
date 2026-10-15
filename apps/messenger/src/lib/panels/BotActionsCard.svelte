<script lang="ts">
	import Icon from '../Icon.svelte';
	import type { Bot } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import PlaybookPicker from './PlaybookPicker.svelte';
	import SessionMuteRow from './SessionMuteRow.svelte';

	/** The actions tab: archive, the session mute, the direct's engine (ADR 0085), and the danger zone. */
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
					<Icon name="rotate-ccw" />
					<span>{t.sidebar.restore}</span>
				</button>
			{:else}
				<button type="button" class="btn-secondary action-btn" onclick={() => void archiveProfile()}>
					<Icon name="archive" />
					<span>{t.sidebar.archive}</span>
				</button>
			{/if}
		</div>
		{#if runtime.selectedId}
			<div class="mt-4 pt-4 session-mute-row">
				<SessionMuteRow {runtime} sessionId={runtime.selectedId} {t} />
			</div>
			{#if selectedKind === 'you-bot'}
				<div class="mt-4 pt-4 playbook-row">
					<PlaybookPicker {runtime} sessionId={runtime.selectedId} {t} />
				</div>
			{/if}
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
						<Icon name="rotate-ccw" />
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
					<Icon name="trash" />
					<span>{t.sidebar.delete}</span>
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	.session-mute-row,
	.playbook-row {
		border-top: 1px solid var(--line);
	}
</style>
