<script lang="ts">
	import { USER_MEMBER, type SessionSummary } from '@real-bot/protocol';
	import SessionAvatar from '../SessionAvatar.svelte';
	import Select from '../Select.svelte';
	import { avatarSrc } from '../avatar.ts';
	import { botAvatarColor } from '../chat-view.ts';
	import type { Copy } from '../copy.ts';
	import { canRemoveGroupBot, mapGroupEditError, planGroupName, presentBotIds, pullInCandidates } from '../group-edit.ts';
	import { rosterLetter } from '../roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { classifySession } from '../session-groups.ts';
	import { botWorkStatus } from '../session-status.ts';
	import { sessionTitle } from '../session-title.ts';

	/** Kept by the shell: the reset runs on every session change, drawer open or not. */
	export type GroupDetailDraft = {
		sessionId: string | null;
		name: string;
		nameError: 'empty' | undefined;
		failed: boolean;
		pullPick: string;
	};

	type Props = {
		runtime: MessengerRuntime;
		selected: SessionSummary;
		t: Copy;
		detail: GroupDetailDraft;
		onOpenProfile: (botId: string) => void;
		onDeleteGroup: () => void;
		onClearHistory: () => void;
	};

	let {
		runtime,
		selected,
		t,
		detail = $bindable(),
		onOpenProfile,
		onDeleteGroup,
		onClearHistory
	}: Props = $props();

	const snapshot = $derived(runtime.snapshot);
	const locale = $derived(snapshot.settings.locale === 'en' ? 'en' : 'zh');
	const botsById = $derived(new Map(snapshot.bots.map((b) => [b.id, b] as const)));
	const visibleBots = $derived(snapshot.bots.filter((b) => !b.archived_at));
	const selectedKind = $derived(classifySession(selected));
	const groupPresent = $derived(presentBotIds(selected));
	const groupCanRemove = $derived(selected.kind === 'group' ? canRemoveGroupBot(selected) : false);
	const groupCandidates = $derived(
		selected.kind === 'group' ? pullInCandidates(visibleBots, selected) : []
	);
	const rosterLabels = $derived({ deleted: t.top.deleted, archived: t.top.archived });
	const statusLabels = $derived({
		running: t.sidebar.statusRunning,
		replying: t.sidebar.statusReplying,
		waitingApproval: t.sidebar.statusWaitingApproval,
		waitingAsk: t.sidebar.statusWaitingAsk,
		idle: t.sidebar.statusIdle
	});

	function titleOf(session: SessionSummary): string {
		return sessionTitle(session, botsById, rosterLabels);
	}

	function botStatusOf(botId: string) {
		return botWorkStatus(
			botId,
			snapshot.turns,
			snapshot.approvals,
			statusLabels,
			snapshot.pendingJudgements
		);
	}

	function memberLabel(id: string): string {
		if (id === USER_MEMBER) return t.common.you;
		const bot = botsById.get(id);
		if (!bot) return t.top.deleted;
		return bot.archived_at ? `${bot.name} · ${t.top.archived}` : bot.name;
	}

	async function saveGroupName(): Promise<void> {
		if (selected.kind !== 'group') return;
		detail.failed = false;
		detail.nameError = undefined;
		const plan = planGroupName(detail.name);
		if (!plan.ok) {
			detail.nameError = plan.error;
			return;
		}
		const error = await runtime.patchSession(selected.id, { name: plan.name });
		if (!error) {
			detail.name = plan.name;
			return;
		}
		const mapped = mapGroupEditError(error.message);
		if ('name' in mapped) detail.nameError = mapped.name;
		else detail.failed = true;
	}

	async function pullInMember(): Promise<void> {
		if (selected.kind !== 'group' || !detail.pullPick) return;
		detail.failed = false;
		const error = await runtime.addMember(selected.id, detail.pullPick);
		if (error) {
			detail.failed = true;
			return;
		}
		detail.pullPick = '';
	}

	async function removeMember(botId: string): Promise<void> {
		if (selected.kind !== 'group' || !groupCanRemove) return;
		detail.failed = false;
		const error = await runtime.removeMember(selected.id, botId);
		if (error) detail.failed = true;
	}
</script>

