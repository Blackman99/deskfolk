<script lang="ts">
	import type { AcceptanceCheck, Bot, TaskDetail, TaskSpecRevision, TicketStatus } from '@real-bot/protocol';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { formatFullTimestamp, formatMessageTime } from '../chat/chat-view.ts';
	import {
		SPEC_LIST_FIELDS,
		countsEntries,
		parseSpecLines,
		specLines,
		specWithGoal,
		specWithLines,
		ticketBinding,
		ticketTag,
		type SpecListField
	} from './plan-board.ts';
	import { checkSummary, checksForLine, derivedChecks, orphanChecks } from './acceptance-checks.ts';
	import AcceptanceCheckRow from './AcceptanceCheckRow.svelte';
	import AcceptanceCheckForm from './AcceptanceCheckForm.svelte';
	import PlanRequirements from './PlanRequirements.svelte';
	import PlanRetrospectives from './PlanRetrospectives.svelte';

	interface Props {
		api: MessengerApi | null;
		/** `detail.spec` may be null: the organizer has not run yet. */
		detail: TaskDetail;
		t: Copy;
		/** The saved plan comes back whole; the parent replaces its copy. */
		onSaved: (detail: TaskDetail) => void;
		/** A 409: the parent reloads the plan. */
		onConflict: () => void;
		onJump: (sessionId: string, messageId: string) => void;
		/**
		 * The ticket picked on the board. Every ticket meets this spec; with one picked, the lines held
		 * to it alone stand out and those held to another ticket alone step back.
		 */
		selectedTicket?: string | null;
		/** Show one ticket in the tickets panel, picked: a line held to it names it. */
		onShowTicket?: (ticketId: string) => void;
		/** Put the picked ticket down. */
		onClearTicket?: () => void;
		/** Open the tickets panel, on one status or on all. */
		onShowTickets?: (status: TicketStatus | 'all') => void;
		/** The Bots, for the name on a retrospective (ADR 0062). */
		bots?: readonly Bot[];
		deletedLabel?: string;
	}

	/**
	 * The plan's spec, whole. It used to fold itself above the board; now it opens beside the board
	 * or in a tab of its own, so the side panel or the tab is the fold and the panel just reads.
	 */
	let {
		api,
		detail,
		t,
		onSaved,
		onConflict,
		onJump,
		selectedTicket = null,
		onShowTicket,
		onClearTicket,
		onShowTickets,
		bots = [],
		deletedLabel = ''
	}: Props = $props();

	const ticketsById = $derived(new Map(detail.tickets.map((ticket) => [ticket.id, ticket] as const)));
	/** The picked ticket, while it is one of this plan's. */
	const focusTicket = $derived(selectedTicket ? (ticketsById.get(selectedTicket) ?? null) : null);
	const ticketStates = $derived(countsEntries(detail.ticket_counts));

	type Editing = 'title' | 'goal' | SpecListField;
	let editing = $state<Editing | null>(null);
	let draft = $state('');
	let saving = $state(false);
	let saveError = $state<string | null>(null);

	let historyOpen = $state(false);
	let historyLoading = $state(false);
	let historyFailed = $state(false);
	let history = $state<TaskSpecRevision[]>([]);
	let historyKey: string | null = null;

	let addingCheck = $state(false);
	let runningAll = $state(false);
	let runError = $state<string | null>(null);

	const checks = $derived(detail.checks ?? []);
	const acceptanceLines = $derived(detail.spec?.acceptance ?? []);
	const orphanedChecks = $derived(orphanChecks(checks, acceptanceLines));
	const fromYourWords = $derived(derivedChecks(checks));
	const checksTotal = $derived(checkSummary(checks));
	const anyCheckRunning = $derived(checks.some((check) => check.running));

	async function runAllChecks(): Promise<void> {
		if (!api || runningAll) return;
		runningAll = true;
		runError = null;
		try {
			const result = await api.runChecks(detail.id);
			onSaved(result);
		} catch {
			runError = t.plan.checks.runFailed;
		} finally {
			runningAll = false;
		}
	}

	function openAddCheck(): void {
		addingCheck = true;
		runError = null;
	}

	function checkSaved(result: TaskDetail): void {
		addingCheck = false;
		onSaved(result);
	}

	const GUIDELINE_FIELDS: readonly SpecListField[] = ['acceptance', 'rules', 'process'];
	const PROGRESS_FIELDS: readonly SpecListField[] = ['progress.done', 'progress.open', 'progress.blocked'];

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

	function startEditTitle(): void {
		editing = 'title';
		draft = detail.title;
		saveError = null;
	}

	function startEditGoal(): void {
		if (!detail.spec) return;
		renamed = false;
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

	/**
	 * Who wrote a version: you, the app's filing, or a stop of yours parking the plan or putting it
	 * back — the app wrote that one too, but it is no filing and says so.
	 */
	function actorLabel(actor: 'app' | 'user' | null, cause: 'hold' | null | undefined): string {
		if (cause === 'hold') return t.plan.byHold;
		return actor === 'user' ? t.plan.byUser : t.plan.byApp;
	}

	function errorStatus(err: unknown): number | undefined {
		if (err && typeof err === 'object' && 'status' in err) {
			const status = (err as { status?: unknown }).status;
			return typeof status === 'number' ? status : undefined;
		}
		return undefined;
	}

	/**
	 * Just renamed: the goal, which the Bots work to, said beside the new name until you edit it or
	 * leave. On 2026-10-04 you renamed a job 「做《一拳超人》动画」 and its goal still read 「制作一部未来
	 * 世界题材、时长超过2分钟…的短片」, further down the panel, where the Bots read it as the job.
	 */
	let renamed = $state(false);

	/** Your new name for the job: only the name, never the spec, so no revision guard is needed. */
	async function saveTitle(): Promise<void> {
		if (!api || editing !== 'title' || saving) return;
		if (!draft.trim()) { saveError = t.plan.saveFailed; return; }
		saving = true;
		saveError = null;
		try {
			onSaved(await api.renamePlan(detail.id, { title: draft }));
			editing = null;
			draft = '';
			renamed = Boolean(detail.spec?.goal.trim());
		} catch {
			saveError = t.plan.saveFailed;
		} finally {
			saving = false;
		}
	}

	/** Your word on the job's size (ADR 0060): large, laid out with a sample first; or no need. */
	let scaleSaving = $state(false);
	async function setScale(scale: 'large' | 'single'): Promise<void> {
		if (!api || scaleSaving) return;
		scaleSaving = true;
		saveError = null;
		try {
			onSaved(await api.setPlanScale(detail.id, { scale }));
		} catch {
			saveError = t.plan.saveFailed;
		} finally {
			scaleSaving = false;
		}
	}

	async function save(): Promise<void> {
		if (editing === 'title') return saveTitle();
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

{#snippet checkItem(check: AcceptanceCheck)}
	{@const owner = check.ticket_id ? (ticketsById.get(check.ticket_id) ?? null) : null}
	{@const binding = ticketBinding(owner?.id, focusTicket?.id ?? null)}
	<!-- A check filed under one ticket names it; the rest hold for the whole plan, so for every ticket. -->
	<span class="plan-spec-check" class:is-ticket-mine={binding === 'mine'} class:is-ticket-other={binding === 'other'}>
		{#if owner}
			{#if onShowTicket}
				<button
					type="button"
					class="plan-spec-ticket-ref mono"
					title={t.plan.links.showTicket(`${ticketTag(owner.seq)} ${owner.title}`)}
					onclick={() => onShowTicket(owner.id)}>{ticketTag(owner.seq)}</button
				>
			{:else}
				<span class="plan-spec-ticket-ref mono" title={owner.title}>{ticketTag(owner.seq)}</span>
			{/if}
		{/if}
		<AcceptanceCheckRow {api} {detail} {check} {t} onSaved={checkSaved} />
	</span>
{/snippet}

{#snippet title()}
	<div class="plan-spec-title-wrap">
		<svg class="plan-spec-title-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
			<polyline points="14 2 14 8 20 8"></polyline>
			<line x1="16" y1="13" x2="8" y2="13"></line>
			<line x1="16" y1="17" x2="8" y2="17"></line>
		</svg>
		<h3 class="plan-spec-title">{t.plan.spec.title}</h3>
	</div>
{/snippet}

{#snippet nameBlock()}
	<!-- What the job is called: named after the line that opened it until you name it. -->
	<div class="plan-spec-name">
		<div class="plan-spec-goal-top">
			<span class="plan-spec-name-label">{t.plan.spec.name}</span>
			{#if api && editing !== 'title'}
				<button type="button" class="plan-spec-edit-btn" onclick={startEditTitle} title={t.plan.spec.nameHint}>
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M12 20h9"></path>
						<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
					</svg>
					<span>{t.plan.edit}</span>
				</button>
			{/if}
		</div>
		{#if editing === 'title'}
			<div class="plan-spec-edit">
				<input class="plan-spec-goal-input plan-spec-name-input" type="text" bind:value={draft} disabled={saving} aria-label={t.plan.spec.name}
					onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void saveTitle(); } else if (event.key === 'Escape') { event.stopPropagation(); cancelEdit(); } }} />
				<p class="plan-spec-name-hint">{t.plan.spec.nameHint}</p>
				<div class="plan-spec-edit-actions">
					<button type="button" class="plan-spec-save-btn" onclick={saveTitle} disabled={saving || !draft.trim()}>{t.plan.save}</button>
					<button type="button" class="plan-spec-cancel-btn" onclick={cancelEdit} disabled={saving}>{t.plan.cancel}</button>
				</div>
				{#if saveError}<p class="plan-spec-error">{saveError}</p>{/if}
			</div>
		{:else}
			<div class="plan-spec-name-text">{detail.title}</div>
			{#if renamed && detail.spec && api}
				<p class="plan-spec-renamed-goal">
					{t.plan.spec.renamedGoal(detail.spec.goal)}
					<button type="button" class="plan-spec-edit-btn" onclick={startEditGoal}>{t.plan.spec.editGoal}</button>
				</p>
			{/if}
			<!-- A large job (ADR 0060): laid out before anything is made, its sample yours to approve; yours to call off. -->
			{#if detail.scale?.value === 'large'}
				<p class="plan-spec-scale is-large">
					<span>{t.plan.spec.scaleLarge(detail.scale.unit)} {t.plan.spec.scaleWhy[detail.scale.by](detail.scale.why)}</span>
					{#if api}<button type="button" class="plan-spec-edit-btn" onclick={() => setScale('single')} disabled={scaleSaving}>{t.plan.spec.scaleNotLarge}</button>{/if}
				</p>
			{:else if detail.scale?.value === 'single'}
				<p class="plan-spec-scale">
					<span>{t.plan.spec.scaleSingle}</span>
					{#if api}<button type="button" class="plan-spec-edit-btn" onclick={() => setScale('large')} disabled={scaleSaving}>{t.plan.spec.scaleMakeLarge}</button>{/if}
				</p>
			{/if}
		{/if}
	</div>
{/snippet}

<!-- What its Bots made of the job once it was delivered (ADR 0062): shown, not put to you. -->
{#snippet retrospectives()}
	{#if (detail.retrospectives ?? []).length > 0}
		<PlanRetrospectives {api} {detail} {t} {bots} {deletedLabel} {onSaved} />
	{/if}
{/snippet}

{#if !detail.spec && detail.revision === 0}
	<!--
		Nothing written up yet: no version to show and no history to open, and no claim that it is
		being written up — it is only once someone speaks. What there is, is the opening request.
	-->
	<section class="plan-spec is-empty" aria-label={t.plan.spec.title}>
		<div class="plan-spec-head">
			{@render title()}
		</div>
		{@render nameBlock()}
		<div class="plan-spec-empty-card">
			<p class="plan-spec-empty">{t.plan.noSpec}</p>
			{#if detail.brief}
				<p class="plan-spec-brief"><strong>{t.plan.brief}：</strong>{detail.brief}</p>
			{/if}
		</div>
	</section>
{:else}
<section class="plan-spec" aria-label={t.plan.spec.title}>
	<div class="plan-spec-head">
		{@render title()}
		<div class="plan-spec-head-badges">
			{#if detail.kind}
				<span class="plan-spec-kind-badge" title={t.plan.kind}>{detail.kind}</span>
			{/if}
			<span class="plan-spec-rev-badge">{t.plan.revision(detail.revision)}</span>
		</div>
	</div>

	<div class="plan-spec-body">
		{#if !detail.spec}
			{@render nameBlock()}
			<div class="plan-spec-empty-card">
				<p class="plan-spec-empty">{t.plan.noSpec}</p>
				{#if detail.brief}
					<p class="plan-spec-brief"><strong>{t.plan.brief}：</strong>{detail.brief}</p>
				{/if}
			</div>
			{@render retrospectives()}
		{:else}
			{@const spec = detail.spec}
			{#if focusTicket}
				<!-- The ticket picked on the board, read against the spec it has to meet. -->
				<div class="plan-spec-focus" role="status">
					<div class="plan-spec-focus-line">
						<span class="plan-spec-focus-label">{t.plan.links.focus}</span>
						{#if onShowTicket}
							<button
								type="button"
								class="plan-spec-focus-ticket"
								title={t.plan.links.showTicket(`${ticketTag(focusTicket.seq)} ${focusTicket.title}`)}
								onclick={() => onShowTicket(focusTicket.id)}
							>
								<span class="plan-spec-ticket-ref mono">{ticketTag(focusTicket.seq)}</span>
								<span class="plan-spec-focus-title">{focusTicket.title}</span>
							</button>
						{:else}
							<span class="plan-spec-focus-ticket">
								<span class="plan-spec-ticket-ref mono">{ticketTag(focusTicket.seq)}</span>
								<span class="plan-spec-focus-title">{focusTicket.title}</span>
							</span>
						{/if}
						{#if onClearTicket}
							<button type="button" class="plan-spec-focus-clear" aria-label={t.plan.links.clearFocus} title={t.plan.links.clearFocus} onclick={onClearTicket}>
								<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
									<line x1="18" y1="6" x2="6" y2="18"></line>
									<line x1="6" y1="6" x2="18" y2="18"></line>
								</svg>
							</button>
						{/if}
					</div>
					<p class="plan-spec-focus-hint">{t.plan.links.focusHint}</p>
				</div>
			{/if}
			{@render nameBlock()}
			<!-- Hero: Plan Goal -->
			<div class="plan-spec-goal">
				<div class="plan-spec-goal-top">
					<div class="plan-spec-goal-badge">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<circle cx="12" cy="12" r="10"></circle>
							<circle cx="12" cy="12" r="6"></circle>
							<circle cx="12" cy="12" r="2"></circle>
						</svg>
						<span class="plan-spec-goal-label">{t.plan.spec.goal}</span>
					</div>
					{#if api && editing !== 'goal'}
						<button type="button" class="plan-spec-edit-btn" onclick={startEditGoal} title={t.plan.edit}>
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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

			{@render retrospectives()}

			<!-- What you asked for: the requirements ledger, the list the Bots read too (ADR 0040 P3). -->
			{#if detail.requirements}
				<PlanRequirements {api} {detail} {t} {onSaved} {onJump} selectedTicket={focusTicket?.id ?? null} {onShowTicket} />
			{/if}

			<!-- Section: Guidelines (Acceptance, Rules, Process) -->
			<div class="plan-spec-section is-guidelines">
				{#each GUIDELINE_FIELDS as field (field)}
					{@const lines = specLines(spec, field)}
					{@const count = lines.length}
					<div class="plan-spec-list is-{field}">
						<div class="plan-spec-list-head">
							<div class="plan-spec-list-meta">
								{#if field === 'acceptance'}
									<svg class="plan-spec-field-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<polyline points="9 11 12 14 22 4"></polyline>
										<path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
									</svg>
								{:else if field === 'rules'}
									<svg class="plan-spec-field-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
									</svg>
								{:else}
									<svg class="plan-spec-field-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
								{#if field === 'acceptance' && checksTotal.total > 0}
									<span class="plan-spec-checks-summary mono">{t.plan.checks.summary(checksTotal.pass, checksTotal.total)}</span>
								{/if}
							</div>
							<div class="plan-spec-list-actions">
								{#if field === 'acceptance' && api}
									{#if checksTotal.total > 0}
										<button type="button" class="plan-spec-checks-run-btn" onclick={runAllChecks} disabled={runningAll || anyCheckRunning}>
											<span aria-hidden="true">▶</span> {t.plan.checks.run}
										</button>
									{/if}
									<button type="button" class="plan-spec-checks-add-btn" onclick={openAddCheck}>{t.plan.checks.add}</button>
								{/if}
								{#if api && editing !== field}
									<button type="button" class="plan-spec-edit-btn" onclick={() => startEditField(field)} title={t.plan.edit}>
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
											<path d="M12 20h9"></path>
											<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
										</svg>
										<span>{t.plan.edit}</span>
									</button>
								{/if}
							</div>
						</div>

						{#if field === 'acceptance' && runError}<p class="plan-spec-error">{runError}</p>{/if}

						{#if editing === field}
							<textarea class="plan-spec-textarea" bind:value={draft} placeholder={t.plan.linesHint} disabled={saving}></textarea>
							{#if field === 'acceptance'}<p class="plan-spec-checks-hint">{t.plan.checks.editHint}</p>{/if}
							<div class="plan-spec-edit-actions">
								<button type="button" class="plan-spec-save-btn" onclick={save} disabled={saving}>{t.plan.save}</button>
								<button type="button" class="plan-spec-cancel-btn" onclick={cancelEdit} disabled={saving}>{t.plan.cancel}</button>
							</div>
							{#if saveError}<p class="plan-spec-error">{saveError}</p>{/if}
						{:else}
							{@const lines = specLines(spec, field)}
							{#if lines.length > 0}
								<ul class="plan-spec-ul">
									{#each lines as line}<li>{line}{#if field === 'acceptance' && checksForLine(checks, line).length > 0}<span class="plan-spec-checks-pills">{#each checksForLine(checks, line) as check (check.id)}{@render checkItem(check)}{/each}</span>{/if}</li>{/each}
								</ul>
							{:else}
								<p class="plan-spec-empty-line">{t.plan.empty}</p>
							{/if}

							{#if field === 'acceptance' && fromYourWords.length > 0}
								<div class="plan-spec-checks-orphans">
									<span class="plan-spec-checks-orphans-title">{t.plan.checks.derivedTitle}</span>
									<ul class="plan-spec-ul">
										{#each fromYourWords as check (check.id)}<li>{check.item}<span class="plan-spec-checks-pills">{@render checkItem(check)}</span></li>{/each}
									</ul>
								</div>
							{/if}

							{#if field === 'acceptance' && orphanedChecks.length > 0}
								<div class="plan-spec-checks-orphans">
									<span class="plan-spec-checks-orphans-title">{t.plan.checks.orphansTitle}</span>
									<span class="plan-spec-checks-pills">
										{#each orphanedChecks as check (check.id)}
											{@render checkItem(check)}
										{/each}
									</span>
								</div>
							{/if}

							{#if field === 'acceptance' && addingCheck && api}
								<AcceptanceCheckForm {api} {detail} {t} editing={null} onSaved={checkSaved} onCancel={() => (addingCheck = false)} />
							{/if}
						{/if}
					</div>
				{/each}
			</div>

			<!--
				Where the tickets stand, above the organizer's written progress: the two describe the same
				work, and the tickets' own states are the ones to go by.
			-->
			{#if ticketStates.length > 0}
				<div class="plan-spec-ticket-states">
					<div class="plan-spec-ticket-states-line">
						<span class="plan-spec-ticket-states-label">{t.plan.links.ticketStates}</span>
						{#each ticketStates as entry (entry.status)}
							{#if onShowTickets}
								<button type="button" class="plan-spec-ticket-state is-{entry.status}" onclick={() => onShowTickets(entry.status)}>
									<span>{t.plan.ticketStatus[entry.status]}</span>
									<span class="mono">{entry.count}</span>
								</button>
							{:else}
								<span class="plan-spec-ticket-state is-{entry.status}">
									<span>{t.plan.ticketStatus[entry.status]}</span>
									<span class="mono">{entry.count}</span>
								</span>
							{/if}
						{/each}
					</div>
					<p class="plan-spec-ticket-states-hint">{t.plan.links.progressHint}</p>
				</div>
			{/if}

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
									<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
			<span class="plan-spec-actor">{actorLabel(detail.revision_actor, detail.revision_cause)}</span>
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
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
								<span class="plan-spec-revision-actor" class:is-hold={rev.cause === 'hold'}>{actorLabel(rev.actor, rev.cause)}</span>
								<span class="plan-spec-revision-time" title={formatFullTimestamp(rev.created_at)}>
									{formatMessageTime(rev.created_at)}
								</span>
								{#if rev.source_message_id && rev.session_id}
									<button
										type="button"
										class="plan-spec-revision-jump"
										onclick={() => onJump(rev.session_id!, rev.source_message_id!)}
									>
										<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
</section>
{/if}

<style>
	/* Flat, like the ticket list it takes turns with: the side panel or the tab is its frame. */
	.plan-spec {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
		padding: 12px 10px 20px;
		font: 12px/1.5 var(--font);
		color: var(--ink-secondary);
	}

	.plan-spec-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-width: 0;
		user-select: none;
	}

	.plan-spec-title-wrap {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.plan-spec-title-icon {
		flex: none;
		color: var(--accent);
	}

	.plan-spec-title {
		margin: 0;
		font-size: 13px;
		font-weight: 700;
		color: var(--ink);
		letter-spacing: -0.01em;
	}

	.plan-spec-head-badges {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.plan-spec-kind-badge {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		padding: 1px 7px;
		border-radius: var(--radius-full);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11px;
		font-weight: 500;
	}

	.plan-spec-rev-badge {
		flex: none;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 11px;
		font-weight: 600;
	}

	/* Body */
	.plan-spec-body {
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

	/* Hero Goal Card */
	.plan-spec-name {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 0 2px 10px;
		border-bottom: 1px solid var(--line-subtle);
	}
	.plan-spec-name-label {
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--muted);
		letter-spacing: 0.02em;
	}
	.plan-spec-name-text {
		font-size: var(--text-body);
		font-weight: 600;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	.plan-spec-name-hint {
		margin: 0;
		font-size: var(--text-caption);
		color: var(--muted);
	}
	.plan-spec-scale {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin: 4px 0 0;
		font-size: var(--text-caption);
		color: var(--ink-secondary);
	}

	.plan-spec-renamed-goal {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin: 4px 0 0;
		font-size: var(--text-caption);
		color: var(--ink-secondary);
	}
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
		font-size: 14px;
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
		/* Two columns only where each still fits its label and its edit button: not in a side panel. */
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	}

	.plan-spec-list {
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: 10px 11px;
		border-radius: var(--radius-md);
		border: 1px solid var(--line);
		background: var(--pane);
		box-shadow: 0 1px 2px rgba(18, 28, 32, 0.02);
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
		font-size: 12px;
		letter-spacing: -0.01em;
	}

	.plan-spec-field-count {
		flex: none;
		padding: 0 5px;
		border-radius: var(--radius-full);
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
		font-size: 10px;
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
		font-size: 10px;
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
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		min-height: 24px;
	}

	.plan-spec-edit-btn:hover {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.plan-spec-list-actions {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex: none;
	}

	.plan-spec-checks-summary {
		flex: none;
		padding: 1px 7px;
		border-radius: var(--radius-full);
		background: var(--accent-tint);
		color: var(--accent);
		font-size: 10px;
		font-weight: 700;
		line-height: 15px;
	}

	.plan-spec-checks-run-btn,
	.plan-spec-checks-add-btn {
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
		transition: 0.15s ease;
		transition-property: var(--transition-props);
		min-height: 24px;
	}

	.plan-spec-checks-run-btn:hover:not(:disabled),
	.plan-spec-checks-add-btn:hover:not(:disabled) {
		border-color: var(--accent-border);
		background: var(--accent-tint);
		color: var(--accent);
	}

	.plan-spec-checks-run-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.plan-spec-checks-hint {
		margin: 0;
		font-size: 11px;
		color: var(--muted-light);
	}

	.plan-spec-checks-pills {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 4px;
		margin-left: 4px;
		vertical-align: middle;
	}

	/* A check and, when it is filed under one ticket, that ticket's number before it. */
	.plan-spec-check {
		display: inline-flex;
		align-items: flex-start;
		gap: 4px;
		max-width: 100%;
		transition: opacity 0.15s ease;
	}

	.plan-spec-ticket-ref {
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--radius-xs);
		background: var(--line-subtle);
		color: var(--muted);
		font-size: 10px;
		font-weight: 700;
		line-height: 14px;
		padding: 2px 5px;
	}

	button.plan-spec-ticket-ref {
		cursor: pointer;
	}

	button.plan-spec-ticket-ref:hover {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.plan-spec-check.is-ticket-mine .plan-spec-ticket-ref {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}

	.plan-spec-check.is-ticket-other {
		opacity: 0.45;
	}

	/* The picked ticket, above the spec it has to meet. */
	.plan-spec-focus {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
		padding: 8px 10px;
		border: 1px solid var(--accent-border);
		border-radius: var(--radius-md);
		background: var(--accent-tint);
	}

	.plan-spec-focus-line {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.plan-spec-focus-label {
		flex: none;
		font-size: 11px;
		font-weight: 600;
		color: var(--accent);
	}

	.plan-spec-focus-ticket {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		flex: 1 1 auto;
		min-width: 0;
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		color: var(--ink);
		text-align: left;
	}

	button.plan-spec-focus-ticket {
		cursor: pointer;
	}

	button.plan-spec-focus-ticket:hover .plan-spec-focus-title {
		text-decoration: underline;
	}

	.plan-spec-focus .plan-spec-ticket-ref {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--on-accent);
	}

	.plan-spec-focus-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12px;
		font-weight: 600;
	}

	.plan-spec-focus-clear {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		border: none;
		border-radius: var(--radius-full);
		background: none;
		color: var(--muted);
		cursor: pointer;
	}

	.plan-spec-focus-clear:hover {
		background: var(--pane);
		color: var(--ink);
	}

	.plan-spec-focus-hint {
		margin: 0;
		font-size: 11px;
		color: var(--muted);
	}

	/* The tickets' own states, above the written progress that describes the same work. */
	.plan-spec-ticket-states {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.plan-spec-ticket-states-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	.plan-spec-ticket-states-label {
		flex: none;
		margin-right: 2px;
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
	}

	.plan-spec-ticket-state {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--radius-full);
		background: var(--pane);
		color: var(--ink-secondary);
		font: inherit;
		font-size: 11px;
		line-height: 1.4;
		padding: 1px 8px;
	}

	button.plan-spec-ticket-state {
		cursor: pointer;
	}

	button.plan-spec-ticket-state:hover {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.plan-spec-ticket-state::before {
		content: "";
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--muted-light);
	}

	.plan-spec-ticket-state.is-doing::before {
		background: var(--accent);
	}

	.plan-spec-ticket-state.is-review::before {
		background: var(--purple);
	}

	.plan-spec-ticket-state.is-done::before {
		background: var(--ok);
	}

	.plan-spec-ticket-state.is-parked::before {
		background: var(--muted);
	}

	.plan-spec-ticket-states-hint {
		margin: 0;
		font-size: 11px;
		color: var(--muted-light);
	}

	.plan-spec-checks-orphans {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px dashed var(--line);
	}

	.plan-spec-checks-orphans-title {
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
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
		font-size: 12px;
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
		font: 13px/1.4 var(--font);
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
		font-size: 12px;
		font-weight: 500;
		padding: 5px 11px;
		cursor: pointer;
		min-height: 28px;
		transition: 0.15s ease;
		transition-property: var(--transition-props);
	}

	.plan-spec-save-btn {
		border: 1px solid var(--accent);
		background: var(--accent);
		color: var(--on-accent);
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
		font-size: 12px;
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
		padding: 8px 2px 0;
		border-top: 1px solid var(--line);
		font-size: 11px;
		color: var(--muted);
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
		padding: 10px 2px 0;
		border-top: 1px solid var(--line);
	}

	.plan-spec-history-loading,
	.plan-spec-history-none {
		margin: 0;
		font-size: 12px;
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
		box-shadow: 0 1px 2px rgba(18, 28, 32, 0.02);
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
		border-radius: var(--radius-xs);
		background: var(--line-subtle);
		font-size: 11px;
	}

	.plan-spec-revision-actor {
		color: var(--ink-secondary);
		font-weight: 500;
	}

	/* Written by a stop, not by anyone's edit: quieter than the versions someone wrote. */
	.plan-spec-revision-actor.is-hold {
		color: var(--muted);
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
		border-radius: var(--radius-xs);
		transition: background 0.15s ease;
	}

	.plan-spec-revision-jump:hover {
		background: var(--accent-tint);
	}

	/* Mobile / Narrow Screen Responsiveness */
	@media (max-width: 560px) {
		.plan-spec-section.is-guidelines,
		.plan-spec-section.is-progress {
			grid-template-columns: 1fr;
		}

		.plan-spec-edit-btn {
			min-height: 30px;
			padding: 4px 9px;
		}

		.plan-spec-list-head {
			flex-wrap: wrap;
		}

		.plan-spec-list-actions {
			flex-wrap: wrap;
		}

		.plan-spec-checks-run-btn,
		.plan-spec-checks-add-btn {
			min-height: 36px;
			padding: 6px 12px;
		}

		.plan-spec-checks-pills {
			margin-left: 0;
			width: 100%;
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
			font-size: 13px;
		}

		.plan-spec-history-toggle {
			min-height: 30px;
		}
	}
</style>
