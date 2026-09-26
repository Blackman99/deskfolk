<script lang="ts">
	import type { TaskDetail, TaskSpecRevision } from '@real-bot/protocol';
	import { untrack } from 'svelte';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import {
		SPEC_LIST_FIELDS,
		parseSpecLines,
		specLines,
		specWithGoal,
		specWithLines,
		type SpecListField
	} from './plan-board.ts';

	interface Props {
		api: MessengerApi | null;
		/** `detail.spec` may be null: the organizer has not run yet. */
		detail: TaskDetail;
		t: Copy;
		/** Collapsed by default on a phone page; open in a pane. */
		defaultOpen?: boolean;
		/** The saved plan comes back whole; the parent replaces its copy. */
		onSaved: (detail: TaskDetail) => void;
		/** A 409: the parent reloads the plan. */
		onConflict: () => void;
		onJump: (sessionId: string, messageId: string) => void;
	}

	let { api, detail, t, defaultOpen = true, onSaved, onConflict, onJump }: Props = $props();

	let open = $state(untrack(() => defaultOpen));

	type Editing = 'goal' | SpecListField;
	let editing = $state<Editing | null>(null);
	let draft = $state('');
	let saving = $state(false);
	let saveError = $state<string | null>(null);

	let historyOpen = $state(false);
	let historyLoading = $state(false);
	let historyFailed = $state(false);
	let history = $state<TaskSpecRevision[]>([]);
	let historyKey: string | null = null;

	const GUIDELINE_FIELDS: readonly SpecListField[] = ['acceptance', 'rules', 'process'];
	const PROGRESS_FIELDS: readonly SpecListField[] = ['progress.done', 'progress.open', 'progress.blocked'];

	function toggle(): void {
		open = !open;
	}

	function fieldLabel(field: SpecListField): string {
		if (field === 'acceptance') return t.plan.spec.acceptance;
		if (field === 'rules') return t.plan.spec.rules;
		if (field === 'process') return t.plan.spec.process;
		const sub = field === 'progress.done' ? t.plan.spec.done : field === 'progress.open' ? t.plan.spec.open : t.plan.spec.blocked;
		return `${t.plan.spec.progress} · ${sub}`;
	}

	function fieldShortLabel(field: SpecListField): string {
		if (field === 'acceptance') return t.plan.spec.acceptance;
		if (field === 'rules') return t.plan.spec.rules;
		if (field === 'process') return t.plan.spec.process;
		if (field === 'progress.done') return t.plan.spec.done;
		if (field === 'progress.open') return t.plan.spec.open;
		return t.plan.spec.blocked;
	}

	function startEditGoal(): void {
		if (!detail.spec) return;
		editing = 'goal';
		draft = detail.spec.goal;
		saveError = null;
	}

	function startEditField(field: SpecListField): void {
		if (!detail.spec) return;
		editing = field;
		draft = specLines(detail.spec, field).join('\n');
		saveError = null;
	}

	function cancelEdit(): void {
		editing = null;
		draft = '';
		saveError = null;
	}

	function errorStatus(err: unknown): number | undefined {
		if (err && typeof err === 'object' && 'status' in err) {
			const status = (err as { status?: unknown }).status;
			return typeof status === 'number' ? status : undefined;
		}
		return undefined;
	}

	async function save(): Promise<void> {
		if (!api || !detail.spec || editing === null || saving) return;
		const nextSpec = editing === 'goal' ? specWithGoal(detail.spec, draft) : specWithLines(detail.spec, editing, parseSpecLines(draft));
		saving = true;
		saveError = null;
		try {
			const result = await api.patchTaskSpec(detail.id, { spec: nextSpec, if_revision: detail.revision });
			onSaved(result);
			editing = null;
			draft = '';
		} catch (err) {
			if (errorStatus(err) === 409) {
				saveError = t.plan.conflict;
				onConflict();
			} else {
				saveError = t.plan.saveFailed;
			}
		} finally {
			saving = false;
		}
	}

	async function toggleHistory(): Promise<void> {
		if (!api) return;
		historyOpen = !historyOpen;
		if (!historyOpen) return;
		const key = `${detail.id}:${detail.revision}`;
		if (historyKey === key) return;
		historyKey = key;
		historyLoading = true;
		historyFailed = false;
		try {
			history = await api.taskSpecRevisions(detail.id);
		} catch {
			historyFailed = true;
		} finally {
			historyLoading = false;
		}
	}
</script>

