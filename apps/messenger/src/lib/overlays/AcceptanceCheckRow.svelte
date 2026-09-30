<script lang="ts">
	import type { AcceptanceCheck, TaskDetail } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import { badgeOf, derivedStateOf, describeCheck, isDerived, isUnbound, unconfirmedResult, type CheckBadge } from './acceptance-checks.ts';
	import AcceptanceCheckForm from './AcceptanceCheckForm.svelte';
	import DangerDialog from './DangerDialog.svelte';

	interface Props {
		api: MessengerApi | null;
		detail: TaskDetail;
		check: AcceptanceCheck;
		t: Copy;
		/** The plan comes back whole from every check action; the parent replaces its copy. */
		onSaved: (detail: TaskDetail) => void;
	}

	let { api, detail, check, t, onSaved }: Props = $props();

	let expanded = $state(false);
	let editing = $state(false);
	let confirmingRemove = $state(false);
	let busy = $state(false);
	let removing = $state(false);
	let actionError = $state<string | null>(null);

	const badge = $derived(badgeOf(check));
	// From your words (ADR 0040 P3): a new number of yours changes it, so there is nothing to edit
	// here; an offer is yours to confirm, measured meanwhile so you see what the cut does against it.
	const fromWords = $derived(isDerived(check));
	const standing = $derived(derivedStateOf(check));
	const runnable = $derived(!isUnbound(check));
	const result = $derived(standing === 'proposed' ? unconfirmedResult(check, t) : null);
	// An offer's pill says it waits for you, and what the cut measured against it.
	const pillLabel = $derived.by(() => {
		const outcome = check.last_run?.outcome;
		const base = t.plan.checks.status[badge];
		return badge === 'proposed' && (outcome === 'pass' || outcome === 'fail') ? `${base} · ${t.plan.checks.status[outcome]}` : base;
	});
	let confirming = $state(false);

	const GLYPH: Record<CheckBadge, string> = {
		pass: '✓',
		fail: '✗',
		running: '…',
		blocked: '!',
		error: '!',
		none: '○',
		unbound: '◌',
		proposed: '?',
	};

	function errorStatus(err: unknown): number | undefined {
		if (err && typeof err === 'object' && 'status' in err) {
			const status = (err as { status?: unknown }).status;
			return typeof status === 'number' ? status : undefined;
		}
		return undefined;
	}

	function toggle(): void {
		expanded = !expanded;
	}

	async function rerun(): Promise<void> {
		if (!api || busy) return;
		busy = true;
		actionError = null;
		try {
			const result = await api.runChecks(detail.id, check.id);
			onSaved(result);
		} catch {
			actionError = t.plan.checks.runFailed;
		} finally {
			busy = false;
		}
	}

	async function confirm(): Promise<void> {
		if (!api || confirming) return;
		confirming = true;
		actionError = null;
		try {
			onSaved(await api.confirmCheck(check.id));
		} catch (err) {
			actionError = errorStatus(err) === 409 ? t.plan.checks.checkGone : t.plan.checks.confirmFailed;
		} finally {
			confirming = false;
		}
	}

	function startEdit(): void {
		editing = true;
		actionError = null;
	}

	function cancelEdit(): void {
		editing = false;
	}

	function saved(result: TaskDetail): void {
		editing = false;
		onSaved(result);
	}

	function askRemove(): void {
		confirmingRemove = true;
		actionError = null;
	}

	async function confirmRemove(): Promise<void> {
		if (!api || removing) return;
		removing = true;
		try {
			const result = await api.deleteCheck(check.id, check.updated_at);
			confirmingRemove = false;
			onSaved(result);
		} catch (err) {
			confirmingRemove = false;
			actionError = errorStatus(err) === 409 ? t.plan.checks.checkGone : t.plan.checks.removeFailed;
		} finally {
			removing = false;
		}
	}
</script>