{#if selected.kind === 'group'}
	{#if detail.failed}
		<div class="panel-alert is-error">
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
			<span>{t.detail.saveFailed}</span>
		</div>
	{/if}

	<!-- Group Profile Section -->
	<div class="panel-card group-hero-card">
		<div class="group-hero-header">
			<div class="group-hero-avatar has-composite" aria-hidden="true">
				<SessionAvatar session={selected} bots={botsById} size="hero" botStatus={botStatusOf} />
			</div>
			<div class="group-hero-info">
				<div class="group-hero-title-row">
					<h3 class="group-hero-name">{detail.name || titleOf(selected)}</h3>
					{#if selected.archived_at}
						<span class="badge-archived">{t.top.archived}</span>
					{/if}
				</div>
				<span class="group-hero-count">{groupPresent.length + 1} {t.detail.members}</span>
			</div>
		</div>

		<div class="form-group group-name-edit">
			<label for="detail-group-name">{t.sidebar.groupName}</label>
			<div class="name-row">
				<input
					id="detail-group-name"
					type="text"
					bind:value={detail.name}
					placeholder={t.sidebar.groupName}
					onkeydown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							void saveGroupName();
						}
					}}
				/>
				<button
					type="button"
					class="btn-save-name"
					class:is-active={detail.name.trim() !== (selected.name ?? '').trim()}
					disabled={detail.name.trim() === (selected.name ?? '').trim()}
					onclick={() => void saveGroupName()}
				>
					{t.detail.saveName}
				</button>
			</div>
			{#if detail.nameError}
				<p class="field-error">{t.sidebar.groupNameEmpty}</p>
			{/if}
		</div>
	</div>

	<!-- Group Members Section -->
	<div class="panel-card group-members-card">
		<div class="panel-card-head">
			<span class="panel-card-title">{t.detail.members}</span>
			<span class="panel-counter-badge">{groupPresent.length + 1}</span>
		</div>
		<div class="panel-card-body">
			<div class="members">
				<div class="member you">
					<div class="member-left">
						<div class="member-avatar-mini is-you" aria-hidden="true">
							<span>{rosterLetter(t.common.you)}</span>
						</div>
						<div class="member-info">
							<div class="member-name-row">
								<span class="member-name-text">{t.common.you}</span>
								<span class="member-badge is-owner">{locale === 'zh' ? '创建者' : 'Owner'}</span>
							</div>
						</div>
					</div>
				</div>

				{#each groupPresent as botId (botId)}
					{@const bot = botsById.get(botId)}
					<div class="member">
						<div class="member-left">
							{#if bot}
								{@const pal = botAvatarColor(bot.id)}
								<span
									class="member-avatar-mini"
									style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
								>
									{#if avatarSrc(bot.avatar)}
										<img src={avatarSrc(bot.avatar)!} alt="" class="avatar-img" />
									{:else}
										{rosterLetter(bot.name)}
									{/if}
								</span>
								<div class="member-info">
									<div class="member-name-row">
										<button
											type="button"
											class="member-name-btn"
											onclick={() => onOpenProfile(bot.id)}
											title={locale === 'zh' ? '查看并编辑 Bot 人设' : 'View & edit bot profile'}
										>
											{memberLabel(botId)}
										</button>
										{#if bot.model}
											<span class="member-badge is-model mono" title={bot.model}>{bot.model}</span>
										{/if}
									</div>
									{#if bot.duties}
										<span class="member-duties-text" title={bot.duties}>{bot.duties}</span>
									{/if}
								</div>
							{:else}
								<span class="member-avatar-mini is-deleted">?</span>
								<div class="member-info">
									<span class="member-deleted-label">{t.top.deleted}</span>
								</div>
							{/if}
						</div>

						{#if bot}
							<button
								type="button"
								class="btn-remove-member"
								disabled={!groupCanRemove}
								title={!groupCanRemove ? (locale === 'zh' ? '群内至少需保留 2 个 Bot' : 'Keep at least 2 bots') : t.detail.remove}
								onclick={() => void removeMember(botId)}
							>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
								<span>{t.detail.remove}</span>
							</button>
						{/if}
					</div>
				{/each}
			</div>

			{#if groupCandidates.length > 0}
				<div class="pull-in-section">
					<div class="name-row">
						<Select
							bind:value={detail.pullPick}
							placeholder={t.detail.pullIn}
							emptyLabel={t.detail.pullIn}
							options={groupCandidates.map((bot) => ({ value: bot.id, label: bot.name }))}
							size="sm"
						/>
						<button
							type="button"
							class="btn-pull-in"
							disabled={!detail.pullPick}
							onclick={() => void pullInMember()}
						>
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
							<span>{t.detail.pullIn}</span>
						</button>
					</div>
				</div>
			{/if}
		</div>
	</div>
{:else if selectedKind === 'bot-bot'}
	<div class="panel-card group-members-card">
		<div class="panel-card-head">
			<span class="panel-card-title">{t.detail.members}</span>
			<span class="panel-counter-badge">{groupPresent.length}</span>
		</div>
		<div class="panel-card-body">
			<div class="members">
				{#each groupPresent as botId (botId)}
					{@const bot = botsById.get(botId)}
					<div class="member">
						<div class="member-left">
							{#if bot}
								{@const pal = botAvatarColor(bot.id)}
								<span
									class="member-avatar-mini"
									style="background: {pal.bg}; color: {pal.text}; border-color: {pal.border};"
								>
									{#if avatarSrc(bot.avatar)}
										<img src={avatarSrc(bot.avatar)!} alt="" class="avatar-img" />
									{:else}
										{rosterLetter(bot.name)}
									{/if}
								</span>
								<div class="member-info">
									<div class="member-name-row">
										<button
											type="button"
											class="member-name-btn"
											onclick={() => onOpenProfile(bot.id)}
											title={locale === 'zh' ? '查看并编辑 Bot 人设' : 'View & edit bot profile'}
										>
											{memberLabel(botId)}
										</button>
										{#if bot.model}
											<span class="member-badge is-model mono" title={bot.model}>{bot.model}</span>
										{/if}
									</div>
									{#if bot.duties}
										<span class="member-duties-text" title={bot.duties}>{bot.duties}</span>
									{/if}
								</div>
							{:else}
								<span class="member-avatar-mini is-deleted">?</span>
								<div class="member-info">
									<span class="member-deleted-label">{t.top.deleted}</span>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

<!-- Session Actions (Archive / Restore) -->
{#if selected.kind === 'group'}
	<div class="panel-card">
		<div class="panel-card-head">
			<span class="panel-card-title">{locale === 'zh' ? '会话操作' : 'Actions'}</span>
		</div>
		<div class="panel-card-body">
			<div class="action-list-row">
				<div class="action-list-info">
					<span class="action-list-title">{selected.archived_at ? t.sidebar.restore : t.sidebar.archive}</span>
					<span class="action-list-desc">{selected.archived_at ? (locale === 'zh' ? '恢复此群组到活跃会话列表' : 'Restore group to active sidebar') : (locale === 'zh' ? '从侧栏移入已归档列表，保留历史消息' : 'Move to archived sessions without deleting history')}</span>
				</div>
				{#if selected.archived_at}
					<button type="button" class="btn-secondary action-btn" onclick={() => void runtime.restoreSession(selected.id)}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
						<span>{t.sidebar.restore}</span>
					</button>
				{:else}
					<button type="button" class="btn-secondary action-btn" onclick={() => void runtime.archiveSession(selected.id)}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
						<span>{t.sidebar.archive}</span>
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Danger Zone (Clear History / Delete Group) -->
<div class="panel-card danger-zone-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{locale === 'zh' ? '危险区域' : 'Danger Zone'}</span>
	</div>
	<div class="panel-card-body">
		<div class="action-list-stack">
			<div class="action-list-row">
				<div class="action-list-info">
					<span class="action-list-title">{t.detail.clearHistory}</span>
					<span class="action-list-desc">{locale === 'zh' ? '清空所有聊天消息、轮次和上下文，不可撤销' : 'Clear all messages and turns in this group'}</span>
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

			{#if selected.kind === 'group'}
				<div class="action-list-row is-danger">
					<div class="action-list-info">
						<span class="action-list-title text-danger">{t.detail.deleteGroup}</span>
						<span class="action-list-desc">{locale === 'zh' ? '永久解散此群组并删除记录，名册上的 Bot 保留' : 'Permanently delete this group; member bots remain'}</span>
					</div>
					<button type="button" class="deny action-btn" onclick={onDeleteGroup}>
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
						<span>{t.detail.deleteGroup}</span>
					</button>
				</div>
			{/if}
		</div>
	</div>
</div>
