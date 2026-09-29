<script lang="ts">
	import type { AcceptanceCheck, AcceptanceCheckKind, TaskDetail } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { draftToInput, emptyDraft, draftFromCheck } from './acceptance-checks.ts';

	interface Props {
		api: MessengerApi;
		detail: TaskDetail;
		t: Copy;
		/** Null creates a fresh check; a check edits it (always lands as source `user`). */
		editing: AcceptanceCheck | null;
		/** The acceptance line to preselect when creating fresh. Ignored while editing. */
		initialItem?: string;
		onSaved: (detail: TaskDetail) => void;
		onCancel: () => void;
	}

	let { api, detail, t, editing, initialItem = '', onSaved, onCancel }: Props = $props();

	const KINDS: readonly AcceptanceCheckKind[] = ['exists', 'contains', 'matches', 'command', 'continuity'];

	let draft = $state(editing ? draftFromCheck(editing) : emptyDraft(detail, initialItem));
	let errors = $state<ReturnType<typeof draftToInput>['errors']>({});
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let expectOpen = $state(Boolean(draft.expectStdout));

	/** The plan's own acceptance lines, plus the line being edited when it no longer matches any of them. */
	const itemOptions = $derived.by(() => {
		const lines = detail.spec?.acceptance ?? [];
		if (editing && !lines.includes(editing.item)) return [editing.item, ...lines];
		return lines;
	});

	function kindLabel(kind: AcceptanceCheckKind): string {
		if (kind === 'exists') return t.plan.checks.kindExists;
		if (kind === 'contains') return t.plan.checks.kindContains;
		if (kind === 'matches') return t.plan.checks.kindMatches;
		if (kind === 'continuity') return t.plan.checks.kindContinuity;
		return t.plan.checks.kindCommand;
	}

	function selectKind(kind: AcceptanceCheckKind): void {
		if (saving) return;
		draft.kind = kind;
		errors = {};
	}

	function errorStatus(err: unknown): number | undefined {
		if (err && typeof err === 'object' && 'status' in err) {
			const status = (err as { status?: unknown }).status;
			return typeof status === 'number' ? status : undefined;
		}
		return undefined;
	}

	function errorCode(err: unknown): string | undefined {
		if (err && typeof err === 'object' && 'code' in err) {
			const code = (err as { code?: unknown }).code;
			return typeof code === 'string' ? code : undefined;
		}
		return undefined;
	}

	function errorMessage(err: unknown): string | undefined {
		if (err && typeof err === 'object' && 'message' in err) {
			const message = (err as { message?: unknown }).message;
			return typeof message === 'string' ? message : undefined;
		}
		return undefined;
	}

	async function submit(): Promise<void> {
		if (saving) return;
		const planned = draftToInput(draft);
		errors = planned.errors;
		if (!planned.input) return;
		saving = true;
		saveError = null;
		try {
			const result = editing
				? await api.patchCheck(editing.id, { ...planned.input, if_revision: editing.updated_at })
				: await api.createCheck(detail.id, planned.input);
			onSaved(result);
		} catch (err) {
			const status = errorStatus(err);
			const code = errorCode(err);
			if (status === 409) saveError = t.plan.checks.checkGone;
			else if (code === 'outside_workspace') saveError = t.plan.checks.outsideWorkspace;
			else if (code === 'too_many_checks') saveError = t.plan.checks.tooManyChecks;
			else if (status === 422) saveError = errorMessage(err) ?? t.plan.checks.createFailed;
			else saveError = t.plan.checks.createFailed;
		} finally {
			saving = false;
		}
	}
</script>

