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
	import {
		badgeOf,
		bySeverity,
		checkSummary,
		checksByItem,
		checksForLine,
		derivedChecks,
		failingChecks,
		firstReason,
		orphanChecks,
		sampleChecks
	} from './acceptance-checks.ts';
	import AcceptanceCheckRow from './AcceptanceCheckRow.svelte';
	import AcceptanceCheckForm from './AcceptanceCheckForm.svelte';
	import PlanRequirements from './PlanRequirements.svelte';
	import PlanRetrospectives from './PlanRetrospectives.svelte';
	import PlanSpecOverview from './PlanSpecOverview.svelte';

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
	/** A check under a ticket sorts by that ticket's number among checks in the same state. */
	const ticketSeq = (check: AcceptanceCheck): number =>
		(check.ticket_id ? ticketsById.get(check.ticket_id)?.seq : undefined) ?? Number.MAX_SAFE_INTEGER;
	const orphanedChecks = $derived(bySeverity(orphanChecks(checks, acceptanceLines), ticketSeq));
	const fromYourWords = $derived(derivedChecks(checks));
	/** Held to the approved sample (ADR 0060): one line, each ticket's check under it, failures first. */
	const heldToSample = $derived(checksByItem(sampleChecks(checks)).map((group) => ({ item: group.item, checks: bySeverity(group.checks, ticketSeq) })));
	const checksTotal = $derived(checkSummary(checks));
	const anyCheckRunning = $derived(checks.some((check) => check.running));

	/**
	 * What needs you, said once, under the goal: the checks that failed, what is written up as
	 * blocked, and your requirements waiting for your word. On 2026-10-09 the one failed sample
	 * check sat as the first of eleven like-sized pills and nothing on the page said to look there.
	 */
	const ATTENTION_CHECKS = 3;
	const failing = $derived(bySeverity(failingChecks(checks), ticketSeq));
	const waitingRequirements = $derived(
		(detail.requirements ?? []).filter((entry) => !entry.excluded && (entry.status === 'proposed' || entry.status === 'unverified' || entry.withdraw_proposed)).length
	);
	const needsYou = $derived(failing.length > 0 || (detail.spec?.progress.blocked.length ?? 0) > 0 || waitingRequirements > 0);
	let sectionEl = $state<HTMLElement | null>(null);

	function showWaitingRequirements(): void {
		sectionEl?.querySelector('.plan-reqs-group.is-aside')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
	}

	/** Done is folded while anything is still open or blocked; the head says how many. */
	let doneOpen = $state<boolean | null>(null);
	const doneShown = $derived(
		doneOpen ?? ((detail.spec?.progress.open.length ?? 0) + (detail.spec?.progress.blocked.length ?? 0) === 0)
	);

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
	/** Blocked, open, then done; a field with nothing written goes after those with something. */
	const PROGRESS_FIELDS: readonly SpecListField[] = ['progress.blocked', 'progress.open', 'progress.done'];
	const progressFields = $derived(
		detail.spec ? [...PROGRESS_FIELDS].sort((a, b) => Number(specLines(detail.spec!, a).length === 0) - Number(specLines(detail.spec!, b).length === 0)) : []
	);

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
<section class="plan-spec" aria-label={t.plan.spec.title} bind:this={sectionEl}>
	{#if detail.spec && focusTicket}
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
	<!--
		A page, not a strip: the goal and the contract (done-when, rules, how it is split, what you
		asked) read down the main column; where it stands, what the job is and its versions sit beside
		it. Narrow, the two make one column, the overview right under the goal.
	-->
	<div class="plan-spec-grid">
		<div class="plan-spec-col is-main">
		{#if detail.spec}
			{@const spec = detail.spec}
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

			{#if needsYou}
				<!-- What needs you: drawn only when something does, so its colour means something. -->
				<section
					class="plan-spec-attention"
					class:is-warn={failing.length === 0 && spec.progress.blocked.length === 0}
					aria-label={t.plan.spec.attention}
				>
					<h4 class="plan-spec-attention-title">
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
							<line x1="12" y1="9" x2="12" y2="13"></line>
							<line x1="12" y1="17" x2="12.01" y2="17"></line>
						</svg>
						<span>{t.plan.spec.attention}</span>
					</h4>
					<ul class="plan-spec-attention-list">
						{#each failing.slice(0, ATTENTION_CHECKS) as check (check.id)}
							{@const owner = check.ticket_id ? (ticketsById.get(check.ticket_id) ?? null) : null}
							{@const badge = badgeOf(check)}
							{@const why = firstReason(check.last_run?.detail)}
							<li class="plan-spec-attention-item is-fail">
								<span class="plan-spec-attention-tag">{badge === 'fail' ? t.plan.spec.attentionFail : `${t.plan.checks.title} · ${t.plan.checks.status[badge]}`}</span>
								{#if owner && onShowTicket}
									<button
										type="button"
										class="plan-spec-attention-subject"
										title={t.plan.links.showTicket(`${ticketTag(owner.seq)} ${owner.title}`)}
										onclick={() => onShowTicket(owner.id)}
									><span class="plan-spec-ticket-ref mono">{ticketTag(owner.seq)}</span><span class="plan-spec-attention-name">{owner.title}</span></button>
								{:else if owner}
									<span class="plan-spec-attention-subject"><span class="plan-spec-ticket-ref mono">{ticketTag(owner.seq)}</span><span class="plan-spec-attention-name">{owner.title}</span></span>
								{:else}
									<span class="plan-spec-attention-subject"><span class="plan-spec-attention-name">{check.item}</span></span>
								{/if}
								{#if why}<span class="plan-spec-attention-why" title={check.last_run?.detail}>{why}</span>{/if}
							</li>
						{/each}
						{#if failing.length > ATTENTION_CHECKS}
							<li class="plan-spec-attention-item is-more">{t.plan.spec.attentionMore(failing.length - ATTENTION_CHECKS)}</li>
						{/if}
						{#each spec.progress.blocked as line}
							<li class="plan-spec-attention-item is-blocked">
								<span class="plan-spec-attention-tag">{t.plan.spec.blocked}</span>
								<span class="plan-spec-attention-text">{line}</span>
							</li>
						{/each}
						{#if waitingRequirements > 0}
							<li class="plan-spec-attention-item is-waiting">
								<span class="plan-spec-attention-tag">{t.plan.requirements.proposed}</span>
								<button type="button" class="plan-spec-attention-subject" onclick={showWaitingRequirements}>
									<span class="plan-spec-attention-name">{t.plan.spec.attentionWaiting(waitingRequirements)}</span>
								</button>
							</li>
						{/if}
					</ul>
				</section>
			{/if}
		{/if}

		<div class="plan-spec-body plan-spec-main">
			{#if !detail.spec}
				<div class="plan-spec-empty-card">
					<p class="plan-spec-empty">{t.plan.noSpec}</p>
					{#if detail.brief}
						<p class="plan-spec-brief"><strong>{t.plan.brief}：</strong>{detail.brief}</p>
					{/if}
				</div>
			{:else}
				{@const spec = detail.spec}
				<!-- Section: Guidelines (Acceptance, Rules, Process) -->
				<div class="plan-spec-section is-guidelines">
					{#each GUIDELINE_FIELDS as field (field)}
						{@const lines = specLines(spec, field)}
						{@const count = lines.length}
						{@const unwritten = count === 0 && editing !== field}
						<!-- Nothing written and nothing under it: the head alone, its 「无」 in it. -->
						{@const bare = unwritten && !(field === 'acceptance' && (checks.length > 0 || addingCheck || runError))}
						<div class="plan-spec-list is-{field}" class:is-bare={bare}>
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
									{:else if unwritten}
										<span class="plan-spec-empty-line">{t.plan.empty}</span>
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
								{/if}

								{#if field === 'acceptance' && heldToSample.length > 0}
									<div class="plan-spec-checks-orphans is-sample">
										<span class="plan-spec-checks-orphans-title">{t.plan.checks.sampleTitle}</span>
										<ul class="plan-spec-ul">
											{#each heldToSample as group (group.item)}<li>{group.item}<span class="plan-spec-checks-pills is-block">{#each group.checks as check (check.id)}{@render checkItem(check)}{/each}</span></li>{/each}
										</ul>
									</div>
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


				<!-- What you asked for: the requirements ledger, the list the Bots read too (ADR 0040 P3). -->
				{#if detail.requirements}
					<PlanRequirements {api} {detail} {t} {onSaved} {onJump} selectedTicket={focusTicket?.id ?? null} {onShowTicket} />
				{/if}
			{/if}
		</div>

		</div>

		<div class="plan-spec-col is-side plan-spec-side">
			{#if detail.spec}
				{@const spec = detail.spec}
				<!-- Where it stands, as one card: the tickets and checks counted, then the written progress. -->
				<div class="plan-spec-overview-slot">
					<PlanSpecOverview {t} {ticketStates} checks={checksTotal} {onShowTickets}>
						<div class="plan-spec-section is-progress">
							{#each progressFields as field (field)}
								{@const isBlocked = field === 'progress.blocked'}
								{@const isDone = field === 'progress.done'}
								{@const lines = specLines(spec, field)}
								{@const folded = isDone && !doneShown && editing !== field && lines.length > 0}
								<div
									class="plan-spec-list is-{field.replace('.', '-')}"
									class:is-alert={isBlocked && lines.length > 0}
									class:is-bare={lines.length === 0 && editing !== field}
									class:is-folded={folded}
								>
									<div class="plan-spec-list-head">
										{#snippet head()}
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
											{:else if editing !== field}
												<span class="plan-spec-empty-line">{t.plan.empty}</span>
											{/if}
										{/snippet}
										{#if isDone && lines.length > 0 && editing !== field}
											<!-- What is done is folded while anything is still open; its head, count and all, opens it. -->
											<button
												type="button"
												class="plan-spec-list-meta plan-spec-fold-btn"
												aria-expanded={doneShown}
												title={doneShown ? t.plan.spec.collapse : t.plan.spec.expand}
												onclick={() => (doneOpen = !doneShown)}
											>
												{@render head()}
												<svg class="plan-spec-fold-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
													<polyline points="6 9 12 15 18 9"></polyline>
												</svg>
											</button>
										{:else}
											<div class="plan-spec-list-meta">{@render head()}</div>
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

									{#if editing === field}
										<textarea class="plan-spec-textarea" bind:value={draft} placeholder={t.plan.linesHint} disabled={saving}></textarea>
										<div class="plan-spec-edit-actions">
											<button type="button" class="plan-spec-save-btn" onclick={save} disabled={saving}>{t.plan.save}</button>
											<button type="button" class="plan-spec-cancel-btn" onclick={cancelEdit} disabled={saving}>{t.plan.cancel}</button>
										</div>
										{#if saveError}<p class="plan-spec-error">{saveError}</p>{/if}
									{:else if lines.length > 0 && !folded}
										<ul class="plan-spec-ul">
											{#each lines as line}<li>{line}</li>{/each}
										</ul>
									{/if}
								</div>
							{/each}
						</div>
					</PlanSpecOverview>
				</div>
			{/if}

			<!-- What the job is: its name, kind and scale, and the versions of this spec. -->
			<div class="plan-spec-about">
				<h4 class="plan-spec-about-title">{t.trace.title}</h4>
				{@render nameBlock()}
				{#if detail.kind}
					<div class="plan-spec-about-row">
						<span class="plan-spec-about-label">{t.plan.kind}</span>
						<span class="plan-spec-kind-badge">{detail.kind}</span>
					</div>
				{/if}
				<div class="plan-spec-foot">
					<div class="plan-spec-foot-meta">
						<span class="plan-spec-about-label">{t.plan.spec.version}</span>
						<span class="plan-spec-rev-badge">{t.plan.revision(detail.revision)}</span>
						<span class="plan-spec-actor">{actorLabel(detail.revision_actor, detail.revision_cause)}</span>
						{#if detail.spec_updated_at}
							<span class="plan-spec-dot" aria-hidden="true">·</span>
							<span class="plan-spec-time" title={formatFullTimestamp(detail.spec_updated_at)}>{formatMessageTime(detail.spec_updated_at)}</span>
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
			</div>

			{@render retrospectives()}
		</div>
	</div>
</section>
{/if}

<style>
	/* Flat, like the ticket list it takes turns with: the side panel or the tab is its frame. */
	.plan-spec {
		container: spec / inline-size;
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-width: 0;
		max-width: 1240px;
		margin: 0 auto;
		padding: 16px 18px 28px;
		font: 13px/1.55 var(--font);
		color: var(--ink-secondary);
	}

	/*
	 * One column on a narrow pane: the goal, where it stands, the contract, then the rest. The two
	 * columns give their parts up to it and the parts are put in that order. With room for both,
	 * the goal and the contract read down a main column, and where it stands, what the job is and
	 * its versions go down a side column; each column runs on by itself, not row by row.
	 */
	.plan-spec-grid {
		display: flex;
		flex-direction: column;
		gap: 14px;
		min-width: 0;
	}

	.plan-spec-col {
		display: contents;
	}

	/* Everything else, a child component's card included, comes after the contract. */
	.plan-spec-col > :global(*) {
		order: 5;
	}

	.plan-spec-col > .plan-spec-goal {
		order: 1;
	}

	.plan-spec-col > .plan-spec-attention {
		order: 2;
	}

	.plan-spec-col > .plan-spec-overview-slot {
		order: 3;
	}

	.plan-spec-col > .plan-spec-main {
		order: 4;
	}

	@container spec (min-width: 880px) {
		.plan-spec-grid {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
			column-gap: 20px;
			align-items: start;
		}

		.plan-spec-col {
			display: flex;
			flex-direction: column;
			gap: 14px;
			min-width: 0;
		}
	}

	.plan-spec-overview-slot {
		display: flex;
		min-width: 0;
	}

	.plan-spec-overview-slot > :global(.plan-overview) {
		flex: 1;
	}

	.plan-spec-main {
		min-width: 0;
	}

	/* What the job is: its name, its kind, its scale and the versions of the spec, as one card. */
	.plan-spec-about {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
	}

	.plan-spec-about-title {
		margin: 0;
		font-size: 12px;
		font-weight: 700;
		color: var(--ink);
	}

	.plan-spec-about-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.plan-spec-about-label {
		flex: none;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
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
		gap: 10px;
		padding: 14px 16px;
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
		font-size: 16px;
		font-weight: 600;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	/* What needs you: the one loud block on the page, and only there when something does. */
	.plan-spec-attention {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		padding: 9px 12px 10px;
		border: 1px solid var(--danger-line);
		border-left-width: 3px;
		border-radius: var(--radius-md);
		background: var(--danger-bg);
	}

	.plan-spec-attention-title {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		margin: 0;
		font-size: 12px;
		font-weight: 700;
		color: var(--danger-text);
	}

	.plan-spec-attention-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.plan-spec-attention-item {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--ink);
	}

	.plan-spec-attention-tag {
		flex: none;
		padding: 0 6px;
		border-radius: var(--radius-xs);
		background: var(--danger-text);
		color: var(--pane);
		font-size: 11px;
		font-weight: 700;
		line-height: 18px;
	}

	/* Only your word is waited on, nothing failed: amber, not red. */
	.plan-spec-attention.is-warn {
		border-color: var(--warn-line);
		background: var(--warn-bg);
	}

	.plan-spec-attention.is-warn .plan-spec-attention-title {
		color: var(--warn-text);
	}

	.plan-spec-attention-item.is-waiting .plan-spec-attention-tag {
		background: var(--warn-text);
	}

	.plan-spec-attention-subject {
		display: inline-flex;
		align-items: baseline;
		gap: 5px;
		flex: 0 1 auto;
		min-width: 0;
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		font-weight: 600;
		color: var(--ink);
		text-align: left;
	}

	button.plan-spec-attention-subject {
		cursor: pointer;
	}

	button.plan-spec-attention-subject:hover .plan-spec-attention-name {
		text-decoration: underline;
	}

	.plan-spec-attention-subject .plan-spec-ticket-ref {
		align-self: center;
	}

	.plan-spec-attention-name,
	.plan-spec-attention-why {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.plan-spec-attention-why {
		flex: 1 1 0;
		color: var(--ink-secondary);
	}

	.plan-spec-attention-text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.plan-spec-attention-item.is-more {
		padding-left: 2px;
		font-size: 11px;
		color: var(--danger-text);
	}

	/* Sections Grids */
	.plan-spec-section {
		display: grid;
		gap: 10px;
	}

	.plan-spec-section.is-guidelines {
		grid-template-columns: minmax(0, 1fr);
	}

	/* Inside the overview card: sections divided by a rule, not cards of their own. */
	.plan-spec-section.is-progress {
		gap: 0;
		margin-top: 2px;
	}

	.plan-spec-section.is-progress .plan-spec-list {
		padding: 8px 0;
		border: none;
		border-top: 1px solid var(--line-subtle);
		border-radius: 0;
		background: none;
		box-shadow: none;
	}

	.plan-spec-section.is-progress .plan-spec-list:last-child {
		padding-bottom: 0;
	}

	.plan-spec-section.is-progress .plan-spec-list.is-alert {
		margin-block: 2px;
		padding: 8px 9px;
		border: 1px solid var(--danger-line);
		border-radius: var(--radius-sm);
		background: var(--danger-bg);
	}

	.plan-spec-section.is-progress .plan-spec-list.is-alert + .plan-spec-list {
		border-top-color: transparent;
	}

	/* Nothing written: the head alone, quiet, its 「无」 beside the label. */
	.plan-spec-section.is-guidelines .plan-spec-list.is-bare {
		padding-block: 6px;
		border-style: dashed;
		background: none;
		box-shadow: none;
	}

	.plan-spec-section.is-progress .plan-spec-list.is-bare {
		padding-block: 5px;
	}

	.plan-spec-list.is-bare .plan-spec-list-head,
	.plan-spec-list.is-folded .plan-spec-list-head {
		margin-bottom: 0;
	}

	.plan-spec-list.is-bare .plan-spec-list-label,
	.plan-spec-list.is-bare .plan-spec-field-icon,
	.plan-spec-list.is-bare .plan-spec-status-dot {
		opacity: 0.7;
	}

	.plan-spec-list-meta .plan-spec-empty-line {
		font-size: 11px;
	}

	.plan-spec-fold-btn {
		border: none;
		background: none;
		padding: 2px 4px;
		margin: -2px -4px;
		border-radius: var(--radius-sm);
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.plan-spec-fold-btn:hover {
		background: var(--line-subtle);
	}

	.plan-spec-fold-chevron {
		flex: none;
		color: var(--muted);
		transform: rotate(-90deg);
		transition: transform 0.15s ease;
	}

	.plan-spec-fold-btn[aria-expanded='true'] .plan-spec-fold-chevron {
		transform: none;
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

	/* Many checks under one line: their own row under it, not trailing after the words. */
	.plan-spec-checks-pills.is-block {
		display: flex;
		margin: 5px 0 0;
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

	.plan-spec-checks-orphans {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px dashed var(--line);
	}

	/* No lines above it: nothing to set it apart from. */
	.plan-spec-list-head + .plan-spec-checks-orphans {
		margin-top: 0;
		padding-top: 0;
		border-top: none;
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

	/* The version row: which version, who made it and when, and its history a press away. */
	.plan-spec-foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding-top: 10px;
		border-top: 1px solid var(--line-subtle);
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
		.plan-spec-section.is-guidelines {
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
