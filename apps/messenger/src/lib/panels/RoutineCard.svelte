<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { Bot, Routine } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import DangerDialog from '../overlays/DangerDialog.svelte';
	import { WEEKDAYS, planRoutine, routineDirty, routineDraft, routineError, routineScheduleLabel } from './routine-form.ts';

	let { runtime, bot, t }: { runtime: MessengerRuntime; bot: Bot; t: Copy } = $props();
	const routines = $derived(runtime.snapshot.routines.filter((row) => row.bot_id === bot.id));
	let editing = $state<string | null>(null);
	let baseline = $state<Routine | null>(null);
	let draft = $state(routineDraft());
	let errors = $state<ReturnType<typeof planRoutine>['errors']>({});
	let failure = $state('');
	let busy = $state(false);
	let deleting = $state<Routine | null>(null);
	let pending = $state<{ id: string; api: MessengerApi } | null>(null);
	let notice = $state('');
	let retiredDraft = $state(false);
	const retryable = $derived(pending && pending.api === runtime.client && runtime.pendingMutation?.id === pending.id);
	let mounted = true;
	let editorEl = $state<HTMLElement>();
	const live = $derived(routines.find((row) => row.id === editing));
	const conflict = $derived(!!baseline && !!live && baseline.updated_at !== live.updated_at);
	const missing = $derived(!!baseline && !live);
	const disabled = $derived(busy || runtime.connection !== 'connected');
	const PHONE_QUERY = '(max-width: 680px)';

	function onPhone(): boolean {
		return typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches;
	}

	/** The shell's Back closes this page before it leaves the routines section. */
	export function backFromEditor(): boolean {
		if (!editing || busy) return Boolean(editing);
		close();
		return true;
	}

	/** A phone moves the count and the add button into the section's own header. */
	export function addRoutine(): void {
		open();
	}
	export function canAdd(): boolean {
		return !disabled;
	}

	$effect(() => () => { mounted = false; });
	$effect(() => {
		const id = runtime.profileRoutineId;
		if (!id) return;
		untrack(() => {
			const row = routines.find((item) => item.id === id);
			if (row) open(row);
			else failure = t.routines.missing;
			runtime.profileRoutineId = null;
		});
	});
	$effect(() => {
		if (!busy && pending && pending.api === runtime.client && runtime.pendingMutation?.id !== pending.id && !pending.api.hasPendingRequest(pending.id)) {
			pending = null;
			notice = t.routines.retired;
			retiredDraft = !!editing;
			if (failure === t.routines.unknown || failure === t.routines.pending) failure = '';
		}
	});
	$effect(() => {
		if (!busy && !retiredDraft && baseline && live && baseline.updated_at !== live.updated_at && !routineDirty(draft, baseline)) {
			draft = routineDraft(live);
			baseline = live;
		}
	});

	function open(row?: Routine): void {
		if (disabled) return;
		editing = row?.id ?? 'add';
		retiredDraft = false;
		notice = '';
		baseline = row ?? null;
		draft = routineDraft(row);
		errors = {};
		failure = '';
		// A phone gets a page, not a keyboard: focus lands on its heading so the slide-in
		// is not covered by the keyboard before the reader has seen the form.
		void tick().then(() => {
			if (!mounted) return;
			if (onPhone()) {
				editorEl?.querySelector<HTMLElement>('.routine-page-head h3')?.focus({ preventScroll: true });
				return;
			}
			editorEl?.scrollIntoView?.({ block: 'nearest' });
			editorEl?.querySelector<HTMLInputElement>('input')?.focus();
		});
	}

	function close(): void {
		editing = null;
		retiredDraft = false;
		notice = '';
		baseline = null;
		errors = {};
		failure = '';
	}

	async function mutate(run: () => ReturnType<MessengerRuntime['createRoutine']>, done: () => void): Promise<void> {
		if (disabled) return;
		const api = runtime.client;
		busy = true;
		failure = '';
		try {
			const error = await run();
			if (!mounted || runtime.client !== api) return;
			if (error) {
				failure = routineError(error, t);
				if (api && error.requestId && ['request_unknown', 'request_pending'].includes(error.code)) pending = { id: error.requestId, api };
			} else {
				if (pending?.api === api && !api?.hasPendingRequest(pending.id)) pending = null;
				done();
			}
		} catch {
			if (mounted && runtime.client === api) failure = t.routines.failed;
		} finally {
			if (mounted && runtime.client === api) busy = false;
		}
	}

	async function retry(): Promise<void> {
		const request = pending;
		if (disabled || !request || !retryable) return;
		busy = true;
		try {
			const error = await runtime.retryPendingMutation();
			if (!mounted || runtime.client !== request.api) return;
			failure = error ? routineError(error, t) : '';
			if (!request.api.hasPendingRequest(request.id)) {
				pending = null;
				notice = t.routines.retired;
				retiredDraft = !!editing;
			}
		} finally {
			if (mounted && runtime.client === request.api) busy = false;
		}
	}

	async function save(): Promise<void> {
		if (!editing || disabled || conflict || missing || retiredDraft) return;
		const plan = planRoutine(draft, t);
		errors = plan.errors;
		if (Object.keys(errors).length) return;
		const row = baseline;
		await mutate(() => row
			? runtime.patchRoutine(row.id, { ...plan.body, if_revision: row.updated_at })
			: runtime.createRoutine({ bot_id: bot.id, ...plan.body }), close);
	}

	async function remove(): Promise<void> {
		const row = deleting;
		if (!row) return;
		await mutate(() => runtime.deleteRoutine(row.id, row.updated_at), () => {
			if (editing === row.id) close();
		});
		if (mounted && !busy) deleting = null;
	}

	function toggleDay(day: string): void {
		if (disabled) return;
		draft.weekdays = draft.weekdays.includes(day)
			? draft.weekdays.filter((item) => item !== day)
			: [...draft.weekdays, day];
	}

	function selectPresetDays(preset: 'workdays' | 'weekend' | 'all'): void {
		if (disabled) return;
		if (preset === 'workdays') {
			draft.weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
		} else if (preset === 'weekend') {
			draft.weekdays = ['sat', 'sun'];
		} else {
			draft.weekdays = [...WEEKDAYS];
		}
	}
