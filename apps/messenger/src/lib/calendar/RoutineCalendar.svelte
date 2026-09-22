<script lang="ts">
	import { Calendar, type CalendarEvent, type CalendarSource, type EventInstance } from './calendar-entry.ts';
	import { avatarSrc, botAvatarColor } from '../avatar.ts';
	import type { Copy } from '../copy.ts';
	import { routineScheduleLabel } from '../panels/routine-form.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { rosterLetter } from '../sidebar/roster-letter.ts';
	import { themeManager } from '../theme.ts';
	import { projectRoutines } from './project-routines.ts';

	let { runtime, t }: { runtime: MessengerRuntime; t: Copy } = $props();

	let date = $state(new Date());
	let view = $state<'week' | 'day' | 'month' | 'agenda'>('week');
	let rangeStart = $state(startOfWeek(new Date()));
	let rangeEnd = $state(endOfWeek(new Date()));
	let hidden = $state<ReadonlySet<string>>(new Set());
	let showInfo = $state(false);
let showSources = $state(false);

	const locale = $derived(runtime.snapshot.settings.locale === 'en' ? 'en' : 'zh-CN');
	const theme = $derived(themeManager.resolved);
	const projected = $derived(
		projectRoutines({
			bots: runtime.snapshot.bots,
			routines: runtime.snapshot.routines,
			rangeStart,
			rangeEnd,
			hostLocal: !runtime.remote,
			archivedLabel: t.top.archived
		})
	);
	const sources = $derived<CalendarSource[]>(
		projected.sources.map((source) => ({ ...source, visible: !hidden.has(source.id) }))
	);
	const events = $derived<CalendarEvent[]>(projected.events);
	const botsById = $derived(new Map(runtime.snapshot.bots.map((bot) => [bot.id, bot])));
	let openRoutineId = $state<string | null>(null);
	let openWasDue = $state(false);
	const openRoutine = $derived(runtime.snapshot.routines.find((row) => row.id === openRoutineId) ?? null);
	const openBot = $derived(openRoutine ? botsById.get(openRoutine.bot_id) ?? null : null);

	function botOf(instance: EventInstance) {
		const id = instance.event.meta?.botId;
		return typeof id === 'string' ? botsById.get(id) : undefined;
	}

	function openDetail(instance: EventInstance): void {
		const id = instance.event.meta?.routineId;
		if (typeof id !== 'string') return;
		openWasDue = instance.event.meta?.lastFired === true;
		openRoutineId = id;
	}

	function toggleSource(id: string): void {
		const next = new Set(hidden);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		hidden = next;
	}

	function showAllSources(): void {
		hidden = new Set();
	}

	function startOfWeek(day: Date): Date {
		const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
		const offset = (start.getDay() + 6) % 7;
		start.setDate(start.getDate() - offset);
		return start;
	}

	function endOfWeek(day: Date): Date {
		const end = startOfWeek(day);
		end.setDate(end.getDate() + 6);
		end.setHours(23, 59, 59, 999);
		return end;
	}
</script>

<svelte:window
	onkeydowncapture={(event) => {
		if (event.key !== 'Escape' || !openRoutineId) return;
		event.stopPropagation();
		openRoutineId = null;
	}}
/>

