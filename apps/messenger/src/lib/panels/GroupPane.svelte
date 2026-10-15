<script lang="ts">
	import Icon from '../Icon.svelte';
	import { untrack } from 'svelte';
	import { USER_MEMBER, type SessionSummary } from '@real-bot/protocol';
	import Select from '../Select.svelte';
	import SettingsSubject from './SettingsSubject.svelte';
	import PlaybookPicker from './PlaybookPicker.svelte';
	import SessionMuteRow from './SessionMuteRow.svelte';
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

	/**
	 * The lead is a property of a member, so it is set on the member's row: one click is the
	 * confirmation (nothing here is a guess the daemon made for you), and the same button on the
	 * current lead takes it back. The daemon's suggestion is only ever a hint on the row.
	 */
	const leadState = $derived(runtime.groupLeads[selected.id] ?? null);
	const leadAvailable = $derived(selected.kind === 'group' && !runtime.groupLeadUnsupported[selected.id]);
	const leadId = $derived(leadState?.confirmed_bot_id ?? null);
	const leadPresent = $derived(leadId !== null && groupPresent.includes(leadId));
	const leadSuggestion = $derived(
		leadState?.suggestion && leadState.suggestion.bot_id !== leadId ? leadState.suggestion : null
	);
	let leadPending = $state(false);
	let leadFailed = $state(false);
	$effect(() => {
		const id = selected.id;
		leadFailed = false;
		if (selected.kind === 'group' && runtime.connection === 'connected') {
			void untrack(() => runtime.loadGroupLead(id));
		}
	});

	async function setLead(botId: string | null): Promise<void> {
		if (selected.kind !== 'group' || leadPending) return;
		leadPending = true;
		leadFailed = false;
		try {
			leadFailed = Boolean(await runtime.confirmGroupLead(selected.id, botId));
		} catch {
			leadFailed = true;
		} finally {
			leadPending = false;
		}
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
			<Icon name="user" size={20} class="section-icon" />
			<span class="section-name">{t.detail.members}</span>
			<span class="section-count">{selected.kind === 'group' ? groupPresent.length + 1 : groupPresent.length}</span>
			<span class="section-chevron" aria-hidden="true"></span>
		</button>
		{#if selected.kind === 'group'}
			<button type="button" class="group-section-btn" onclick={() => openSection('actions')}>
				<Icon name="archive" size={20} class="section-icon" />
				<span class="section-name">{t.detail.sessionActions}</span>
				<span class="section-chevron" aria-hidden="true"></span>
			</button>
		{/if}
		<button type="button" class="group-section-btn is-danger" onclick={() => openSection('danger')}>
			<Icon name="alert-triangle" size={20} class="section-icon" />
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
				<Icon name="chevron-left" size={20} />
			</button>
			<div class="group-detail-heading">
				<h3 class="group-detail-title">{sectionLabel(activeSection)}</h3>
				<SettingsSubject variant="line" session={selected} bots={botsById} {t} />
			</div>
		</div>

		<div class="panel-scroll-content group-pane-scroll flex-1 overflow-y-auto pt-9 px-9 pb-12 flex flex-col gap-8">

{#if selected.kind === 'group' && detail.failed}
	<div class="panel-alert is-error">
		<Icon name="alert-circle" />
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
										{#if botId === leadId}
											<span class="member-badge is-lead" title={t.groupLead.badgeHint}>{t.groupLead.badge}</span>
										{/if}
										{#if bot.model}
											<span class="member-badge is-model mono" title={bot.model}>{bot.model}</span>
										{/if}
									</div>
									{#if bot.duties}
										<span class="member-duties-text text-12 text-muted whitespace-nowrap overflow-hidden text-ellipsis leading-[1.25]" title={bot.duties}>{bot.duties}</span>
									{/if}
									{#if leadSuggestion?.bot_id === botId}
										<span class="member-suggest">{t.groupLead.suggested(leadSuggestion.handoffs)}</span>
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
							<div class="member-actions">
								{#if leadAvailable && leadState && (botId === leadId || !bot.archived_at)}
									<button
										type="button"
										class="btn-lead"
										class:is-suggested={leadSuggestion?.bot_id === botId}
										disabled={leadPending}
										onclick={() => void setLead(botId === leadId ? null : botId)}
									>{botId === leadId ? t.groupLead.clear : t.groupLead.set}</button>
								{/if}
								<button
									type="button"
									class="btn-remove-member"
									disabled={!groupCanRemove}
									title={!groupCanRemove ? (locale === 'zh' ? '群内至少需保留 2 个 Bot' : 'Keep at least 2 bots') : t.detail.remove}
									onclick={() => void removeMember(botId)}
								>
									<Icon name="x" size={12} />
									<span>{t.detail.remove}</span>
								</button>
							</div>
						{/if}
					</div>
				{/each}
			</div>

			{#if leadAvailable}
				{#if runtime.groupLeadLoadError[selected.id]}
					<p class="lead-note is-error" role="status">
						{t.groupLead.loadFailed}
						<button type="button" class="lead-retry" disabled={leadPending} onclick={() => void runtime.loadGroupLead(selected.id)}>{t.groupLead.retry}</button>
					</p>
				{:else if leadFailed}
					<p class="lead-note is-error" role="status">{t.groupLead.failed}</p>
				{:else if leadState}
					<p class="lead-note">{leadPresent ? t.groupLead.confirmed : t.groupLead.unconfirmed}</p>
				{:else if runtime.groupLeadLoading[selected.id]}
					<p class="lead-note" role="status">{t.groupLead.loading}</p>
				{/if}
			{/if}

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
							<Icon name="plus" size={12} />
							<span>{t.detail.pullIn}</span>
						</button>
					</div>
				</div>
			{/if}
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
										<span class="member-duties-text text-12 text-muted whitespace-nowrap overflow-hidden text-ellipsis leading-[1.25]" title={bot.duties}>{bot.duties}</span>
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
						<Icon name="rotate-ccw" />
						<span>{t.sidebar.restore}</span>
					</button>
				{:else}
					<button type="button" class="btn-secondary action-btn" onclick={() => void runtime.archiveSession(selected.id)}>
						<Icon name="archive" />
						<span>{t.sidebar.archive}</span>
					</button>
				{/if}
			</div>
			<div class="mt-4 pt-4 session-mute-row">
				<SessionMuteRow {runtime} sessionId={selected.id} {t} />
			</div>
			<div class="mt-4 pt-4 playbook-row">
				<PlaybookPicker {runtime} sessionId={selected.id} {t} />
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
					<Icon name="rotate-ccw" />
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
						<Icon name="trash" />
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
		background: var(--ink);
		color: var(--pane);
		border-color: transparent;
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

	/* A badge that does not fit beside the name drops under it; the name is never the part that gives. */
	.member-name-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px 6px;
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
		max-width: 100%;
		box-shadow: none;
		transition: color 0.15s ease;
	}

	.member-name-btn:hover {
		color: var(--accent);
		text-decoration: underline;
	}

	.member-badge {
		font-size: 11px;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		white-space: nowrap;
		flex-shrink: 0;
		line-height: 1.3;
	}

	.member-badge.is-owner {
		background: var(--chip);
		color: var(--muted);
		border: 1px solid var(--chip-line);
	}

	.member-badge.is-lead {
		background: var(--accent);
		color: var(--on-accent);
		border: 1px solid var(--accent);
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

	.member-suggest {
		font-size: 12px;
		line-height: 1.25;
		color: var(--accent);
	}

	.member-actions {
		display: flex;
		align-items: center;
		gap: 2px;
		flex-shrink: 0;
	}

	.btn-lead {
		border: 1px solid transparent;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.btn-lead:hover:not(:disabled) {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.btn-lead.is-suggested {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.btn-lead:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.lead-note {
		margin: 10px 0 0;
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted);
	}

	.lead-note.is-error {
		color: var(--danger-text);
	}

	.lead-retry {
		border: 0;
		background: transparent;
		padding: 0 0 0 4px;
		color: var(--accent);
		font: inherit;
		cursor: pointer;
		text-decoration: underline;
	}

	.btn-remove-member {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
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
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.btn-pull-in:hover:not(:disabled) {
		background: var(--accent);
		color: var(--on-accent);
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

		.group-section-btn :global(.section-icon) {
			color: var(--muted);
			flex-shrink: 0;
		}

		.group-section-btn.is-danger :global(.section-icon) {
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

	.session-mute-row,
	.playbook-row {
		border-top: 1px solid var(--line);
	}
</style>