<div class="check-form">
	<label class="check-form-field">
		<span class="check-form-label">{t.plan.checks.itemLabel}</span>
		<select
			class="check-form-select"
			value={draft.item}
			onchange={(e) => (draft.item = (e.currentTarget as HTMLSelectElement).value)}
			disabled={saving}
		>
			{#each itemOptions as line (line)}
				<option value={line}>{line}</option>
			{/each}
		</select>
		{#if errors.item}<p class="field-error" role="alert">{t.plan.checks.itemRequired}</p>{/if}
	</label>

	<div class="check-form-kinds" role="group" aria-label={t.plan.checks.itemLabel}>
		{#each KINDS as kind (kind)}
			<button
				type="button"
				class="check-kind-btn"
				class:is-active={draft.kind === kind}
				onclick={() => selectKind(kind)}
				disabled={saving}
			>
				{kindLabel(kind)}
			</button>
		{/each}
	</div>

	{#if draft.kind === 'exists' || draft.kind === 'contains' || draft.kind === 'matches'}
		<label class="check-form-field">
			<span class="check-form-label">{t.plan.checks.pathLabel}</span>
			<input class="check-form-input" type="text" bind:value={draft.path} disabled={saving} />
			{#if errors.path}<p class="field-error" role="alert">{t.plan.checks.pathRequired}</p>{/if}
		</label>
	{/if}

	{#if draft.kind === 'contains' || draft.kind === 'matches'}
		<label class="check-form-field">
			<span class="check-form-label">{draft.kind === 'matches' ? t.plan.checks.patternLabelRegex : t.plan.checks.patternLabel}</span>
			<input class="check-form-input" type="text" bind:value={draft.pattern} disabled={saving} />
			{#if errors.pattern}<p class="field-error" role="alert">{t.plan.checks.patternRequired}</p>{/if}
		</label>
		<label class="check-form-checkbox">
			<input type="checkbox" bind:checked={draft.negate} disabled={saving} />
			<span>{draft.kind === 'matches' ? t.plan.checks.negateMatches : t.plan.checks.negateContains}</span>
		</label>
	{/if}

	{#if draft.kind === 'command'}
		<label class="check-form-field">
			<span class="check-form-label">{t.plan.checks.commandLabel}</span>
			<input class="check-form-input mono" type="text" bind:value={draft.command} disabled={saving} />
			{#if errors.command}<p class="field-error" role="alert">{t.plan.checks.commandRequired}</p>{/if}
		</label>
		<label class="check-form-field">
			<span class="check-form-label">{t.plan.checks.cwdLabel}</span>
			<input class="check-form-input mono" type="text" placeholder={t.plan.checks.cwdPlaceholder} bind:value={draft.cwd} disabled={saving} />
		</label>
		<label class="check-form-field is-narrow">
			<span class="check-form-label">{t.plan.checks.expectExitLabel}</span>
			<input class="check-form-input mono" type="text" inputmode="numeric" bind:value={draft.expectExit} disabled={saving} />
			{#if errors.expectExit}<p class="field-error" role="alert">{t.plan.checks.expectExitInvalid}</p>{/if}
		</label>
		<button type="button" class="check-form-toggle" aria-expanded={expectOpen} onclick={() => (expectOpen = !expectOpen)}>
			{expectOpen ? '▾' : '▸'} {t.plan.checks.expectStdoutToggle}
		</button>
		{#if expectOpen}
			<label class="check-form-field">
				<span class="check-form-label">{t.plan.checks.expectStdoutLabel}</span>
				<textarea class="check-form-textarea mono" bind:value={draft.expectStdout} disabled={saving}></textarea>
				<span class="check-form-hint">{t.plan.checks.expectStdoutHint}</span>
			</label>
		{/if}
		<label class="check-form-field is-narrow">
			<span class="check-form-label">{t.plan.checks.timeoutLabel}</span>
			<input class="check-form-input mono" type="text" inputmode="numeric" bind:value={draft.timeoutSec} disabled={saving} />
			{#if errors.timeoutSec}<p class="field-error" role="alert">{t.plan.checks.timeoutInvalid}</p>{/if}
		</label>
	{/if}

	{#if draft.kind === 'continuity'}
		<label class="check-form-field">
			<span class="check-form-label">{t.plan.checks.continuityPathLabel}</span>
			<input class="check-form-input mono" type="text" bind:value={draft.path} disabled={saving} />
		</label>
		<label class="check-form-field">
			<span class="check-form-label">{t.plan.checks.continuityCommandLabel}</span>
			<input class="check-form-input mono" type="text" bind:value={draft.command} disabled={saving} />
		</label>
		<label class="check-form-field">
			<span class="check-form-label">{t.plan.checks.cwdLabel}</span>
			<input class="check-form-input mono" type="text" placeholder={t.plan.checks.cwdPlaceholder} bind:value={draft.cwd} disabled={saving} />
		</label>
		{#if errors.pathOrCommand}<p class="field-error" role="alert">{t.plan.checks.pathOrCommandRequired}</p>{/if}
	{/if}

	{#if saveError}<p class="field-error" role="alert">{saveError}</p>{/if}

	<div class="check-form-actions">
		<button type="button" class="plan-spec-save-btn" onclick={submit} disabled={saving}>{t.plan.save}</button>
		<button type="button" class="plan-spec-cancel-btn" onclick={onCancel} disabled={saving}>{t.plan.cancel}</button>
	</div>
</div>

<style>
	.check-form {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border: 1px dashed var(--line-hover);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.check-form-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.check-form-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
	}

	.check-form-select,
	.check-form-input,
	.check-form-textarea {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: 13px/1.4 var(--font);
		padding: 6px 8px;
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.check-form-select:focus,
	.check-form-input:focus,
	.check-form-textarea:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.check-form-textarea {
		min-height: 52px;
		resize: vertical;
	}

	.check-form-field.is-narrow {
		max-width: 160px;
	}

	.check-form-kinds {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.check-kind-btn {
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 12px;
		font-weight: 500;
		padding: 5px 10px;
		cursor: pointer;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.check-kind-btn:hover:not(:disabled) {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	/* After the hover rule: a tap leaves the pointer (and on touch, a sticky :hover) on the chosen
	   button, and hover's accent text would vanish into the accent fill. */
	.check-kind-btn.is-active,
	.check-kind-btn.is-active:hover:not(:disabled) {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}

	.check-kind-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.check-form-checkbox {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--ink-secondary);
		cursor: pointer;
		width: fit-content;
	}

	.check-form-toggle {
		width: fit-content;
		border: none;
		background: none;
		padding: 2px 0;
		color: var(--accent);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
	}

	.check-form-hint {
		font-size: 11px;
		color: var(--muted-light);
	}

	.check-form-actions {
		display: flex;
		gap: 6px;
	}

	@media (max-width: 560px) {
		.check-form-field.is-narrow {
			max-width: none;
		}

		.check-kind-btn {
			min-height: 36px;
			padding: 6px 12px;
		}

		.check-form-select,
		.check-form-input,
		.check-form-textarea {
			font-size: 14px;
			padding: 8px 10px;
		}
	}
</style>