<span class="check-item">
	<button
		type="button"
		class="check-pill is-{badge}"
		aria-expanded={expanded}
		title={describeCheck(check, t)}
		onclick={toggle}
	>
		<span class="check-pill-glyph" aria-hidden="true">{GLYPH[badge]}</span>
		<span class="check-pill-label">{pillLabel}</span>
	</button>

	{#if expanded}
		<span class="check-detail">
			{#if editing && api}
				<AcceptanceCheckForm {api} {detail} {t} editing={check} onSaved={saved} onCancel={cancelEdit} />
			{:else}
				<p class="check-desc">{describeCheck(check, t)}</p>
				<p class="check-meta">
					<span>{fromWords ? t.plan.checks.sourceDerived : check.source === 'organizer' ? t.plan.checks.sourceOrganizer : t.plan.checks.sourceUser}</span>
					<span class="check-dot" aria-hidden="true">·</span>
					{#if check.last_run}
						<span title={formatFullTimestamp(check.last_run.started_at)}>{t.plan.checks.lastRun}：{formatMessageTime(check.last_run.started_at)}</span>
					{:else}
						<span>{t.plan.checks.neverRun}</span>
					{/if}
				</p>
				{#if result}<p class="check-state is-result">{result}</p>{:else if standing === 'proposed'}<p class="check-state">{t.plan.checks.stateProposed}</p>{/if}
				{#if check.last_run?.detail}<p class="check-run-detail">{check.last_run.detail}</p>{/if}
				{#if check.last_run?.output}<pre class="check-output mono">{check.last_run.output}</pre>{/if}
				{#if actionError}<p class="field-error" role="alert">{actionError}</p>{/if}
				{#if api}
					<span class="check-actions">
						{#if standing === 'proposed'}
							<button type="button" class="check-confirm" onclick={() => void confirm()} disabled={busy || confirming}>{t.plan.checks.confirm}</button>
						{/if}
						<button type="button" onclick={rerun} disabled={busy || check.running || !runnable}>{t.plan.checks.rerun}</button>
						{#if !fromWords}<button type="button" onclick={startEdit} disabled={busy}>{t.plan.edit}</button>{/if}
						<button type="button" class="check-remove" onclick={askRemove} disabled={busy}>{t.plan.checks.remove}</button>
					</span>
				{/if}
			{/if}
		</span>
	{/if}

	{#if confirmingRemove}
		<DangerDialog
			{t}
			busy={removing}
			copy={{
				title: t.plan.checks.confirmRemoveTitle,
				body: t.plan.checks.confirmRemoveBody,
				confirm: t.plan.checks.confirmRemove,
				cancel: t.plan.cancel,
			}}
			onDismiss={() => { if (!removing) confirmingRemove = false; }}
			onConfirm={() => void confirmRemove()}
		/>
	{/if}
</span>

<style>
	.check-item {
		display: inline-flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		max-width: 100%;
	}

	.check-pill {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--muted);
		font-size: 11px;
		font-weight: 600;
		line-height: 1;
		padding: 3px 8px;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.check-pill:hover {
		border-color: var(--line-hover);
	}

	.check-pill-glyph {
		font-size: 10px;
		line-height: 1;
	}

	.check-pill.is-pass {
		border-color: var(--ok-line);
		background: var(--ok-bg);
		color: var(--ok-text);
	}

	.check-pill.is-fail {
		border-color: var(--danger-line);
		background: var(--danger-bg);
		color: var(--danger-text);
	}

	.check-pill.is-running {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.check-pill.is-blocked,
	.check-pill.is-error {
		border-color: var(--warn-line);
		background: var(--warn-bg);
		color: var(--warn-text);
	}

	.check-pill.is-none,
	.check-pill.is-unbound {
		color: var(--muted-light);
	}

	.check-pill.is-unbound,
	.check-pill.is-proposed {
		border-style: dashed;
	}

	.check-pill.is-proposed {
		color: var(--accent);
		border-color: var(--accent-border);
	}

	.check-state {
		margin: 0;
		font-size: 11px;
		color: var(--muted);
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.check-state.is-result {
		color: var(--ink-secondary);
	}

	.check-detail {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 280px;
		max-width: 100%;
		box-sizing: border-box;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.check-desc {
		margin: 0;
		font-size: 12px;
		color: var(--ink);
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.check-meta {
		margin: 0;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex-wrap: wrap;
		font-size: 11px;
		color: var(--muted);
	}

	.check-dot {
		color: var(--muted-light);
	}

	.check-run-detail {
		margin: 0;
		font-size: 11px;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.check-output {
		margin: 0;
		max-height: 160px;
		overflow: auto;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
		padding: 6px 8px;
		border-radius: var(--radius-sm);
		background: var(--line-subtle);
		color: var(--ink-secondary);
		font-size: 11px;
		line-height: 1.4;
	}

	.check-actions {
		display: inline-flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.check-actions button {
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 500;
		padding: 4px 9px;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.check-actions button:hover:not(:disabled) {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.check-actions .check-confirm {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.check-actions button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.check-actions .check-remove:hover:not(:disabled) {
		border-color: var(--danger-line);
		background: var(--danger-bg);
		color: var(--danger-text);
	}

	@media (max-width: 560px) {
		.check-detail {
			width: 100%;
		}

		.check-output {
			overflow-x: auto;
		}

		.check-actions button {
			min-height: 36px;
			padding: 6px 12px;
		}
	}
</style>
