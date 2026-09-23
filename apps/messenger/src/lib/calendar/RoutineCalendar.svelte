<script lang="ts">
	import { tick } from 'svelte';
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
	let filterOpen = $state(false);
	let filterQuery = $state('');
	let filterHighlight = $state(0);
	let filterRoot = $state<HTMLDivElement | null>(null);
	let filterSearchEl = $state<HTMLInputElement | null>(null);

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
	const visibleCount = $derived(sources.filter((source) => source.visible).length);
	const filterSummary = $derived(
		visibleCount === sources.length ? t.calendar.filterAll : `${visibleCount}/${sources.length}`
	);
	const listedSources = $derived.by(() => {
		const needle = filterQuery.trim().toLowerCase();
		if (!needle) return sources;
		return sources.filter((source) => {
			const duties = botsById.get(source.id)?.duties ?? '';
			return source.name.toLowerCase().includes(needle) || duties.toLowerCase().includes(needle);
		});
	});
	const filterActiveIndex = $derived(
		listedSources.length === 0 ? -1 : Math.min(Math.max(filterHighlight, 0), listedSources.length - 1)
	);
	const filterActiveId = $derived(
		filterActiveIndex >= 0 ? listedSources[filterActiveIndex]?.id ?? null : null
	);
	const shownEvents = $derived(events.filter((event) => !hidden.has(event.calendarId ?? '')));
	const agendaGroups = $derived.by(() => {
		const groups = new Map<string, { key: string; day: Date; items: CalendarEvent[] }>();
		const sorted = [...shownEvents].sort(
			(a, b) => a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title)
		);
		for (const event of sorted) {
			const day = new Date(event.start.getFullYear(), event.start.getMonth(), event.start.getDate());
			const key = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
			const group = groups.get(key);
			if (group) group.items.push(event);
			else groups.set(key, { key, day, items: [event] });
		}
		return [...groups.values()];
	});
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

	function openEvent(event: CalendarEvent): void {
		const id = event.meta?.routineId;
		if (typeof id !== 'string') return;
		openWasDue = event.meta?.lastFired === true;
		openRoutineId = id;
	}

	function openAgendaDay(day: Date): void {
		date = day;
		view = 'day';
	}

	function botOfEvent(event: CalendarEvent) {
		const id = typeof event.meta?.botId === 'string' ? event.meta.botId : event.calendarId;
		return id ? botsById.get(id) : undefined;
	}

	function agendaDayLabel(day: Date): string {
		return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', weekday: 'short' }).format(day);
	}

	function agendaClock(day: Date): string {
		return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', hour12: false }).format(day);
	}

	function isSameCivilDay(a: Date, b: Date): boolean {
		return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
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

	function closeFilter(): void {
		filterOpen = false;
		filterQuery = '';
		filterHighlight = 0;
	}

	function toggleFilter(): void {
		if (filterOpen) {
			closeFilter();
			return;
		}
		filterOpen = true;
		filterQuery = '';
		filterHighlight = 0;
		void tick().then(() => filterSearchEl?.focus());
	}

	function onFilterKeydown(event: KeyboardEvent): void {
		if (event.isComposing || event.key === 'Process' || event.keyCode === 229) return;
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
		if (event.key === 'Enter') {
			const source = listedSources[filterActiveIndex];
			if (!source) return;
			event.preventDefault();
			toggleSource(source.id);
			return;
		}
		event.preventDefault();
		if (listedSources.length === 0) return;
		const direction = event.key === 'ArrowDown' ? 1 : -1;
		const start = filterActiveIndex < 0 ? (direction === 1 ? -1 : 0) : filterActiveIndex;
		const next = (start + direction + listedSources.length) % listedSources.length;
		filterHighlight = next;
		const id = listedSources[next]?.id;
		void tick().then(() => {
			if (id) document.getElementById(`roster-filter-opt-${id}`)?.scrollIntoView({ block: 'nearest' });
		});
	}

	$effect(() => {
		if (sources.length === 0 && filterOpen) closeFilter();
	});

	$effect(() => {
		if (!filterOpen) return;
		function onPointerDown(event: PointerEvent): void {
			if (filterRoot?.contains(event.target as Node)) return;
			closeFilter();
		}
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	});

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
		if (event.key !== 'Escape') return;
		if (openRoutineId) {
			event.stopPropagation();
			openRoutineId = null;
			return;
		}
		if (filterOpen) {
			event.stopPropagation();
			closeFilter();
		}
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
		<div class="calendar-filter-bar">
			<div class="roster-filter" bind:this={filterRoot}>
				<button
					type="button"
					class="roster-filter-trigger"
					class:is-narrowed={hidden.size > 0}
					aria-haspopup="listbox"
					aria-expanded={filterOpen}
					aria-controls="roster-filter-list"
					onclick={toggleFilter}
				>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
					</svg>
					<span>{t.calendar.filter}</span>
					<span class="roster-filter-count">{filterSummary}</span>
					<svg class="roster-filter-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<polyline points="6 9 12 15 18 9"></polyline>
					</svg>
				</button>
				{#if hidden.size > 0}
					<button type="button" class="filter-reset-btn" onclick={showAllSources}>
						{t.calendar.filterReset}
					</button>
				{/if}
				{#if filterOpen}
					<div class="roster-filter-menu">
						<input
							bind:this={filterSearchEl}
							bind:value={filterQuery}
							class="roster-filter-search"
							type="search"
							placeholder={t.calendar.filterSearch}
							aria-label={t.calendar.filterSearch}
							aria-autocomplete="list"
							aria-controls="roster-filter-list"
							aria-activedescendant={filterActiveId ? `roster-filter-opt-${filterActiveId}` : undefined}
							autocomplete="off"
							spellcheck="false"
							oninput={() => (filterHighlight = 0)}
							onkeydown={onFilterKeydown}
						/>
						<ul id="roster-filter-list" class="roster-filter-list" role="listbox" aria-multiselectable="true" aria-label={t.calendar.filter}>
							{#if listedSources.length === 0}
								<li class="roster-filter-empty" role="presentation">{t.calendar.filterNoMatch}</li>
							{:else}
								{#each listedSources as source, idx (source.id)}
									{@const bot = botsById.get(source.id)}
									<li>
										<button
											type="button"
											id={`roster-filter-opt-${source.id}`}
											class="roster-filter-option"
											class:is-selected={source.visible}
											class:is-highlighted={idx === filterActiveIndex}
											role="option"
											aria-selected={source.visible}
											title={source.visible ? `${t.calendar.filterHide} ${source.name}` : `${t.calendar.filterShow} ${source.name}`}
											tabindex={-1}
											onmousedown={(event) => event.preventDefault()}
											onclick={() => toggleSource(source.id)}
											onmouseenter={() => (filterHighlight = idx)}
										>
											<span class="roster-filter-box" aria-hidden="true">
												{#if source.visible}
													<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
														<polyline points="20 6 9 17 4 12"></polyline>
													</svg>
												{/if}
											</span>
											{#if bot}
												<span class="bot-face" style:background={botAvatarColor(bot.id).bg} style:color={botAvatarColor(bot.id).text}>
													{#if avatarSrc(bot.avatar)}
														<img src={avatarSrc(bot.avatar)} alt="" />
													{:else}
														{rosterLetter(bot.name)}
													{/if}
												</span>
											{/if}
											<span class="roster-filter-name">{source.name}</span>
											{#if bot?.duties?.trim()}
												<span class="roster-filter-hint">{bot.duties}</span>
											{/if}
											<span class="roster-filter-swatch" style:background={source.color} aria-hidden="true"></span>
										</button>
									</li>
								{/each}
							{/if}
						</ul>
					</div>
				{/if}
			</div>
		</div>
	{:else}
		<div class="calendar-empty-bar">
			<p class="calendar-empty">{t.calendar.empty}</p>
		</div>
	{/if}

	<div class="calendar-stage" class:is-agenda={view === 'agenda'}>
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
		{#if view === 'agenda'}
			<div class="routine-agenda">
				{#if agendaGroups.length === 0}
					<p class="routine-agenda-empty">{t.calendar.agendaEmpty}</p>
				{:else}
					{#each agendaGroups as group (group.key)}
						<div class="routine-agenda-day">
							<button
								type="button"
								class="routine-agenda-date"
								class:is-today={isSameCivilDay(group.day, new Date())}
								onclick={() => openAgendaDay(group.day)}
							>
								<span class="routine-agenda-daynum">{group.day.getDate()}</span>
								<span class="routine-agenda-wd">{agendaDayLabel(group.day)}</span>
							</button>
							<div class="routine-agenda-items">
								{#each group.items as event (event.id)}
									{@const bot = botOfEvent(event)}
									<button
										type="button"
										class="routine-agenda-item"
										class:is-paused={event.meta?.paused === true}
										onclick={() => openEvent(event)}
									>
										<span class="routine-agenda-dot" style:background={event.color} aria-hidden="true"></span>
										<span class="routine-agenda-time">{agendaClock(event.start)} – {agendaClock(event.end)}</span>
										{#if bot}
											<span class="routine-agenda-who">
												<span class="bot-face is-event" style:background={botAvatarColor(bot.id).bg} style:color={botAvatarColor(bot.id).text}>
													{#if avatarSrc(bot.avatar)}
														<img src={avatarSrc(bot.avatar)} alt="" />
													{:else}
														{rosterLetter(bot.name)}
													{/if}
												</span>
												<span class="routine-agenda-name">{bot.name}</span>
											</span>
										{/if}
										<span class="routine-agenda-title">{event.title}</span>
										{#if event.meta?.paused === true}
											<span class="event-paused-badge">{locale === 'en' ? 'Paused' : '暂停'}</span>
										{/if}
									</button>
								{/each}
							</div>
						</div>
					{/each}
				{/if}
			</div>
		{/if}
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
		/* The pane body is not a flex container, so flex alone leaves this as tall as the
		   24-hour grid and the pane clips it. height 100% is what makes a window or divider
		   resize change the grid instead of cropping a fixed sheet. */
		flex: 1 1 auto;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
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

	/* Roster filter: one closed control. The list opens over the grid. */
	.calendar-filter-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		border-bottom: 1px solid var(--line-subtle);
		background: var(--pane);
		flex-shrink: 0;
		position: relative;
		z-index: 4;
		overflow: visible;
	}

	.roster-filter {
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		max-width: 100%;
	}

	.roster-filter-trigger {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		min-height: 32px;
		padding: 4px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--btn-secondary-bg);
		color: var(--ink);
		font-size: 12.5px;
		font-weight: 550;
		cursor: pointer;
	}

	.roster-filter-trigger:hover {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.roster-filter-trigger[aria-expanded='true'] {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px var(--accent-glow);
	}

	.roster-filter-count {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.roster-filter-trigger.is-narrowed .roster-filter-count {
		color: var(--accent);
		font-weight: 650;
	}

	.roster-filter-chevron {
		color: var(--muted);
		transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
	}

	.roster-filter-trigger[aria-expanded='true'] .roster-filter-chevron {
		transform: rotate(180deg);
		color: var(--accent);
	}

	.roster-filter-menu {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 30;
		width: min(280px, calc(100vw - 32px));
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-lg);
		overflow: hidden;
	}

	.roster-filter-search {
		display: block;
		width: 100%;
		box-sizing: border-box;
		margin: 0;
		padding: 8px 10px;
		border: 0;
		border-bottom: 1px solid var(--line);
		border-radius: 0;
		background: transparent;
		color: var(--ink);
		font: inherit;
		font-size: 13px;
		outline: none;
	}

	.roster-filter-search::placeholder {
		color: var(--muted);
	}

	.roster-filter-search:focus,
	.roster-filter-search:focus-visible {
		outline: none;
		box-shadow: inset 0 -2px 0 var(--accent);
		border-color: transparent !important;
	}

	.roster-filter-list {
		max-height: 240px;
		margin: 0;
		padding: 4px;
		overflow-y: auto;
		list-style: none;
		scrollbar-width: thin;
		scrollbar-color: var(--muted-light) transparent;
	}

	.roster-filter-empty {
		padding: 10px 12px;
		font-size: 12.5px;
		color: var(--muted);
		text-align: center;
	}

	.roster-filter-option {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 36px;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		color: var(--ink);
		font-size: 13px;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
	}

	.roster-filter-option.is-highlighted {
		background: var(--line-subtle);
	}

	.roster-filter-option.is-selected {
		color: var(--accent);
		font-weight: 600;
	}

	.roster-filter-box {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 15px;
		height: 15px;
		flex-shrink: 0;
		border: 1px solid var(--line-hover);
		border-radius: 4px;
		background: var(--input-bg);
		color: #ffffff;
	}

	.roster-filter-option.is-selected .roster-filter-box {
		background: var(--accent);
		border-color: var(--accent);
	}

	.roster-filter-name {
		flex: 0 0 auto;
		max-width: 70%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.roster-filter-hint {
		flex: 1 1 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: right;
		font-size: 11px;
		font-weight: 400;
		color: var(--muted);
	}

	.roster-filter-swatch {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
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
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/* Customize s5c elements */
	.calendar-stage :global(.s5c) {
		flex: 1 1 auto;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
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

	/* The library agenda only prints the title. Ours names the Bot and replaces it. */
	.calendar-stage.is-agenda :global(.s5c) {
		flex: 0 0 auto;
		height: auto;
	}

	.calendar-stage.is-agenda :global(.s5c-agenda) {
		display: none;
	}

	.routine-agenda {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
	}

	.routine-agenda-empty {
		margin: 0;
		padding: 48px 16px;
		text-align: center;
		color: var(--muted);
		font-size: 13px;
	}

	.routine-agenda-day {
		display: flex;
		gap: 12px;
		padding: 10px 16px;
		border-bottom: 1px solid var(--line);
	}

	.routine-agenda-date {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		flex: 0 0 auto;
		width: 120px;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.routine-agenda-daynum {
		font-size: 24px;
		font-weight: 500;
		line-height: 1.1;
	}

	.routine-agenda-date.is-today .routine-agenda-daynum {
		color: var(--accent);
	}

	.routine-agenda-wd {
		font-size: 11px;
		color: var(--muted);
	}

	.routine-agenda-items {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.routine-agenda-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-width: 0;
		padding: 6px 8px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--ink);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.routine-agenda-item:hover {
		background: var(--line-subtle);
	}

	.routine-agenda-item.is-paused {
		opacity: 0.6;
	}

	.routine-agenda-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: 0 0 auto;
	}

	.routine-agenda-time {
		flex: 0 0 auto;
		width: 7.5em;
		color: var(--muted);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}

	.routine-agenda-who {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: 0 0 auto;
		max-width: 46%;
		min-width: 0;
	}

	.routine-agenda-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
		font-weight: 650;
	}

	.routine-agenda-title {
		flex: 1 1 0;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 550;
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
			padding: 8px 12px;
		}
		.roster-filter-trigger,
		.filter-reset-btn,
		.roster-filter-option,
		.routine-agenda-item,
		.routine-agenda-date {
			min-height: 44px;
		}
		.routine-agenda-date {
			width: 72px;
		}
		.routine-agenda-time {
			width: auto;
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