</script>

<section class="panel-card routine-card" aria-label={t.routines.title}>
	<div class="panel-card-head">
		<span class="panel-card-title">{t.routines.title}</span>
		<span class="panel-counter-badge">{routines.length}</span>
		<button type="button" class="btn-secondary routine-add" disabled={disabled} onclick={() => open()}>
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
			<span>{t.routines.add}</span>
		</button>
	</div>
	<div class="panel-card-body routine-body">
		<p class="routine-hint routine-hint-wide">{t.routines.zone}</p>
		<p class="routine-hint routine-hint-wide">{t.routines.availability}</p>

		{#if routines.length > 0}
			<div class="routine-mobile-zone-hint">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
				<span>{t.routines.zone}</span>
			</div>
		{/if}

		{#if routines.length === 0}
			<div class="routine-empty-card">
				<div class="routine-empty-icon" aria-hidden="true">
					<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
						<rect x="3" y="4" width="18" height="18" rx="2"></rect>
						<line x1="16" y1="2" x2="16" y2="6"></line>
						<line x1="8" y1="2" x2="8" y2="6"></line>
						<line x1="3" y1="10" x2="21" y2="10"></line>
					</svg>
				</div>
				<p class="routine-empty">{t.routines.empty}</p>
				<button type="button" class="btn-primary routine-empty-btn" disabled={disabled} onclick={() => open()}>
					{t.routines.add}
				</button>
			</div>
		{/if}

		<ul class="routine-list">
			{#each routines as row (row.id)}
				<li class="routine-row" class:is-open={editing === row.id} class:is-paused={!row.enabled} data-routine-id={row.id}>
					<button type="button" class="routine-open" aria-label={`${t.routines.edit}: ${row.title}`} disabled={disabled} onclick={() => open(row)}>
						<span class="routine-clock" aria-hidden="true">{row.schedule.time}</span>
						<span class="routine-copy">
							<span class="routine-copy-main">
								<strong>{row.title}</strong>
								{#if !row.enabled}
									<span class="routine-badge-paused">{t.routines.paused}</span>
								{/if}
							</span>
							<span class="routine-copy-sub">
								<svg class="routine-sub-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg>
								<span>{routineScheduleLabel(row.schedule, t)}</span>
							</span>
						</span>
						<span class="routine-state">{row.enabled ? t.routines.active : t.routines.paused}</span>
						<span class="routine-chevron" aria-hidden="true"></span>
					</button>
					<div class="routine-actions routine-actions-wide">
						<button type="button" class="btn-secondary" disabled={disabled} aria-label={`${row.enabled ? t.routines.pause : t.routines.resume}: ${row.title}`} onclick={() => void mutate(() => runtime.patchRoutine(row.id, { enabled: !row.enabled, if_revision: row.updated_at }), () => {})}>{row.enabled ? t.routines.pause : t.routines.resume}</button>
						<button type="button" class="btn-secondary routine-remove" disabled={disabled} aria-label={`${t.routines.remove}: ${row.title}`} onclick={() => { deleting = row; failure = ''; }}>{t.routines.remove}</button>
					</div>
					<div class="routine-mobile-toggle">
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<label class="switch-toggle" class:is-disabled={disabled} title={row.enabled ? t.routines.pause : t.routines.resume} onclick={(e) => e.stopPropagation()}>
							<input
								type="checkbox"
								checked={row.enabled}
								disabled={disabled}
								aria-label={`${row.enabled ? t.routines.pause : t.routines.resume}: ${row.title}`}
								onchange={() => void mutate(() => runtime.patchRoutine(row.id, { enabled: !row.enabled, if_revision: row.updated_at }), () => {})}
							/>
							<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
						</label>
					</div>
				</li>
			{/each}
		</ul>
		{#if failure && !editing}<p class="field-error" role="alert">{failure}</p>{/if}
		{#if retryable && !editing}
			<p class="routine-hint" role="status">{t.routines.retryHint}</p>
			<button type="button" class="btn-secondary" disabled={disabled} onclick={() => void retry()}>{t.routines.retry}</button>
		{/if}
		{#if notice && !editing}<p class="routine-hint" role="status">{notice}</p>{/if}
		{#if editing && !onPhone()}
			<form class="routine-editor" bind:this={editorEl} aria-label={baseline ? t.routines.edit : t.routines.add} onsubmit={(event) => { event.preventDefault(); void save(); }} novalidate>
				<h3>{baseline ? t.routines.edit : t.routines.add}</h3>
				{@render editorFields()}
				<div class="routine-actions">
					<button type="button" class="btn-secondary" disabled={busy} onclick={close}>{t.routines.cancel}</button>
					<button type="submit" class="btn-primary" disabled={disabled || conflict || missing || retiredDraft}>{busy ? t.routines.busy : t.routines.save}</button>
				</div>
			</form>
		{/if}
	</div>
</section>

{#if editing && onPhone()}
	<form
		class="routine-page"
		bind:this={editorEl}
		transition:pageSlide={{ instant: !onPhone() }}
		aria-label={baseline ? t.routines.edit : t.routines.add}
		onsubmit={(event) => { event.preventDefault(); void save(); }}
		novalidate
	>
		<div class="routine-page-head">
			<button type="button" class="routine-page-back" aria-label={t.common.back} disabled={busy} onclick={close}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
			</button>
			<h3 tabindex="-1">{baseline ? t.routines.edit : t.routines.add}</h3>
		</div>
		<div class="routine-page-body">
			{@render editorFields()}
		</div>
		<div class="routine-page-foot">
			<button type="submit" class="btn-primary routine-page-save" disabled={disabled || conflict || missing || retiredDraft}>
				{busy ? t.routines.busy : t.routines.save}
			</button>
		</div>
	</form>
{/if}

{#snippet editorFields()}
	{#if missing}<p class="field-error" role="alert">{t.routines.missing}</p>{/if}
	{#if conflict}
		<div class="panel-alert is-warn" role="alert">
			<span>{t.routines.conflict}</span>
			<button type="button" class="btn-secondary" disabled={disabled} onclick={() => open(live)}>{t.routines.reload}</button>
		</div>
	{/if}
	{#if failure}<p class="field-error" role="alert">{failure}</p>{/if}
	{#if retryable}
		<div class="panel-alert is-warn" role="status">
			<p class="routine-hint">{t.routines.retryHint}</p>
			<button type="button" class="btn-secondary" disabled={disabled} onclick={() => void retry()}>{t.routines.retry}</button>
		</div>
	{/if}
	{#if notice}<p class="routine-hint" role="status">{notice}</p>{/if}

	<!-- Group 1: 标题与归属 -->
	<div class="routine-form-card">
		<div class="routine-card-header">
			<label for="routine-title" class="routine-card-title">{t.routines.name}</label>
			<span class="routine-owner-badge" title={`${t.routines.owner}: ${bot.name}`}>
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
				<span>{bot.name}</span>
			</span>
		</div>
		<div class="form-group">
			<input
				id="routine-title"
				type="text"
				bind:value={draft.title}
				disabled={disabled}
				placeholder="例如：每日早间资讯汇总、周度代码巡检"
				aria-invalid={!!errors.title}
			/>
			{#if errors.title}<p class="field-error" role="alert">{errors.title}</p>{/if}
		</div>
	</div>

	<!-- Group 2: 重复周期与时间 -->
	<div class="routine-form-card">
		<div class="routine-card-header">
			<span class="routine-card-title">{t.routines.frequency}</span>
		</div>
		<fieldset class="routine-freq" disabled={disabled}>
			<legend class="sr-only">{t.routines.frequency}</legend>
			<div class="routine-seg" role="radiogroup" aria-label={t.routines.frequency}>
				<label class:is-on={draft.kind === 'daily'}>
					<input type="radio" name="routine-frequency" value="daily" bind:group={draft.kind} />
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg>
					<span>{t.routines.daily}</span>
				</label>
				<label class:is-on={draft.kind === 'weekly'}>
					<input type="radio" name="routine-frequency" value="weekly" bind:group={draft.kind} />
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
					<span>{t.routines.weekly}</span>
				</label>
			</div>
		</fieldset>

		{#if draft.kind === 'weekly'}
			<div class="routine-weekdays-block">
				<fieldset disabled={disabled}>
					<div class="routine-weekdays-head">
						<legend class="routine-sublabel">{t.routines.weekdays}</legend>
						<div class="routine-quick-presets">
							<button type="button" class="preset-btn" disabled={disabled} onclick={() => selectPresetDays('workdays')}>{t.routines.workdays}</button>
							<button type="button" class="preset-btn" disabled={disabled} onclick={() => selectPresetDays('weekend')}>{t.routines.weekend}</button>
							<button type="button" class="preset-btn" disabled={disabled} onclick={() => selectPresetDays('all')}>{t.routines.allDays}</button>
						</div>
					</div>
					<div class="routine-days">
						{#each WEEKDAYS as day}
							<button
								type="button"
								class="routine-day"
								class:is-on={draft.weekdays.includes(day)}
								aria-pressed={draft.weekdays.includes(day)}
								aria-label={t.routines.days[day]}
								disabled={disabled}
								onclick={() => toggleDay(day)}
							>{t.routines.daysShort[day]}</button>
						{/each}
					</div>
					{#if errors.weekdays}<p class="field-error" role="alert">{errors.weekdays}</p>{/if}
				</fieldset>
			</div>
		{/if}

		<div class="routine-time-block">
			<div class="routine-time-row">
				<div class="routine-time-info">
					<label for="routine-time" class="routine-card-title routine-time-title">
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
						<span>{t.routines.time}</span>
					</label>
					<span class="routine-time-zone-hint">{t.routines.zone}</span>
				</div>
				<div class="routine-time-control">
					<input id="routine-time" type="time" bind:value={draft.time} disabled={disabled} aria-invalid={!!errors.time} />
				</div>
			</div>
			{#if errors.time}<p class="field-error" role="alert">{errors.time}</p>{/if}
		</div>
	</div>

	<!-- Group 3: 任务指令 -->
	<div class="routine-form-card">
		<div class="routine-card-header">
			<label for="routine-instruction" class="routine-card-title">{t.routines.instruction}</label>
			<span class="routine-card-hint">触发时自动发送</span>
		</div>
		<div class="form-group">
			<textarea
				id="routine-instruction"
				rows="4"
				bind:value={draft.instruction}
				disabled={disabled}
				placeholder="到达设定时间后，将向该 Bot 发送此指令开始工作，如输入提问或特定工作任务..."
			></textarea>
		</div>
	</div>

	<!-- Group 4: 运行状态 -->
	<div class="routine-form-card routine-status-card">
		<div class="routine-switch-row">
			<div class="routine-switch-copy">
				<span class="routine-switch-title">{t.routines.enabled}</span>
				<span class="routine-switch-desc">
					{draft.enabled ? '已开启，将按设定周期自动准时触发' : '已暂停，日程暂时不会自动触发'}
				</span>
			</div>
			<label class="switch-toggle" class:is-disabled={disabled}>
				<input type="checkbox" bind:checked={draft.enabled} disabled={disabled} />
				<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
			</label>
		</div>
	</div>

	<!-- Group 5: 运行环境提示 -->
	<div class="routine-notice-card">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
		<p>{t.routines.availability}</p>
	</div>

	<!-- Group 6: 危险区域 / 删除日程 -->
	{#if baseline}
		<div class="routine-danger-card">
			<button
				type="button"
				class="routine-page-delete"
				disabled={disabled}
				onclick={() => { deleting = baseline; failure = ''; }}
			>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="3 6 5 6 21 6"></polyline>
					<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
				</svg>
				<span>{t.routines.remove}</span>
			</button>
		</div>
	{/if}
{/snippet}

{#if deleting}
	<DangerDialog {t} {busy} copy={{ title: t.routines.remove, body: `${deleting.title} — ${t.routines.deleteBody}`, confirm: t.routines.confirm, cancel: t.routines.cancel }} onDismiss={() => { if (!busy) deleting = null; }} onConfirm={() => void remove()} />
{/if}

<style>
	.routine-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
	.routine-add { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
	.routine-hint, .routine-empty { margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted); }
	.routine-mobile-zone-hint { display: none; }
	.routine-empty-card { display: none; }
	.routine-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
	.routine-row { display: flex; align-items: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--pane); transition: border-color 0.15s, background-color 0.15s; }
	.routine-row.is-open { border-color: var(--accent); background: var(--accent-tint); }
	.routine-row.is-paused .routine-clock,
	.routine-row.is-paused strong { color: var(--muted); }
	.routine-open { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; padding: 0; background: none; border: 0; text-align: left; color: var(--ink); cursor: pointer; }
	.routine-clock { flex: 0 0 auto; font-variant-numeric: tabular-nums; font-size: 20px; font-weight: 650; letter-spacing: -0.03em; line-height: 1; }
	.routine-copy { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
	.routine-copy-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
	.routine-copy-main strong { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.routine-badge-paused { font-size: 11px; font-weight: 500; padding: 1px 6px; border-radius: 999px; background: var(--sidebar-bg); border: 1px solid var(--line); color: var(--muted); line-height: 1.3; }
	.routine-copy-sub { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; }
	.routine-sub-icon { opacity: 0.7; flex-shrink: 0; }
	.routine-state { flex: 0 0 auto; color: var(--muted); font-size: 12px; margin-left: 8px; }
	.routine-chevron { display: none; }
	.routine-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-left: 8px; }
	.routine-mobile-toggle { display: none; }

	.routine-editor { display: flex; flex-direction: column; gap: 14px; min-width: 0; padding-top: 16px; border-top: 1px solid var(--line); scroll-margin: 16px; }
	.routine-editor h3, .routine-page-head h3 { margin: 0; font-size: 16px; font-weight: 650; }

	/* Form Grouping & Cards */
	.routine-form-card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--pane); }
	.routine-card-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.routine-card-title { font-size: 13px; font-weight: 650; color: var(--ink); margin: 0; }
	.routine-card-hint { font-size: 11.5px; color: var(--muted); }
	.routine-owner-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 500; color: var(--muted); background: var(--sidebar-bg); border: 1px solid var(--line); padding: 2px 8px; border-radius: 999px; }

	fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
	.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
	.routine-sublabel { font-size: 12px; font-weight: 600; color: var(--ink-secondary); margin: 0; }

	.routine-seg { display: flex; padding: 3px; border-radius: 10px; background: var(--sidebar-bg); border: 1px solid var(--line); gap: 2px; }
	/* The drawer's `.sheet label` spaces form labels apart; these labels are controls, so they take none of it. */
	.routine-seg label { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; margin: 0; border-radius: 8px; font-size: 14px; font-weight: 600; color: var(--muted); cursor: pointer; transition: all 0.15s ease; }
	.routine-seg label.is-on { background: var(--accent); color: white; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15); }
	.routine-seg input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; }

	.routine-weekdays-block { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--line-subtle, var(--line)); }
	.routine-weekdays-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
	.routine-quick-presets { display: flex; align-items: center; gap: 4px; }
	.preset-btn { min-height: 26px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--sidebar-bg); font-size: 11.5px; font-weight: 500; color: var(--muted); cursor: pointer; transition: all 0.12s; }
	.preset-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }

	.routine-days { display: flex; gap: 6px; }
	.routine-day { flex: 1; min-width: 0; min-height: 44px; padding: 0; border: 1px solid var(--line); border-radius: 999px; background: var(--pane); color: var(--ink); font-size: 14px; font-weight: 650; cursor: pointer; transition: all 0.15s ease; }
	.routine-day.is-on { background: var(--accent); border-color: var(--accent); color: white; box-shadow: 0 1px 3px rgba(37, 99, 235, 0.25); }

	.routine-time-block { padding-top: 10px; border-top: 1px solid var(--line-subtle, var(--line)); }
	.routine-time-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	.routine-time-info { display: flex; flex-direction: column; gap: 2px; }
	.routine-time-title { display: inline-flex; align-items: center; gap: 6px; }
	.routine-time-zone-hint { font-size: 11px; color: var(--muted); }
	.routine-time-control input[type='time'] { min-width: 120px; font-variant-numeric: tabular-nums; font-size: 16px; font-weight: 650; }

	.routine-status-card { padding: 12px 14px; }
	.routine-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; }
	.routine-switch-copy { display: flex; flex-direction: column; gap: 2px; }
	.routine-switch-title { font-size: 14px; font-weight: 600; color: var(--ink); }
	.routine-switch-desc { font-size: 12px; color: var(--muted); }

	.switch-toggle { position: relative; display: inline-flex; align-items: center; margin: 0; cursor: pointer; }
	.switch-toggle input { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
	.switch-track { display: block; width: 44px; height: 24px; border-radius: 9999px; background: var(--chip-line, var(--line)); position: relative; transition: background-color 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
	.switch-thumb { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
	.switch-toggle input:checked + .switch-track { background: var(--accent); }
	.switch-toggle input:checked + .switch-track .switch-thumb { transform: translateX(20px); }
	.switch-toggle input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 2px; }
	.switch-toggle.is-disabled { opacity: 0.55; cursor: default; }

	.routine-notice-card { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--sidebar-bg); border: 1px solid var(--line-subtle, var(--line)); color: var(--muted); font-size: 11.5px; line-height: 1.5; }
	.routine-notice-card svg { flex-shrink: 0; margin-top: 1px; }
	.routine-notice-card p { margin: 0; }

	.routine-danger-card { padding: 4px 0; }
	.routine-page-delete { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 44px; border: 1px solid rgba(239, 68, 68, 0.25); border-radius: var(--radius-md); background: rgba(239, 68, 68, 0.05); color: var(--danger-text, var(--danger, #ef4444)); font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s ease; }
	.routine-page-delete:hover:not(:disabled) { background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.4); }

	.routine-card button { min-height: 40px; }
	.routine-card .btn-secondary, .routine-card .btn-primary, .routine-page .btn-primary { padding: 8px 14px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--btn-secondary-bg); font-size: 13px; font-weight: 600; transition: all 0.15s ease; }
	.routine-card .btn-primary, .routine-page .btn-primary { background: var(--accent); border-color: var(--accent); color: white; box-shadow: 0 2px 6px rgba(37, 99, 235, 0.2); }
	.routine-card .btn-primary:hover:not(:disabled), .routine-page .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
	.routine-card button:disabled, .routine-page button:disabled { opacity: 0.55; cursor: default; }
	.routine-card button:not(:disabled):hover { border-color: var(--accent); }

	.routine-form-card .form-group { display: flex; flex-direction: column; gap: 6px; }
	.routine-form-card input:not([type='checkbox']):not([type='radio']),
	.routine-form-card textarea { padding: 9px 12px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--input-bg); width: 100%; min-height: 44px; box-sizing: border-box; font-size: 14px; color: var(--ink); transition: border-color 0.15s, box-shadow 0.15s; }
	.routine-form-card input:not([type='checkbox']):not([type='radio']):focus,
	.routine-form-card textarea:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-glow); }
	.routine-form-card textarea { min-height: 100px; resize: vertical; line-height: 1.5; font-family: inherit; }

	.routine-page { display: none; }

	@media (max-width: 680px) {
		.routine-hint-wide, .routine-actions-wide, .routine-state { display: none; }
		/* The section header carries the count and the add button; the rows share the pane's gutter. */
		.routine-card { border: 0; border-radius: 0; background: transparent; box-shadow: none; }
		.routine-card .panel-card-head { display: none; }
		.routine-body { gap: 10px; padding: 0; }
		.routine-mobile-zone-hint { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: var(--radius-md); background: var(--pane); border: 1px solid var(--line); font-size: 11.5px; color: var(--muted); }
		.routine-list { gap: 8px; border-radius: 0; background: transparent; }
		.routine-row { padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-lg, 12px); background: var(--pane); box-shadow: var(--shadow-xs); }
		.routine-row + .routine-row { border-top: 1px solid var(--line); }
		.routine-row.is-open { background: var(--accent-tint); border-color: var(--accent); }
		.routine-open { min-height: 52px; padding: 0; }
		.routine-open:active { opacity: 0.85; }
		.routine-clock { font-size: 24px; width: 68px; }
		.routine-chevron { display: none; }
		.routine-mobile-toggle { display: flex; align-items: center; margin-left: 12px; flex-shrink: 0; }

		.routine-empty-card { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 36px 16px; border-radius: var(--radius-lg, 12px); background: var(--pane); border: 1px dashed var(--line); text-align: center; }
		.routine-empty-icon { display: flex; align-items: center; justify-content: center; width: 56px; height: 56px; border-radius: 50%; background: var(--sidebar-bg); color: var(--muted); }
		.routine-empty { font-size: 14px; color: var(--muted); margin: 0; }
		.routine-empty-btn { min-height: 42px; padding: 0 20px; font-size: 14px; }

		/* Mobile Page Slide-over */
		.routine-page {
			display: flex;
			flex-direction: column;
			position: fixed;
			inset: 0;
			z-index: 90;
			background: var(--bg);
			color: var(--ink);
		}
		/* The same header as the routines section it slides over, so the page swap does not jump. */
		.routine-page-head {
			display: flex;
			align-items: center;
			gap: 4px;
			flex-shrink: 0;
			min-height: calc(56px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 12px 0 4px;
			background: var(--pane);
			border-bottom: 1px solid var(--line);
		}
		.routine-page-back {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			flex-shrink: 0;
			width: 44px;
			height: 44px;
			padding: 0;
			border: 0;
			border-radius: var(--radius-md);
			background: transparent;
			color: var(--accent);
			cursor: pointer;
		}
		.routine-page-back:active { background: var(--row-hover); }
		.routine-page-head h3 {
			min-width: 0;
			margin: 0;
			font-size: 16px;
			font-weight: 650;
			color: var(--ink);
			outline: none;
		}

		.routine-page-body {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			display: flex;
			flex-direction: column;
			gap: 14px;
			padding: 16px 12px calc(28px + env(safe-area-inset-bottom));
			-webkit-overflow-scrolling: touch;
		}
		.routine-page-body .routine-form-card {
			padding: 14px 16px;
			border-radius: var(--radius-lg, 12px);
			box-shadow: var(--shadow-xs);
		}
		.routine-page-foot {
			display: flex;
			flex-direction: column;
			gap: 8px;
			flex-shrink: 0;
			padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
			background: var(--pane);
			border-top: 1px solid var(--line);
			box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.04);
		}
		.routine-page-foot .btn-primary { min-height: 48px; font-size: 16px; border-radius: var(--radius-md); }
	}

	@media (prefers-reduced-motion: reduce) {
		.switch-thumb { transition: none; }
		.switch-track { transition: none; }
	}
</style>