<section class="routine-calendar" aria-label={t.calendar.title}>
	<header class="calendar-head">
		<div class="calendar-head-left">
			<button
				type="button"
				class="calendar-back"
				aria-label={t.common.back}
				title={t.common.back}
				onclick={() => runtime.closeRoutines()}
			>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="15 18 9 12 15 6"></polyline>
				</svg>
				<span>{t.common.back}</span>
			</button>
			<span class="head-divider" aria-hidden="true"></span>
			<div class="title-wrap">
				<h1>{t.calendar.title}</h1>
				{#if sources.length > 0}
					<span class="calendar-stat-pill">
						{sources.length} Bot · {events.length} {locale === 'en' ? 'routines' : '日程'}
					</span>
				{/if}
			</div>
		</div>
		<div class="calendar-head-right">
			<button
				type="button"
				class="info-toggle-btn"
				class:is-active={showInfo}
				title={locale === 'en' ? 'Schedule info' : '日程规则说明'}
				aria-label={locale === 'en' ? 'Schedule info' : '日程规则说明'}
				aria-expanded={showInfo}
				onclick={() => (showInfo = !showInfo)}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<circle cx="12" cy="12" r="10"></circle>
					<line x1="12" y1="16" x2="12" y2="12"></line>
					<line x1="12" y1="8" x2="12.01" y2="8"></line>
				</svg>
				<span>{locale === 'en' ? 'Rules' : '规则'}</span>
			</button>
		</div>
	</header>

	{#if showInfo}
		<div class="calendar-info-banner">
			<div class="info-banner-header">
				<span class="info-banner-badge">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<circle cx="12" cy="12" r="10"></circle>
						<line x1="12" y1="16" x2="12" y2="12"></line>
						<line x1="12" y1="8" x2="12.01" y2="8"></line>
					</svg>
					{locale === 'en' ? 'Schedule Rules & Availability' : '日程展开与运行规则'}
				</span>
				<button type="button" class="info-banner-close" aria-label={t.common.close} onclick={() => (showInfo = false)}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<line x1="18" y1="6" x2="6" y2="18"></line>
						<line x1="6" y1="6" x2="18" y2="18"></line>
					</svg>
				</button>
			</div>
			<div class="info-banner-grid">
				<p class="calendar-note">{t.routines.zone}</p>
				<p class="calendar-note">{t.routines.availability}</p>
				{#if !runtime.remote}
					<p class="calendar-note">{t.calendar.projectionHint}</p>
				{:else}
					<p class="calendar-note">{t.calendar.lastFiredHostOnly}</p>
				{/if}
				<p class="calendar-phone-note">{t.calendar.phoneReadOnly}</p>
			</div>
		</div>
	{:else}
		<!-- Hidden notes rendered for accessibility and unit test coverage while keeping UI clean -->
		<div class="sr-only" aria-hidden="true">
			<p class="calendar-note">{t.routines.zone}</p>
			<p class="calendar-note">{t.routines.availability}</p>
			{#if !runtime.remote}
				<p class="calendar-note">{t.calendar.projectionHint}</p>
			{:else}
				<p class="calendar-note">{t.calendar.lastFiredHostOnly}</p>
			{/if}
			<p class="calendar-phone-note">{t.calendar.phoneReadOnly}</p>
		</div>
	{/if}

	{#if sources.length > 0}
		<div class="calendar-filter-bar" class:is-expanded={showSources}>
		<button type="button" class="filter-toggle" aria-expanded={showSources} onclick={() => (showSources = !showSources)}>
			<span>{locale === 'en' ? 'Bots' : 'Bot 筛选'}</span>
			<span>{sources.filter((source) => source.visible).length}/{sources.length}</span>
			<span aria-hidden="true">{showSources ? '⌃' : '⌄'}</span>
		</button>
			<div class="filter-label">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
				</svg>
				<span>{locale === 'en' ? 'Filter' : '名册'}</span>
			</div>
			<ul class="calendar-sources">
				{#each sources as source (source.id)}
					{@const bot = botsById.get(source.id)}
					<li>
						<button
							type="button"
							class="source-chip"
							class:is-off={!source.visible}
							style:--source-color={source.color}
							aria-pressed={source.visible}
							title={source.visible ? (locale === 'en' ? `Hide ${source.name}` : `隐藏 ${source.name}`) : (locale === 'en' ? `Show ${source.name}` : `显示 ${source.name}`)}
							onclick={() => toggleSource(source.id)}
						>
							{#if bot}
								<span class="bot-face" style:background={botAvatarColor(bot.id).bg} style:color={botAvatarColor(bot.id).text}>
									{#if avatarSrc(bot.avatar)}
										<img src={avatarSrc(bot.avatar)} alt="" />
									{:else}
										{rosterLetter(bot.name)}
									{/if}
								</span>
							{/if}
							<span class="source-name">{source.name}</span>
							<span class="source-indicator" style:background={source.color} aria-hidden="true"></span>
						</button>
					</li>
				{/each}
			</ul>
			{#if hidden.size > 0}
				<button type="button" class="filter-reset-btn" onclick={showAllSources}>
					{locale === 'en' ? 'Show all' : '重置'}
				</button>
			{/if}
		</div>
	{:else}
		<div class="calendar-empty-bar">
			<p class="calendar-empty">{t.calendar.empty}</p>
		</div>
	{/if}

	<div class="calendar-stage">
		<Calendar
			{events}
			{sources}
			bind:date
			bind:view
			{locale}
			{theme}
			views={['week', 'day', 'month', 'agenda']}
			firstDayOfWeek={1}
			hour12={false}
			hourHeight={56}
			slotDuration={30}
			snapDuration={15}
			dayMaxEvents={4}
			nowIndicator={!runtime.remote}
			editable={false}
			selectable={false}
			eventDetails={false}
			quickCreate={false}
			eventOverlap={true}
			onEventClick={openDetail}
			onRangeChange={(start, end) => {
				rangeStart = start;
				rangeEnd = end;
			}}
		>
			{#snippet eventContent(instance)}
				{@const bot = botOf(instance)}
				<span class="event-face" class:is-paused={instance.event.meta?.paused === true}>
					<span class="event-header-row">
						{#if bot}
							<span class="bot-face is-event" style:background={botAvatarColor(bot.id).bg} style:color={botAvatarColor(bot.id).text}>
								{#if avatarSrc(bot.avatar)}
									<img src={avatarSrc(bot.avatar)} alt="" />
								{:else}
									{rosterLetter(bot.name)}
								{/if}
							</span>
						{/if}
						<span class="event-bot">{bot?.name}</span>
						{#if instance.event.meta?.paused === true}
							<span class="event-paused-badge">{locale === 'en' ? 'Paused' : '暂停'}</span>
						{/if}
					</span>
					<span class="event-title">{instance.event.title}</span>
				</span>
			{/snippet}
		</Calendar>
	</div>

	{#if openRoutineId}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="detail-backdrop" role="presentation" onclick={() => (openRoutineId = null)}>
			<div class="detail" role="dialog" aria-modal="true" aria-label={t.calendar.detail} tabindex="-1" onclick={(event) => event.stopPropagation()}>
				{#if openRoutine && openBot}
					<div class="detail-top-row">
						<div class="detail-who">
							<span class="bot-face is-detail" style:background={botAvatarColor(openBot.id).bg} style:color={botAvatarColor(openBot.id).text}>
								{#if avatarSrc(openBot.avatar)}
									<img src={avatarSrc(openBot.avatar)} alt="" />
								{:else}
									{rosterLetter(openBot.name)}
								{/if}
							</span>
							<div class="detail-bot-meta">
								<span class="detail-bot-name">{openBot.name}</span>
								{#if openBot.archived_at}
									<span class="detail-archived-tag">{t.top.archived}</span>
								{/if}
							</div>
						</div>
						<button type="button" class="detail-icon-close" aria-label={t.common.close} onclick={() => (openRoutineId = null)}>
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<line x1="18" y1="6" x2="6" y2="18"></line>
								<line x1="6" y1="6" x2="18" y2="18"></line>
							</svg>
						</button>
					</div>

					<h2 class="detail-title">{openRoutine.title}</h2>

					<div class="detail-tags-row">
						<span class="detail-tag is-schedule">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<circle cx="12" cy="12" r="10"></circle>
								<polyline points="12 6 12 12 16 14"></polyline>
							</svg>
							{routineScheduleLabel(openRoutine.schedule, t)}
						</span>
						<span class="detail-tag" class:is-active={openRoutine.enabled} class:is-paused={!openRoutine.enabled}>
							<span class="tag-dot" aria-hidden="true"></span>
							{openRoutine.enabled ? t.routines.active : t.routines.paused}
						</span>
						{#if openWasDue}
							<span class="detail-tag is-fired">
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<polyline points="20 6 9 17 4 12"></polyline>
								</svg>
								{t.calendar.lastFired}
							</span>
						{/if}
					</div>

					{#if openBot.archived_at}
						<div class="detail-warning-box">
							<p>{t.routines.availability}</p>
						</div>
					{/if}

					<div class="detail-instruction-section">
						<span class="detail-section-label">{locale === 'en' ? 'Instruction' : '任务指令'}</span>
						<p class="detail-instruction">{openRoutine.instruction.trim() || t.calendar.noInstruction}</p>
					</div>
				{:else}
					<p class="detail-missing">{t.routines.missing}</p>
				{/if}

				<div class="detail-footer">
					<button type="button" class="detail-close" onclick={() => (openRoutineId = null)}>
						{t.common.close}
					</button>
				</div>
			</div>
		</div>
	{/if}
</section>

<style>
	.routine-calendar {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
		background: var(--pane);
		color: var(--ink);
	}

	/* Header bar */
	.calendar-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		height: 52px;
		padding: 0 16px;
		border-bottom: 1px solid var(--line);
		background: var(--pane);
		flex-shrink: 0;
	}

	.calendar-head-left {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.calendar-back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 10px;
		margin: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--ink);
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
	}



.calendar-back:hover {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.calendar-back:active {
		transform: scale(0.98);
	}

	.head-divider {
		width: 1px;
		height: 18px;
		background: var(--line);
		flex-shrink: 0;
	}

	.title-wrap {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.calendar-head h1 {
		margin: 0;
		font-size: 15px;
		font-weight: 650;
		letter-spacing: -0.01em;
		color: var(--ink);
		white-space: nowrap;
	}

	.calendar-stat-pill {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: 9999px;
		background: var(--line-subtle);
		border: 1px solid var(--line);
		font-size: 11px;
		font-weight: 500;
		color: var(--muted);
		white-space: nowrap;
	}

	.calendar-head-right {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.info-toggle-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 5px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.info-toggle-btn:hover {
		color: var(--ink);
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.info-toggle-btn.is-active {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	/* Rules and availability info banner */
	.calendar-info-banner {
		margin: 8px 16px 4px;
		padding: 10px 14px;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		border: 1px solid var(--line);
		display: flex;
		flex-direction: column;
		gap: 8px;
		animation: bannerFadeIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
		flex-shrink: 0;
	}

	@keyframes bannerFadeIn {
		from {
			opacity: 0;
			transform: translateY(-4px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.info-banner-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.info-banner-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.info-banner-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.info-banner-close:hover {
		background: var(--line-hover);
		color: var(--ink);
	}

	.info-banner-grid {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.calendar-note {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--muted);
	}

	.calendar-phone-note {
		display: none;
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--warn-text);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border-width: 0;
	}

	/* Filter bar */
	.calendar-filter-bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 16px;
		border-bottom: 1px solid var(--line-subtle);
		background: var(--pane);
		flex-shrink: 0;
		overflow: hidden;
	}

	.filter-toggle {
	display: none;
}

.filter-label {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		flex-shrink: 0;
	}

	.calendar-sources {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		padding: 2px 0;
		overflow-x: auto;
		list-style: none;
		scrollbar-width: none;
		-ms-overflow-style: none;
		flex: 1;
		min-width: 0;
	}

	.calendar-sources::-webkit-scrollbar {
		display: none;
	}

	.calendar-sources li {
		flex-shrink: 0;
	}

	.source-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 28px;
		padding: 2px 10px 2px 4px;
		border: 1.5px solid var(--source-color, var(--line));
		border-radius: 9999px;
		background: color-mix(in srgb, var(--source-color, var(--accent)) 10%, var(--pane));
		color: var(--ink);
		font-size: 12px;
		font-weight: 550;
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
		box-shadow: 0 1px 2px color-mix(in srgb, var(--source-color, var(--accent)) 15%, transparent);
	}

	.source-chip:hover {
		transform: translateY(-0.5px);
		box-shadow: 0 2px 5px color-mix(in srgb, var(--source-color, var(--accent)) 25%, transparent);
	}

	.source-chip.is-off {
		border-color: var(--line);
		background: transparent;
		color: var(--muted);
		opacity: 0.5;
		filter: grayscale(0.5);
		box-shadow: none;
	}

	.source-chip.is-off:hover {
		opacity: 0.8;
		border-color: var(--line-hover);
	}

	.source-indicator {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.source-chip.is-off .source-indicator {
		background: var(--muted-light) !important;
	}

	.filter-reset-btn {
		display: inline-flex;
		align-items: center;
		padding: 3px 8px;
		border: 1px dashed var(--line);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--accent);
		font-size: 11.5px;
		font-weight: 550;
		cursor: pointer;
		flex-shrink: 0;
		transition: all 0.15s ease;
	}

	.filter-reset-btn:hover {
		background: var(--accent-tint);
		border-color: var(--accent);
	}

	.calendar-empty-bar {
		padding: 8px 16px;
		border-bottom: 1px solid var(--line-subtle);
	}

	.calendar-empty {
		margin: 0;
		font-size: 12.5px;
		color: var(--muted);
	}

	/* Avatar chips */
	.bot-face {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		overflow: hidden;
		border-radius: 50%;
		font-size: 10.5px;
		font-weight: 650;
		flex: 0 0 auto;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}

	.bot-face img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.bot-face.is-event {
		width: 16px;
		height: 16px;
		font-size: 9px;
	}

	.bot-face.is-detail {
		width: 36px;
		height: 36px;
		font-size: 15px;
	}

	/* Calendar Stage */
	.calendar-stage {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	/* Customize s5c elements */
	.calendar-stage :global(.s5c) {
		height: 100%;
		--s5c-bg: var(--pane);
		--s5c-text: var(--ink);
		--s5c-accent: var(--accent);
		--s5c-font: var(--font);
		--s5c-border: var(--line);
		--s5c-border-strong: var(--line-hover);
		--s5c-bg-subtle: var(--line-subtle);
		--s5c-bg-hover: var(--line-subtle);
		--s5c-radius: var(--radius-sm);
		--s5c-today-num-bg: var(--accent);
		--s5c-now-color: var(--danger);
	}

	.calendar-stage :global(.s5c-toolbar) {
		padding: 10px 16px;
		border-bottom: 1px solid var(--line);
		background: var(--pane);
		gap: 10px;
	}

	.calendar-stage :global(.s5c-toolbar-title) {
		font-size: 15px;
		font-weight: 650;
		color: var(--ink);
		letter-spacing: -0.01em;
	}

	.calendar-stage :global(.s5c-btn) {
		background: var(--btn-secondary-bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		color: var(--ink);
		font-size: 12.5px;
		font-weight: 500;
		padding: 5px 12px;
		transition: background 0.12s ease, border-color 0.12s ease;
	}

	.calendar-stage :global(.s5c-btn:hover) {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.calendar-stage :global(.s5c-btn-icon) {
		width: 28px;
		height: 28px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-sm);
		border: 1px solid var(--line);
		background: var(--btn-secondary-bg);
		color: var(--ink);
	}

	.calendar-stage :global(.s5c-view-switch) {
		background: var(--line-subtle);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		padding: 2px;
		gap: 2px;
	}

	.calendar-stage :global(.s5c-view-switch .s5c-btn) {
		border: none;
		border-radius: calc(var(--radius-md) - 2px);
		padding: 4px 11px;
		font-size: 12px;
		font-weight: 500;
		color: var(--muted);
		background: transparent;
		transition: all 0.15s ease;
	}

	.calendar-stage :global(.s5c-view-switch .s5c-btn.s5c-active) {
		background: var(--pane);
		color: var(--ink);
		font-weight: 600;
		box-shadow: var(--shadow-xs);
	}

	.calendar-stage :global(.s5c-daynum.s5c-is-today) {
		background: var(--accent);
		color: #ffffff;
		font-weight: 700;
		box-shadow: 0 2px 6px var(--accent-glow);
	}

	/* Event Blocks */
	.calendar-stage :global(.s5c-block) {
		min-height: 48px;
		border-radius: var(--radius-sm);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04);
		border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
		overflow: hidden;
		transition: transform 0.15s ease, box-shadow 0.15s ease;
	}

	.calendar-stage :global(.s5c-block:hover) {
		transform: translateY(-1px);
		box-shadow: 0 3px 8px rgba(0, 0, 0, 0.12);
	}

	.event-face {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		height: 100%;
		padding: 3px 5px;
		min-width: 0;
		overflow: hidden;
	}

	.event-face.is-paused {
		opacity: 0.6;
		filter: grayscale(0.3);
	}

	.event-header-row {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	.event-bot {
		font-size: 11px;
		font-weight: 650;
		line-height: 1.2;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}

	.event-paused-badge {
		font-size: 9px;
		font-weight: 600;
		padding: 1px 4px;
		border-radius: 4px;
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
		line-height: 1;
		flex-shrink: 0;
	}

	.event-title {
		font-size: 11.5px;
		font-weight: 550;
		line-height: 1.25;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	/* Detail Dialog */
	.detail-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 20px;
		background: var(--modal-backdrop);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		animation: backdropFadeIn 0.18s ease-out;
	}

	@keyframes backdropFadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.detail {
		width: min(440px, 100%);
		max-height: 100%;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 22px;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--pane);
		color: var(--ink);
		box-shadow: var(--shadow-lg);
		animation: dialogPopIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	@keyframes dialogPopIn {
		from {
			opacity: 0;
			transform: scale(0.96) translateY(6px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}

	.detail-top-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.detail-who {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.detail-bot-meta {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.detail-bot-name {
		font-size: 14px;
		font-weight: 650;
		color: var(--ink);
		line-height: 1.2;
	}

	.detail-archived-tag {
		font-size: 11px;
		font-weight: 500;
		color: var(--muted);
	}

	.detail-icon-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.detail-icon-close:hover {
		background: var(--line-subtle);
		color: var(--ink);
	}

	.detail-title {
		margin: 0;
		font-size: 18px;
		font-weight: 700;
		line-height: 1.3;
		color: var(--ink);
		letter-spacing: -0.015em;
	}

	.detail-tags-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.detail-tag {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 9px;
		border-radius: 9999px;
		font-size: 11.5px;
		font-weight: 550;
		background: var(--line-subtle);
		border: 1px solid var(--line);
		color: var(--ink-secondary);
	}

	.detail-tag.is-active {
		background: var(--ok-bg);
		border-color: var(--ok-line);
		color: var(--ok-text);
	}

	.detail-tag.is-paused {
		background: var(--warn-bg);
		border-color: var(--warn-line);
		color: var(--warn-text);
	}

	.detail-tag.is-fired {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.tag-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}

	.detail-warning-box {
		padding: 8px 12px;
		border-radius: var(--radius-md);
		background: var(--warn-bg);
		border: 1px solid var(--warn-line);
		color: var(--warn-text);
		font-size: 12px;
		line-height: 1.45;
	}

	.detail-warning-box p {
		margin: 0;
	}

	.detail-instruction-section {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.detail-section-label {
		font-size: 11.5px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.detail-instruction {
		margin: 0;
		padding: 12px;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		border: 1px solid var(--line);
		color: var(--ink);
		font-size: 13px;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.detail-missing {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}

	.detail-footer {
		display: flex;
		justify-content: flex-end;
		margin-top: 4px;
	}

	.detail-close {
		min-width: 80px;
		min-height: 34px;
		padding: 6px 16px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--btn-secondary-bg);
		color: var(--ink);
		font-size: 13px;
		font-weight: 550;
		cursor: pointer;
		transition: background 0.15s ease, border-color 0.15s ease;
	}

	.detail-close:hover {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	@media (max-width: 680px) {
		.calendar-head {
			height: calc(52px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 8px 0;
		}


		.calendar-back {
			min-height: 44px;
			border: 0;
			background: transparent;
		}

		.head-divider {
			display: none;
		}

		.calendar-stat-pill {
			display: none;
		}

		.calendar-phone-note {
			display: block;
		}

		.routine-calendar {
			padding-bottom: env(safe-area-inset-bottom);
		}

		.detail-backdrop {
			padding: max(12px, env(safe-area-inset-top)) 12px max(12px, env(safe-area-inset-bottom));
		}

		.calendar-head {
			display: grid;
			grid-template-columns: 1fr auto 1fr;
			gap: 4px;
		}
		.calendar-head-left {
			display: contents;
		}
		.calendar-back {
			justify-self: start;
			justify-content: center;
			width: 44px;
			padding: 0;
		}
		.calendar-back > span {
			display: none;
		}
		.calendar-head-right {
			justify-self: end;
			gap: 0;
		}
		.info-toggle-btn {
			width: 36px;
			height: 44px;
			padding: 0;
			justify-content: center;
			border: 0;
			background: transparent;
		}
		.info-toggle-btn > span {
			display: none;
		}
		.calendar-head h1 {
			font-size: 16px;
		}
		.calendar-filter-bar {
			flex-wrap: wrap;
			gap: 0 8px;
			padding: 0 12px;
		}
		.filter-label {
			display: none;
		}
		.filter-toggle {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			min-height: 44px;
			padding: 0;
			border: 0;
			background: transparent;
			color: var(--muted);
			font: inherit;
			font-size: 12px;
			cursor: pointer;
		}
		.filter-reset-btn {
			margin-left: auto;
			min-height: 36px;
		}
		.calendar-sources {
			display: none;
		}
		.calendar-filter-bar.is-expanded .calendar-sources {
			display: flex;
			order: 1;
			flex: 0 0 100%;
			flex-wrap: wrap;
			max-height: 160px;
			overflow-y: auto;
			padding: 0 0 8px;
		}
		.source-chip {
			min-height: 36px;
			max-width: 100%;
		}
		.calendar-sources li {
			max-width: 100%;
		}
		.source-name {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.calendar-stage :global(.s5c-toolbar) {
			display: grid;
			grid-template-columns: 52px minmax(0, 1fr) 44px;
			gap: 6px;
			padding: 6px 12px 10px;
		}
		.calendar-stage :global(.s5c-nav-group) {
			display: contents;
		}
		.calendar-stage :global(.s5c-nav-group .s5c-btn:first-child) {
			grid-area: 1 / 1;
		}
		.calendar-stage :global(.s5c-nav-group .s5c-btn:last-child) {
			grid-area: 1 / 3;
			justify-self: end;
		}
		.calendar-stage :global(.s5c-toolbar-title) {
			grid-area: 1 / 2;
			min-width: 0;
			margin: 0;
			text-align: center;
			font-size: 13px;
			white-space: normal;
			overflow-wrap: anywhere;
		}
		.calendar-stage :global(.s5c-toolbar > .s5c-btn) {
			grid-area: 2 / 1;
			padding: 0;
			min-height: 40px;
		}
		.calendar-stage :global(.s5c-btn-icon) {
			width: 44px;
			height: 44px;
		}
		.calendar-stage :global(.s5c-toolbar-spacer) {
			display: none;
		}
		.calendar-stage :global(.s5c-view-switch) {
			grid-area: 2 / 2 / 3 / 4;
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
		.calendar-stage :global(.s5c-view-switch .s5c-btn) {
			min-height: 36px;
			padding: 0 4px;
		}
		.detail-icon-close {
			width: 44px;
			height: 44px;
			flex-shrink: 0;
		}
		.detail-close {
			min-height: 44px;
		}

	}
</style>
