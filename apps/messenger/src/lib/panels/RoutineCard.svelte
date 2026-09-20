<script lang="ts">
	import { tick, untrack } from 'svelte';
	import type { Bot, Routine } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { LocalApi } from '../api.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
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
	let pending = $state<{ id: string; api: LocalApi } | null>(null);
	let notice = $state('');
	let retiredDraft = $state(false);
	const retryable = $derived(pending && pending.api === runtime.client && runtime.pendingMutation?.id === pending.id);
	let mounted = true;
	let editorEl = $state<HTMLElement>();
	const live = $derived(routines.find((row) => row.id === editing));
	const conflict = $derived(!!baseline && !!live && baseline.updated_at !== live.updated_at);
	const missing = $derived(!!baseline && !live);
	const disabled = $derived(busy || runtime.connection !== 'connected');

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
		void tick().then(() => {
			if (!mounted) return;
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
</script>

<section class="panel-card routine-card" aria-label={t.routines.title}>
	<div class="panel-card-head">
		<span class="panel-card-title">{t.routines.title}</span>
		<span class="panel-counter-badge">{routines.length}</span>
		<button type="button" class="btn-secondary routine-add" disabled={disabled} onclick={() => open()}>{t.routines.add}</button>
	</div>
	<div class="panel-card-body routine-body">
		<p class="routine-hint">{t.routines.zone}</p>
		<p class="routine-hint">{t.routines.availability}</p>
		{#if routines.length === 0}<p class="routine-empty">{t.routines.empty}</p>{/if}
		{#each routines as row (row.id)}
			<div class="routine-row" class:is-open={editing === row.id} class:is-paused={!row.enabled} data-routine-id={row.id}>
				<button type="button" class="routine-open" aria-label={`${t.routines.edit}: ${row.title}`} disabled={disabled} onclick={() => open(row)}>
					<strong>{row.title}</strong>
					<span>{routineScheduleLabel(row.schedule, t)} · {row.enabled ? t.routines.active : t.routines.paused}</span>
				</button>
				<div class="routine-actions">
					<button type="button" class="btn-secondary" disabled={disabled} aria-label={`${row.enabled ? t.routines.pause : t.routines.resume}: ${row.title}`} onclick={() => void mutate(() => runtime.patchRoutine(row.id, { enabled: !row.enabled, if_revision: row.updated_at }), () => {})}>{row.enabled ? t.routines.pause : t.routines.resume}</button>
					<button type="button" class="btn-secondary" disabled={disabled} aria-label={`${t.routines.remove}: ${row.title}`} onclick={() => { deleting = row; failure = ''; }}>{t.routines.remove}</button>
				</div>
			</div>
		{/each}
		{#if failure}<p class="field-error" role="alert">{failure}</p>{/if}
		{#if retryable}
			<p class="routine-hint" role="status">{t.routines.retryHint}</p>
			<button type="button" class="btn-secondary" disabled={disabled} onclick={() => void retry()}>{t.routines.retry}</button>
		{/if}
		{#if notice}<p class="routine-hint" role="status">{notice}</p>{/if}
		{#if editing}
			<form class="routine-editor" bind:this={editorEl} aria-label={baseline ? t.routines.edit : t.routines.add} onsubmit={(event) => { event.preventDefault(); void save(); }} novalidate>
				<h3>{baseline ? t.routines.edit : t.routines.add}</h3>
				<p class="routine-hint">{t.routines.owner}: <strong>{bot.name}</strong></p>
				{#if missing}<p class="field-error" role="alert">{t.routines.missing}</p>{/if}
				{#if conflict}
					<p class="field-error" role="alert">{t.routines.conflict}</p>
					<button type="button" class="btn-secondary" disabled={disabled} onclick={() => open(live)}>{t.routines.reload}</button>
				{/if}
				<div class="form-group">
					<label for="routine-title">{t.routines.name}</label>
					<input id="routine-title" bind:value={draft.title} disabled={disabled} aria-invalid={!!errors.title} />
					{#if errors.title}<p class="field-error" role="alert">{errors.title}</p>{/if}
				</div>
				<div class="form-group">
					<label for="routine-instruction">{t.routines.instruction}</label>
					<textarea id="routine-instruction" rows="3" bind:value={draft.instruction} disabled={disabled}></textarea>
				</div>
				<fieldset disabled={disabled}>
					<legend>{t.routines.frequency}</legend>
					<div class="routine-actions">
						<label><input type="radio" name="routine-frequency" value="daily" bind:group={draft.kind} /> {t.routines.daily}</label>
						<label><input type="radio" name="routine-frequency" value="weekly" bind:group={draft.kind} /> {t.routines.weekly}</label>
					</div>
				</fieldset>
				{#if draft.kind === 'weekly'}
					<fieldset disabled={disabled}>
						<legend>{t.routines.weekdays}</legend>
						<div class="routine-days">
							{#each WEEKDAYS as day}<label><input type="checkbox" value={day} bind:group={draft.weekdays} /> {t.routines.days[day]}</label>{/each}
						</div>
						{#if errors.weekdays}<p class="field-error" role="alert">{errors.weekdays}</p>{/if}
					</fieldset>
				{/if}
				<div class="form-group">
					<label for="routine-time">{t.routines.time}</label>
					<input id="routine-time" type="text" inputmode="numeric" placeholder="09:00" bind:value={draft.time} disabled={disabled} aria-invalid={!!errors.time} />
					{#if errors.time}<p class="field-error" role="alert">{errors.time}</p>{/if}
				</div>
				<label class="routine-enabled"><input type="checkbox" bind:checked={draft.enabled} disabled={disabled} /> {t.routines.enabled}</label>
				<div class="routine-actions">
					<button type="button" class="btn-secondary" disabled={busy} onclick={close}>{t.routines.cancel}</button>
					<button type="submit" class="btn-primary" disabled={disabled || conflict || missing || retiredDraft}>{busy ? t.routines.busy : t.routines.save}</button>
				</div>
			</form>
		{/if}
	</div>
</section>

{#if deleting}
	<DangerDialog {t} {busy} copy={{ title: t.routines.remove, body: `${deleting.title} — ${t.routines.deleteBody}`, confirm: t.routines.confirm, cancel: t.routines.cancel }} onDismiss={() => { if (!busy) deleting = null; }} onConfirm={() => void remove()} />
{/if}

<style>
	.routine-body, .routine-editor { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
	.routine-add { margin-left: auto; }
	.routine-hint, .routine-empty { margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted); }
	.routine-row { padding: 10px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--pane); }
	.routine-row.is-open { border-color: var(--accent); background: var(--accent-tint); }
	.routine-row.is-paused strong { color: var(--muted); }
	.routine-open { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; width: 100%; padding: 0; background: none; border: 0; text-align: left; color: var(--ink); overflow-wrap: anywhere; }
	.routine-open span { color: var(--muted); font-size: 12px; }
	.routine-actions, .routine-days { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
	.routine-row .routine-actions { margin-top: 8px; }
	.routine-editor { padding-top: 16px; border-top: 1px solid var(--line); scroll-margin: 16px; }
	.routine-editor h3 { margin: 0; font-size: 14px; }
	fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
	legend { font-size: 12px; color: var(--ink-secondary); margin-bottom: 4px; }
	.routine-days label, .routine-actions label, .routine-enabled { display: flex; align-items: center; gap: 6px; min-height: 44px; min-width: 44px; font-size: 13px; }
	.routine-card button { min-height: 44px; }
	.routine-card .btn-secondary, .routine-card .btn-primary { padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--btn-secondary-bg); font-size: 12px; font-weight: 600; }
	.routine-card .btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
	.routine-card button:disabled { opacity: 0.55; cursor: default; }
	.routine-card button:not(:disabled):hover { border-color: var(--accent); }
	.routine-editor .form-group label { display: block; margin-bottom: 5px; font-size: 12px; font-weight: 600; }
	.routine-editor input:not([type='checkbox']):not([type='radio']), .routine-editor textarea { padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--input-bg); }
	.routine-editor input:not([type='checkbox']):not([type='radio']), .routine-editor textarea { width: 100%; min-height: 44px; box-sizing: border-box; }
</style>