{#if !detail.spec && detail.revision === 0}
	<!--
		Nothing written up yet: one line, not a panel of blanks. There is no version to show and no
		history to open, and no claim that it is being written up — it is only once someone speaks.
	-->
	<section class="plan-spec is-empty" aria-label={t.plan.spec.title} title={t.plan.noSpec}>
		<span class="plan-spec-empty-title">{t.plan.spec.title}</span>
		<span class="plan-spec-empty">{t.plan.noSpecShort}</span>
		{#if detail.brief}
			<span class="plan-spec-brief"><strong>{t.plan.brief}：</strong>{detail.brief}</span>
		{/if}
	</section>
{:else}
<section class="plan-spec" aria-label={t.plan.spec.title}>
	<div class="plan-spec-head">
		<button type="button" class="plan-spec-toggle" aria-expanded={open} onclick={toggle}>
			<span class="plan-spec-icon-wrap" aria-hidden="true">
				<svg class="plan-spec-caret" class:is-open={open} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="9 6 15 12 9 18"></polyline>
				</svg>
			</span>
			<span class="plan-spec-toggle-title">{t.plan.spec.title}</span>
		</button>

		{#if !open}
			<div class="plan-spec-summary">
				{#if detail.kind}
					<span class="plan-spec-summary-kind">{t.plan.kind}: {detail.kind}</span>
				{/if}
				<span class="plan-spec-summary-rev">{t.plan.revision(detail.revision)}</span>
				{#if detail.spec?.goal}
					<span class="plan-spec-summary-goal">
						<span class="plan-spec-summary-sep" aria-hidden="true">·</span>
						<span class="plan-spec-summary-goal-text">{detail.spec.goal}</span>
					</span>
				{/if}
			</div>
		{:else if detail.spec?.goal}
			<div class="plan-spec-head-badges">
				{#if detail.kind}
					<span class="plan-spec-kind-badge">{detail.kind}</span>
				{/if}
				<span class="plan-spec-rev-badge">{t.plan.revision(detail.revision)}</span>
			</div>
		{/if}
	</div>

	{#if open}
		<div class="plan-spec-body">
			{#if !detail.spec}
				<div class="plan-spec-empty-card">
					<p class="plan-spec-empty">{t.plan.noSpec}</p>
					{#if detail.brief}
						<p class="plan-spec-brief"><strong>{t.plan.brief}：</strong>{detail.brief}</p>
					{/if}
				</div>
			{:else}
				{@const spec = detail.spec}
				<!-- Hero: Plan Goal -->
				<div class="plan-spec-goal">
					<div class="plan-spec-goal-top">
						<div class="plan-spec-goal-badge">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
								<circle cx="12" cy="12" r="10"></circle>
								<circle cx="12" cy="12" r="6"></circle>
								<circle cx="12" cy="12" r="2"></circle>
							</svg>
							<span class="plan-spec-goal-label">{t.plan.spec.goal}</span>
						</div>
						{#if api && editing !== 'goal'}
							<button type="button" class="plan-spec-edit-btn" onclick={startEditGoal} title={t.plan.edit}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<path d="M12 20h9"></path>
									<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
								</svg>
								<span>{t.plan.edit}</span>
							</button>
						{/if}
					</div>

					{#if editing === 'goal'}
						<div class="plan-spec-edit">
							<input class="plan-spec-goal-input" type="text" bind:value={draft} disabled={saving} />
							<div class="plan-spec-edit-actions">
								<button type="button" class="plan-spec-save-btn" onclick={save} disabled={saving}>{t.plan.save}</button>
								<button type="button" class="plan-spec-cancel-btn" onclick={cancelEdit} disabled={saving}>{t.plan.cancel}</button>
							</div>
							{#if saveError}<p class="plan-spec-error">{saveError}</p>{/if}
						</div>
					{:else}
						<div class="plan-spec-goal-text">{spec.goal}</div>
					{/if}
				</div>

				<!-- Section: Guidelines (Acceptance, Rules, Process) -->
				<div class="plan-spec-section is-guidelines">
					{#each GUIDELINE_FIELDS as field (field)}
						{@const lines = specLines(spec, field)}
						{@const count = lines.length}
						<div class="plan-spec-list is-{field}">
							<div class="plan-spec-list-head">
								<div class="plan-spec-list-meta">
									{#if field === 'acceptance'}
										<svg class="plan-spec-field-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<polyline points="9 11 12 14 22 4"></polyline>
											<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
										</svg>
									{:else if field === 'rules'}
										<svg class="plan-spec-field-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
										</svg>
									{:else}
										<svg class="plan-spec-field-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<line x1="6" y1="3" x2="6" y2="15"></line>
											<circle cx="18" cy="6" r="3"></circle>
											<circle cx="6" cy="18" r="3"></circle>
											<path d="M18 9a9 9 0 0 1-9 9"></path>
										</svg>
									{/if}
									<span class="plan-spec-list-label">{fieldLabel(field)}</span>
									{#if count > 0}
										<span class="plan-spec-field-count mono">{count}</span>
									{/if}
								</div>
								{#if api && editing !== field}
									<button type="button" class="plan-spec-edit-btn" onclick={() => startEditField(field)} title={t.plan.edit}>
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<path d="M12 20h9"></path>
											<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
										</svg>
										<span>{t.plan.edit}</span>
									</button>
								{/if}
							</div>

							{#if editing === field}
								<textarea class="plan-spec-textarea" bind:value={draft} placeholder={t.plan.linesHint} disabled={saving}></textarea>
								<div class="plan-spec-edit-actions">
									<button type="button" class="plan-spec-save-btn" onclick={save} disabled={saving}>{t.plan.save}</button>
									<button type="button" class="plan-spec-cancel-btn" onclick={cancelEdit} disabled={saving}>{t.plan.cancel}</button>
								</div>
								{#if saveError}<p class="plan-spec-error">{saveError}</p>{/if}
							{:else}
								{@const lines = specLines(spec, field)}
								{#if lines.length > 0}
									<ul class="plan-spec-ul">
										{#each lines as line}<li>{line}</li>{/each}
									</ul>
								{:else}
									<p class="plan-spec-empty-line">{t.plan.empty}</p>
								{/if}
							{/if}
						</div>
					{/each}
				</div>

				<!-- Section: Progress Dashboard (Done, Open, Blocked) -->
				<div class="plan-spec-section is-progress">
					{#each PROGRESS_FIELDS as field (field)}
						{@const isBlocked = field === 'progress.blocked'}
						{@const isDone = field === 'progress.done'}
						{@const lines = specLines(spec, field)}
						<div class="plan-spec-list is-{field.replace('.', '-')} {isBlocked && lines.length > 0 ? 'is-alert' : ''}">
							<div class="plan-spec-list-head">
								<div class="plan-spec-list-meta">
									{#if isDone}
										<span class="plan-spec-status-dot is-done" aria-hidden="true">✓</span>
									{:else if isBlocked}
										<span class="plan-spec-status-dot is-blocked" aria-hidden="true">!</span>
									{:else}
										<span class="plan-spec-status-dot is-open" aria-hidden="true">●</span>
									{/if}
									<span class="plan-spec-list-label">{fieldLabel(field)}</span>
									{#if lines.length > 0}
										<span class="plan-spec-field-count mono">{lines.length}</span>
									{/if}
								</div>
								{#if api && editing !== field}
									<button type="button" class="plan-spec-edit-btn" onclick={() => startEditField(field)} title={t.plan.edit}>
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<path d="M12 20h9"></path>
											<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
										</svg>
										<span>{t.plan.edit}</span>
									</button>
								{/if}
							</div>

							{#if editing === field}
								<textarea class="plan-spec-textarea" bind:value={draft} placeholder={t.plan.linesHint} disabled={saving}></textarea>
								<div class="plan-spec-edit-actions">
									<button type="button" class="plan-spec-save-btn" onclick={save} disabled={saving}>{t.plan.save}</button>
									<button type="button" class="plan-spec-cancel-btn" onclick={cancelEdit} disabled={saving}>{t.plan.cancel}</button>
								</div>
								{#if saveError}<p class="plan-spec-error">{saveError}</p>{/if}
							{:else if lines.length > 0}
								<ul class="plan-spec-ul">
									{#each lines as line}<li>{line}</li>{/each}
								</ul>
							{:else}
								<p class="plan-spec-empty-line">{t.plan.empty}</p>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>

		<div class="plan-spec-foot">
			<div class="plan-spec-foot-meta">
				<span class="plan-spec-rev mono">{t.plan.revision(detail.revision)}</span>
				<span class="plan-spec-dot" aria-hidden="true">·</span>
				<span class="plan-spec-actor">{detail.revision_actor === 'user' ? t.plan.byUser : t.plan.byApp}</span>
				{#if detail.spec_updated_at}
					<span class="plan-spec-dot" aria-hidden="true">·</span>
					<span class="plan-spec-time" title={formatFullTimestamp(detail.spec_updated_at)}>
						<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="10"></circle>
							<polyline points="12 6 12 12 16 14"></polyline>
						</svg>
						<span>{formatMessageTime(detail.spec_updated_at)}</span>
					</span>
				{/if}
			</div>
			{#if api}
				<button type="button" class="plan-spec-history-toggle" aria-expanded={historyOpen} onclick={toggleHistory}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<circle cx="12" cy="12" r="10"></circle>
						<polyline points="12 6 12 12 14 14"></polyline>
						<path d="M3.05 11a9 9 0 0 1 .5-2m-.5 2H7"></path>
					</svg>
					<span>{t.plan.history}</span>
				</button>
			{/if}
		</div>

		{#if historyOpen}
			<div class="plan-spec-history">
				{#if historyLoading}
					<p class="plan-spec-history-loading">{t.plan.history}…</p>
				{:else if historyFailed}
					<p class="plan-spec-error">{t.plan.saveFailed}</p>
				{:else if history.length === 0}
					<p class="plan-spec-history-none">{t.plan.historyNone}</p>
				{:else}
					<div class="plan-spec-history-list">
						{#each history as rev (rev.id)}
							<div class="plan-spec-revision">
								<div class="plan-spec-revision-header">
									<span class="plan-spec-revision-n mono">{t.plan.revision(rev.revision)}</span>
									<span class="plan-spec-revision-actor">{rev.actor === 'user' ? t.plan.byUser : t.plan.byApp}</span>
									<span class="plan-spec-revision-time" title={formatFullTimestamp(rev.created_at)}>
										{formatMessageTime(rev.created_at)}
									</span>
									{#if rev.source_message_id && rev.session_id}
										<button
											type="button"
											class="plan-spec-revision-jump"
											onclick={() => onJump(rev.session_id!, rev.source_message_id!)}
										>
											<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
												<polyline points="15 3 21 3 21 9"></polyline>
												<line x1="10" y1="14" x2="21" y2="3"></line>
											</svg>
											<span>{t.plan.jumpToMessage}</span>
										</button>
									{/if}
								</div>
								<div class="plan-spec-revision-goal">{rev.spec.goal}</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</section>
{/if}

<style>
	.plan-spec {
		margin: 0 12px 10px;
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		font: 12px/1.5 var(--font);
		color: var(--ink-secondary);
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.plan-spec:focus-within {
		border-color: var(--accent-border);
	}

	/* Head Bar */
	.plan-spec-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		min-width: 0;
		padding: 9px 12px;
		border-radius: inherit;
		user-select: none;
	}

	.plan-spec-toggle {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		background: none;
		border: none;
		padding: 3px 6px;
		margin: -3px -6px;
		border-radius: var(--radius-sm);
		font: 600 12.5px/1.3 var(--font);
		color: var(--ink);
		cursor: pointer;
		transition: background 0.15s ease, color 0.15s ease;
		min-height: 28px;
	}

	.plan-spec-toggle:hover {
		background: var(--chip);
		color: var(--accent);
	}

	.plan-spec-icon-wrap {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 4px;
		background: var(--line-subtle);
		color: var(--muted);
		transition: background 0.15s ease, color 0.15s ease;
	}

	.plan-spec-toggle:hover .plan-spec-icon-wrap {
		background: var(--accent-tint);
		color: var(--accent);
	}

	.plan-spec-caret {
		flex: none;
		transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
	}

	.plan-spec-caret.is-open {
		transform: rotate(90deg);
	}

	.plan-spec-toggle-title {
		letter-spacing: -0.01em;
	}

	.plan-spec-summary {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11.5px;
		color: var(--muted);
	}

	.plan-spec-summary-kind {
		flex: none;
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 10.5px;
		font-weight: 500;
	}

	.plan-spec-summary-rev {
		flex: none;
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 10.5px;
		font-weight: 600;
	}

	.plan-spec-summary-goal {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.plan-spec-summary-sep {
		color: var(--muted-light);
	}

	.plan-spec-summary-goal-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink-secondary);
		font-weight: 500;
	}

	.plan-spec-head-badges {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: none;
	}

	.plan-spec-kind-badge {
		padding: 1px 7px;
		border-radius: 9999px;
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 10.5px;
		font-weight: 500;
	}

	.plan-spec-rev-badge {
		padding: 1px 6px;
		border-radius: 9999px;
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 10.5px;
		font-weight: 600;
	}

	/* Body */
	.plan-spec-body {
		padding: 0 12px 12px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.plan-spec-empty-card {
		padding: 12px;
		border-radius: var(--radius-md);
		background: var(--line-subtle);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.plan-spec-empty,
	.plan-spec-brief {
		margin: 0;
		font-size: 12px;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.plan-spec.is-empty {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 4px 10px;
		padding: 8px 12px;
		box-shadow: none;
	}

	.plan-spec-empty-title {
		font: 600 12.5px/1.3 var(--font);
		color: var(--ink);
	}

	.plan-spec.is-empty .plan-spec-empty {
		color: var(--muted);
	}

	.plan-spec.is-empty .plan-spec-brief {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1 1 12em;
	}

	/* Hero Goal Card */
	.plan-spec-goal {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 12px;
		border-radius: var(--radius-md);
		border: 1px solid var(--accent-border);
		background: linear-gradient(135deg, var(--accent-tint) 0%, var(--pane) 60%);
	}

	.plan-spec-goal-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
	}

	.plan-spec-goal-badge {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--accent);
	}

	.plan-spec-goal-label {
		font-weight: 700;
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--accent);
	}

	.plan-spec-goal-text {
		color: var(--ink);
		font-size: 13.5px;
		font-weight: 600;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	/* Sections Grids */
	.plan-spec-section {
		display: grid;
		gap: 10px;
	}

	.plan-spec-section.is-guidelines {
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
	}

	.plan-spec-section.is-progress {
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	}

	.plan-spec-list {
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: 10px 11px;
		border-radius: var(--radius-md);
		border: 1px solid var(--line);
		background: var(--pane);
		box-shadow: 0 1px 2px rgba(15, 23, 42, 0.02);
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.plan-spec-list:hover {
		border-color: var(--line-hover);
	}

	.plan-spec-list.is-alert {
		border-color: var(--danger-line);
		background: var(--danger-bg);
	}

	.plan-spec-list-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		margin-bottom: 7px;
	}

	.plan-spec-list-meta {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.plan-spec-field-icon {
		flex: none;
		color: var(--muted);
	}

	.plan-spec-list-label {
		flex: none;
		font-weight: 600;
		color: var(--muted);
		font-size: 11.5px;
		letter-spacing: -0.01em;
	}

	.plan-spec-field-count {
		flex: none;
		padding: 0 5px;
		border-radius: 9999px;
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 10px;
		font-weight: 700;
		line-height: 15px;
	}

	.plan-spec-status-dot {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		font-size: 9px;
		font-weight: 700;
		line-height: 1;
		flex: none;
	}

	.plan-spec-status-dot.is-done {
		background: var(--ok-bg);
		color: var(--ok-text);
		border: 1px solid var(--ok-line);
	}

	.plan-spec-status-dot.is-open {
		background: var(--accent-tint);
		color: var(--accent);
		border: 1px solid var(--accent-border);
		font-size: 8px;
	}

	.plan-spec-status-dot.is-blocked {
		background: var(--danger-bg);
		color: var(--danger-text);
		border: 1px solid var(--danger-line);
	}

	.plan-spec-edit-btn {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 500;
		line-height: 1;
		padding: 3px 7px;
		cursor: pointer;
		transition: all 0.15s ease;
		min-height: 24px;
	}

	.plan-spec-edit-btn:hover {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.plan-spec-ul {
		margin: 0;
		padding: 0 0 0 14px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.plan-spec-ul li {
		font-size: 12px;
		line-height: 1.45;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.plan-spec-list.is-progress-done .plan-spec-ul li::marker {
		color: var(--ok);
	}

	.plan-spec-list.is-progress-open .plan-spec-ul li::marker {
		color: var(--accent);
	}

	.plan-spec-list.is-progress-blocked .plan-spec-ul li::marker {
		color: var(--danger);
	}

	.plan-spec-empty-line {
		margin: 0;
		font-size: 11.5px;
		color: var(--muted-light);
		font-style: italic;
	}

	/* Edit forms */
	.plan-spec-edit {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 100%;
	}

	.plan-spec-goal-input,
	.plan-spec-textarea {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--input-bg);
		color: var(--ink);
		font: 12.5px/1.4 var(--font);
		padding: 7px 9px;
		transition: border-color 0.15s ease, box-shadow 0.15s ease;
	}

	.plan-spec-goal-input:focus,
	.plan-spec-textarea:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent-glow);
	}

	.plan-spec-textarea {
		min-height: 68px;
		resize: vertical;
	}

	.plan-spec-edit-actions {
		display: flex;
		gap: 6px;
	}

	.plan-spec-save-btn,
	.plan-spec-cancel-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-sm);
		font-size: 11.5px;
		font-weight: 500;
		padding: 5px 11px;
		cursor: pointer;
		min-height: 28px;
		transition: all 0.15s ease;
	}

	.plan-spec-save-btn {
		border: 1px solid var(--accent);
		background: var(--accent);
		color: #ffffff;
	}

	.plan-spec-save-btn:hover:not(:disabled) {
		background: var(--accent-hover);
		border-color: var(--accent-hover);
	}

	.plan-spec-cancel-btn {
		border: 1px solid var(--line);
		background: var(--chip);
		color: var(--ink-secondary);
	}

	.plan-spec-cancel-btn:hover:not(:disabled) {
		background: var(--line-subtle);
		border-color: var(--line-hover);
	}

	.plan-spec-save-btn:disabled,
	.plan-spec-cancel-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.plan-spec-error {
		margin: 0;
		font-size: 11.5px;
		color: var(--danger-text);
		overflow-wrap: anywhere;
	}

	/* Footer */
	.plan-spec-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 8px 12px;
		border-top: 1px solid var(--line);
		font-size: 11px;
		color: var(--muted);
		background: var(--sidebar-bg);
		border-bottom-left-radius: inherit;
		border-bottom-right-radius: inherit;
	}

	.plan-spec-foot-meta {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.plan-spec-rev {
		font-weight: 600;
		color: var(--ink-secondary);
	}

	.plan-spec-actor {
		color: var(--muted);
	}

	.plan-spec-time {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--muted);
	}

	.plan-spec-dot {
		color: var(--muted-light);
	}

	.plan-spec-history-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: none;
		background: none;
		padding: 3px 6px;
		margin: -3px -6px;
		border-radius: var(--radius-sm);
		color: var(--accent);
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.plan-spec-history-toggle:hover {
		background: var(--accent-tint);
	}

	/* History list */
	.plan-spec-history {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px 12px 12px;
		background: var(--sidebar-bg);
		border-top: 1px solid var(--line);
		border-bottom-left-radius: inherit;
		border-bottom-right-radius: inherit;
	}

	.plan-spec-history-loading,
	.plan-spec-history-none {
		margin: 0;
		font-size: 11.5px;
		color: var(--muted);
		font-style: italic;
	}

	.plan-spec-history-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.plan-spec-revision {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--pane);
		padding: 7px 10px;
		font-size: 11px;
		box-shadow: 0 1px 2px rgba(15, 23, 42, 0.02);
	}

	.plan-spec-revision-header {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		flex-wrap: wrap;
	}

	.plan-spec-revision-n {
		font-weight: 700;
		color: var(--ink);
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--line-subtle);
		font-size: 10.5px;
	}

	.plan-spec-revision-actor {
		color: var(--ink-secondary);
		font-weight: 500;
	}

	.plan-spec-revision-time {
		color: var(--muted);
	}

	.plan-spec-revision-goal {
		width: 100%;
		overflow-wrap: anywhere;
		color: var(--ink-secondary);
		line-height: 1.4;
	}

	.plan-spec-revision-jump {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		margin-left: auto;
		border: none;
		background: none;
		padding: 2px 4px;
		color: var(--accent);
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		border-radius: 3px;
		transition: background 0.15s ease;
	}

	.plan-spec-revision-jump:hover {
		background: var(--accent-tint);
	}

	/* Mobile / Narrow Screen Responsiveness */
	@media (max-width: 560px) {
		.plan-spec {
			margin: 0 8px 8px;
		}

		.plan-spec-head {
			padding: 8px 10px;
		}

		.plan-spec-toggle {
			min-height: 36px;
		}

		.plan-spec-summary {
			max-width: 55%;
		}

		.plan-spec-section.is-guidelines,
		.plan-spec-section.is-progress {
			grid-template-columns: 1fr;
		}

		.plan-spec-edit-btn {
			min-height: 30px;
			padding: 4px 9px;
		}

		.plan-spec-goal-input,
		.plan-spec-textarea {
			font-size: 14px;
			padding: 8px 10px;
		}

		.plan-spec-save-btn,
		.plan-spec-cancel-btn {
			min-height: 36px;
			padding: 6px 14px;
			font-size: 12.5px;
		}

		.plan-spec-history-toggle {
			min-height: 30px;
		}
	}
</style>
