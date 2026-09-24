<script lang="ts">
	import { USER_MEMBER, type SessionSummary } from '@real-bot/protocol';
	import Select from '../Select.svelte';
	import SettingsSubject from './SettingsSubject.svelte';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import type { Copy } from '../copy.ts';
	import {
		canRemoveGroupBot,
		pullInCandidates,
		type GroupDetailDraft
	} from './group-edit.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { classifySession, presentBotIds } from '../sidebar/session-groups.ts';

	export type { GroupDetailDraft };

	type Props = {
		runtime: MessengerRuntime;
		selected: SessionSummary;
		t: Copy;
		detail: GroupDetailDraft;
		/** Phone only: a section is open on top of the list. The shell owns it so Back can unwind it. */
		mobileDetail?: boolean;
		onOpenProfile: (botId: string) => void;
		onDeleteGroup: () => void;
		onClearHistory: () => void;
	};

	let {
		runtime,
		selected,
		t,
		detail = $bindable(),
		mobileDetail = $bindable(false),
		onOpenProfile,
		onDeleteGroup,
		onClearHistory
	}: Props = $props();

	/**
	 * On a phone this pane is two screens, like the settings page: the sections as a list, and one
	 * section at a time on top of it. Only the open section is rendered there, so the screen holds
	 * what it says it holds; wider windows keep the single scrolling column of cards.
	 */
	type GroupSection = 'members' | 'actions' | 'danger';
	let phone = $state(false);
	$effect(() => {
		const query = window.matchMedia('(max-width: 680px)');
		const apply = () => { phone = query.matches; };
		apply();
		query.addEventListener('change', apply);
		return () => query.removeEventListener('change', apply);
	});
	let activeSection = $state<GroupSection>('members');
	const shows = (section: GroupSection): boolean => !phone || (mobileDetail && activeSection === section);

	function openSection(section: GroupSection): void {
		activeSection = section;
		mobileDetail = true;
	}

	/** The shell's Back button and the browser's both come through here first. */
	export function backFromDetail(): boolean {
		if (!mobileDetail) return false;
		mobileDetail = false;
		return true;
	}

	function sectionLabel(section: GroupSection): string {
		return section === 'members'
			? t.detail.members
			: section === 'actions'
				? t.detail.sessionActions
				: t.detail.dangerZone;
	}

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
	function memberLabel(id: string): string {
		if (id === USER_MEMBER) return t.common.you;
		const bot = botsById.get(id);
		if (!bot) return t.top.deleted;
		return bot.archived_at ? `${bot.name} · ${t.top.archived}` : bot.name;
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

<div class="group-pane" class:is-mobile-detail={mobileDetail}>
	<!-- Phone only: the sections as a list. Wider windows show them all at once, as before. -->
	<nav class="group-sections" aria-label={selected.kind === 'group' ? t.detail.titleGroup : t.detail.titleBot}>
		<button type="button" class="group-section-btn" onclick={() => openSection('members')}>
			<svg class="section-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
			<span class="section-name">{t.detail.members}</span>
			<span class="section-count">{selected.kind === 'group' ? groupPresent.length + 1 : groupPresent.length}</span>
			<span class="section-chevron" aria-hidden="true"></span>
		</button>
		{#if selected.kind === 'group'}
			<button type="button" class="group-section-btn" onclick={() => openSection('actions')}>
				<svg class="section-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
				<span class="section-name">{t.detail.sessionActions}</span>
				<span class="section-chevron" aria-hidden="true"></span>
			</button>
		{/if}
		<button type="button" class="group-section-btn is-danger" onclick={() => openSection('danger')}>
			<svg class="section-icon" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
			<span class="section-name">{t.detail.dangerZone}</span>
			<span class="section-chevron" aria-hidden="true"></span>
		</button>
	</nav>

	<div class="group-detail">
		<div class="group-detail-head">
			<button
				type="button"
				class="group-detail-back"
				aria-label={t.detail.backToSections}
				onclick={() => backFromDetail()}
			>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
			</button>
			<div class="group-detail-heading">
				<h3 class="group-detail-title">{sectionLabel(activeSection)}</h3>
				<SettingsSubject variant="line" session={selected} bots={botsById} {t} />
			</div>
		</div>

		<div class="panel-scroll-content group-pane-scroll flex-1 overflow-y-auto pt-9 px-9 pb-12 flex flex-col gap-8">

{#if selected.kind === 'group' && detail.failed}
	<div class="panel-alert is-error">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
		<span>{t.detail.saveFailed}</span>
	</div>
{/if}

{#if selected.kind === 'group' && shows('members')}
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
								<span class="member-name-text text-13 font-semibold text-ink whitespace-nowrap overflow-hidden text-ellipsis">{t.common.you}</span>
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
										<span class="member-duties-text text-11p5 text-muted whitespace-nowrap overflow-hidden text-ellipsis leading-[1.25]" title={bot.duties}>{bot.duties}</span>
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

		<div class="form-group session-notifications-group mt-4 pt-4">
			<label class="flex items-center justify-between cursor-pointer">
				<span class="text-13 text-ink font-medium">{t.notifications.sessionMute}</span>
				<input
					type="checkbox"
					checked={runtime.isSessionMuted(selected.id)}
					onchange={(e) => void runtime.setSessionMuted(selected.id, (e.currentTarget as HTMLInputElement).checked)}
				/>
			</label>
		</div>
	</div>
{:else if selectedKind === 'bot-bot' && shows('members')}
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
										<span class="member-duties-text text-11p5 text-muted whitespace-nowrap overflow-hidden text-ellipsis leading-[1.25]" title={bot.duties}>{bot.duties}</span>
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
{#if selected.kind === 'group' && shows('actions')}
	<div class="panel-card">
		<div class="panel-card-head">
			<span class="panel-card-title">{t.detail.sessionActions}</span>
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
{#if shows('danger')}
<div class="panel-card danger-zone-card">
	<div class="panel-card-head">
		<span class="panel-card-title">{t.detail.dangerZone}</span>
	</div>
	<div class="panel-card-body">
		<div class="action-list-stack flex flex-col gap-6">
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
{/if}

		</div>
	</div>
</div>

<style>
	/*
	 * Wider windows: one scrolling column of cards, as before — the section list and the
	 * section header have no box here. The phone block at the end turns the same markup into
	 * the two screens the settings page uses.
	 */
	.group-pane {
		display: flex;
		flex-direction: column;
		flex: 1 1 0;
		min-height: 0;
		height: 100%;
		overflow: hidden;
	}

	.group-sections,
	.group-detail-head,
	.section-chevron {
		display: none;
	}

	.group-detail {
		display: flex;
		flex-direction: column;
		flex: 1 1 0;
		min-height: 0;
	}

	.group-pane-scroll {
		min-height: 0;
		box-sizing: border-box;
	}

	/* Cards keep their height in the scrolling column rather than squeezing to fit. */
	.group-pane-scroll > :global(*) {
		flex-shrink: 0;
	}

	:global(.sheet.session-settings) .member.you {
		background: var(--pane);
		border: 1px solid var(--line-subtle);
	}

	.member-left {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
		flex: 1;
	}

	.member-avatar-mini {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 13px;
		font-weight: 700;
		border: 1px solid;
		overflow: hidden;
		flex-shrink: 0;
	}

	.member-avatar-mini.is-you {
		background: #1e293b;
		color: #ffffff;
		border-color: #334155;
	}

	.member-avatar-mini.is-deleted {
		background: var(--line-subtle);
		color: var(--muted);
		border-color: var(--line);
	}

	.member-info {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
		gap: 2px;
	}

	.member-name-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.member-name-btn {
		border: 0;
		background: transparent;
		padding: 0;
		color: var(--ink);
		font-size: 13px;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		box-shadow: none;
		transition: color 0.15s ease;
	}

	.member-name-btn:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.member-badge {
		font-size: 10.5px;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: 9999px;
		white-space: nowrap;
		flex-shrink: 0;
		line-height: 1.3;
	}

	.member-badge.is-owner {
		background: var(--chip);
		color: var(--muted);
		border: 1px solid var(--chip-line);
	}

	.member-badge.is-model {
		background: var(--accent-tint);
		color: var(--accent);
		border: 1px solid var(--accent-border);
		max-width: 140px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.member-deleted-label {
		font-size: 12px;
		color: var(--muted);
		font-style: italic;
	}

	.btn-remove-member {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--muted);
		font-size: 11.5px;
		font-weight: 500;
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		transition: all 0.15s ease;
	}

	.btn-remove-member:hover:not(:disabled) {
		background: var(--danger-bg);
		border-color: var(--danger-line);
		color: var(--danger);
	}

	.btn-remove-member:disabled {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.session-notifications-group {
		border-top: 1px solid var(--line);
	}

	/* Pull in section */
	.pull-in-section {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--line-subtle);
	}

	.pull-in-section .name-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.pull-in-section .name-row :global(.real-select) {
		flex: 1;
		min-width: 0;
	}

	.btn-pull-in {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: var(--accent-tint);
		border: 1px solid var(--accent-border);
		color: var(--accent);
		font-size: 12px;
		font-weight: 600;
		padding: 6px 12px;
		border-radius: var(--radius-md);
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		transition: all 0.15s ease;
	}

	.btn-pull-in:hover:not(:disabled) {
		background: var(--accent);
		color: #ffffff;
		border-color: var(--accent);
	}

	.btn-pull-in:disabled {
		opacity: 0.45;
		cursor: not-allowed;
		background: var(--line-subtle);
		border-color: var(--line);
		color: var(--muted);
	}

	@media (max-width: 680px) {
		.group-pane {
			position: relative;
		}

		.group-sections {
			position: absolute;
			inset: 0;
			display: flex;
			flex-direction: column;
			overflow-y: auto;
			padding: 14px 12px calc(24px + env(safe-area-inset-bottom));
			background: var(--sidebar-bg);
			transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
		}

		.group-pane.is-mobile-detail .group-sections {
			transform: translateX(-28%);
		}

		.group-section-btn {
			position: relative;
			display: flex;
			align-items: center;
			gap: 10px;
			width: 100%;
			min-height: 54px;
			padding: 0 14px;
			border: 0;
			background: var(--pane);
			color: var(--ink);
			font: 500 15px/1.2 var(--font);
			text-align: left;
			cursor: pointer;
		}

		.group-section-btn:first-child {
			border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		}

		.group-section-btn:last-child {
			border-radius: 0 0 var(--radius-lg) var(--radius-lg);
		}

		.group-section-btn + .group-section-btn::before {
			content: '';
			position: absolute;
			left: 44px;
			right: 0;
			top: 0;
			height: 1px;
			background: var(--line);
		}

		.group-section-btn .section-chevron {
			display: block;
			width: 8px;
			height: 8px;
			border-top: 1.8px solid var(--muted);
			border-right: 1.8px solid var(--muted);
			transform: rotate(45deg);
			margin-left: 8px;
			flex-shrink: 0;
		}

		.group-section-btn:active {
			background: var(--row-hover);
		}

		.group-section-btn .section-icon {
			color: var(--muted);
			flex-shrink: 0;
		}

		.group-section-btn.is-danger .section-icon {
			color: var(--danger);
		}

		/* The name grows, so the member count sits against the chevron instead of mid-row. */
		.group-section-btn .section-name {
			flex: 1;
			min-width: 0;
			text-align: left;
		}

		.group-section-btn .section-count {
			margin-left: 8px;
			font-size: 13px;
			color: var(--muted);
			flex-shrink: 0;
		}

		.group-detail {
			position: absolute;
			inset: 0;
			z-index: 2;
			background: var(--bg);
			transform: translateX(100%);
			visibility: hidden;
			transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), visibility 0s linear 0.22s;
		}

		.group-pane.is-mobile-detail .group-detail {
			transform: translateX(0);
			visibility: visible;
			transition-delay: 0s;
		}

		.group-detail-head {
			display: flex;
			align-items: center;
			gap: 4px;
			flex-shrink: 0;
			min-height: 56px;
			padding: 0 12px 0 4px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
		}

		.group-detail-back {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 44px;
			height: 44px;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			cursor: pointer;
			flex-shrink: 0;
		}

		.group-detail-back:active {
			background: var(--row-hover);
		}

		/* The section is the heading; whose settings they are is the line under it. */
		.group-detail-heading {
			display: flex;
			flex: 1 1 auto;
			flex-direction: column;
			gap: 1px;
			min-width: 0;
		}

		.group-detail-title {
			margin: 0;
			font-size: 16px;
			font-weight: 650;
			color: var(--ink);
		}

		.group-pane-scroll {
			padding: 16px 12px calc(28px + env(safe-area-inset-bottom));
			overscroll-behavior: contain;
		}

		@media (prefers-reduced-motion: reduce) {
			.group-sections,
			.group-detail {
				transition: none;
			}
		}
	}
</style>
