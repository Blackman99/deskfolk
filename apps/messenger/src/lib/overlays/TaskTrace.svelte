<script lang="ts">
	import { USER_MEMBER, type Bot, type SessionSummary, type SessionTaskSummary, type TaskTrace, type TaskTraceNode } from '@real-bot/protocol';
	import { onMount, untrack } from 'svelte';
	import { pageSlide } from '../mobile-page-slide.ts';
	import type { Copy } from '../copy.ts';
	import type { MessengerApi } from '../messenger-api.ts';
	import { classifySession, youBotPeer } from '../sidebar/session-groups.ts';
	import { sessionTitle } from '../sidebar/session-title.ts';
	import TraceOutput from './TraceOutput.svelte';
	import { filterTrace, traceFileName, traceFlow, wokenByName } from './task-trace.ts';
	import {
		clampTraceWindow,
		loadTraceWindow,
		saveTraceWindow,
		type TraceWindowFrame
	} from './trace-window.ts';

	interface Props {
		api: MessengerApi | null;
		/** The job to open on. Null asks the session for its most recent one. */
		taskId: string | null;
		sessionId: string;
		/** The conversation on screen, so the node that lives there reads as the one you are on. */
		activeSessionId: string;
		sessions: readonly SessionSummary[];
		bots: readonly Bot[];
		youLabel: string;
		deletedLabel: string;
		workspacePath: string | null;
		t: Copy;
		reloadToken: number;
		onClose: () => void;
		onJump: (sessionId: string, messageId: string) => void;
		/** The job actually on screen, so the address follows the switcher. */
		onTask?: (taskId: string) => void;
	}

	let {
		api,
		taskId,
		sessionId,
		activeSessionId,
		sessions,
		bots,
		youLabel,
		deletedLabel,
		workspacePath,
		t,
		reloadToken,
		onClose,
		onJump,
		onTask
	}: Props = $props();

	let jobs = $state<SessionTaskSummary[]>([]);
	let trace = $state<TaskTrace | null>(null);
	let currentId = $state<string | null>(null);
	let loading = $state(true);
	let failed = $state(false);
	let notableOnly = $state(false);
	/** A file opened inside this board. The preview stays here; it never opens the chat's pane. */
	let openFile = $state<{ path: string; messageId: string; attachmentId: string } | null>(null);
	let loadSeq = 0;
	const PHONE = '(max-width: 680px)';
	/** A phone is its own page: no frame, no drag, no resize. */
	let phone = $state(typeof window !== 'undefined' && window.matchMedia(PHONE).matches);
	/** Where the desktop window sits. Null keeps the corner default. */
	let frame = $state<TraceWindowFrame | null>(phone ? null : loadTraceWindow());
	let paneEl = $state<HTMLElement | null>(null);
	/** The press a move or resize is measured from. Held outside state so writing it cannot restart it. */
	let gesture: { kind: 'move' | 'resize'; x: number; y: number; frame: TraceWindowFrame } | null = null;

	const shown = $derived(trace ? filterTrace(trace, notableOnly) : null);
	const flow = $derived(shown ? traceFlow(shown) : null);
	const byId = $derived(new Map((shown?.nodes ?? []).map((node) => [node.turn_id, node])));
	const botsById = $derived(new Map(bots.map((bot) => [bot.id, bot])));
	const sessionsById = $derived(new Map(sessions.map((session) => [session.id, session])));

	function nameOf(actor: string): string {
		if (actor === USER_MEMBER) return youLabel;
		return botsById.get(actor)?.name ?? deletedLabel;
	}

	function placeOf(node: TaskTraceNode): string {
		const session = sessionsById.get(node.session_id);
		if (!session) return t.trace.sessionUnknown;
		if (session.kind === 'group') return t.trace.sessionGroup(session.name ?? session.id);
		const kind = classifySession(session);
		if (kind === 'you-bot') {
			const peer = youBotPeer(session);
			return t.trace.sessionDirect(peer ? nameOf(peer) : deletedLabel);
		}
		return t.trace.sessionDirect(sessionTitle(session, botsById, { deleted: deletedLabel, archived: deletedLabel }));
	}

	async function load(id: string | null): Promise<void> {
		const seq = ++loadSeq;
		if (!api) {
			loading = false;
			failed = true;
			return;
		}
		loading = true;
		failed = false;
		try {
			const listed = await api.sessionTasks(sessionId);
			if (seq !== loadSeq) return;
			jobs = listed;
			const next = id && listed.some((job) => job.id === id) ? id : (listed[0]?.id ?? null);
			// A refresh of the same job keeps the file you have open; switching jobs does not.
			if (next !== currentId) openFile = null;
			currentId = next;
			if (next) onTask?.(next);
			trace = next ? await api.taskTrace(next) : null;
			if (seq !== loadSeq) return;
			if (next && !trace) failed = true;
		} catch {
			if (seq !== loadSeq) return;
			failed = true;
		} finally {
			if (seq === loadSeq) loading = false;
		}
	}

	function selectJob(id: string): void {
		if (id === currentId) return;
		void load(id);
	}

	onMount(() => {
		void load(taskId);
		const query = window.matchMedia(PHONE);
		const apply = () => {
			phone = query.matches;
		};
		apply();
		query.addEventListener('change', apply);
		if (!query.matches) {
			const remembered = loadTraceWindow();
			if (remembered) frame = remembered;
		}
		// The first Escape puts the file away; the board itself stays up for the next one.
		function onKey(event: KeyboardEvent): void {
			if (event.key !== 'Escape' || !openFile) return;
			event.preventDefault();
			event.stopPropagation();
			openFile = null;
		}
		window.addEventListener('keydown', onKey, true);
		return () => {
			query.removeEventListener('change', apply);
			window.removeEventListener('keydown', onKey, true);
		};
	});

	$effect(() => {
		void reloadToken;
		if (reloadToken === 0) return;
		void load(currentId ?? taskId);
	});

	/** A different conversation shows that conversation's job. */
	let loadedFor = sessionId;
	$effect(() => {
		const next = sessionId;
		if (next === loadedFor) return;
		loadedFor = next;
		untrack(() => void load(null));
	});

	function openCard(node: TaskTraceNode): void {
		const messageId = node.approval?.message_id ?? node.ask?.message_id ?? node.focus_message_id;
		onJump(node.session_id, messageId);
	}

	function currentFrame(): TraceWindowFrame {
		const pane = paneEl;
		const box = pane?.getBoundingClientRect();
		return frame ?? {
			x: box?.left ?? 0,
			y: box?.top ?? 0,
			width: box?.width ?? 440,
			height: box?.height ?? 640
		};
	}

	function track(event: PointerEvent, kind: 'move' | 'resize'): void {
		event.preventDefault();
		event.stopPropagation();
		const from = currentFrame();
		gesture = { kind, x: event.clientX, y: event.clientY, frame: from };
		function move(next: PointerEvent): void {
			const held = gesture;
			if (!held) return;
			const dx = next.clientX - held.x;
			const dy = next.clientY - held.y;
			frame = clampTraceWindow(
				held.kind === 'move'
					? { ...held.frame, x: held.frame.x + dx, y: held.frame.y + dy }
					: { ...held.frame, width: held.frame.width + dx, height: held.frame.height + dy }
			);
		}
		function stop(): void {
			gesture = null;
			if (frame) saveTraceWindow(frame);
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', stop);
		}
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', stop);
	}

	function startDrag(event: PointerEvent): void {
		if (phone || event.button !== 0) return;
		if ((event.target as HTMLElement | null)?.closest('button, a, input, label')) return;
		if (!paneEl) return;
		track(event, 'move');
	}

	function startResize(event: PointerEvent): void {
		if (phone || event.button !== 0) return;
		if (!paneEl) return;
		track(event, 'resize');
	}

	/** The turn a file hangs off, so the output names who handed it over. */
	function ownerOf(attachmentId: string): TaskTraceNode | null {
		for (const node of shown?.nodes ?? []) {
			if (node.artifacts.some((file) => file.attachment_id === attachmentId)) return node;
		}
		return null;
	}

	function showFile(file: { path: string; messageId: string; attachmentId: string }): void {
		openFile = openFile?.attachmentId === file.attachmentId ? null : file;
	}

	function showPath(next: string): void {
		const known = (shown?.nodes ?? [])
			.flatMap((node) => node.artifacts)
			.find((file) => file.path === next);
		openFile = known
			? { path: known.path, messageId: known.message_id, attachmentId: known.attachment_id }
			: { path: next, messageId: '', attachmentId: next };
	}
</script>

{#snippet card(node: TaskTraceNode)}
	{@const from = flow?.showEdges ? null : wokenByName(node, byId, nameOf)}
	<article class="trace-card is-{node.status}" class:is-here={node.session_id === activeSessionId}>
		<button type="button" class="trace-card-main" onclick={() => openCard(node)} title={t.trace.jump}>
			<span class="trace-card-line">
				<span class="trace-card-who">{nameOf(node.actor)}</span>
				<span class="trace-status is-{node.status}">{t.trace.status[node.status]}</span>
			</span>
			{#if from}
				<span class="trace-woken">{t.trace.wokenBy(from)}</span>
			{/if}
			{#if node.summary}
				<span class="trace-summary">{node.summary}</span>
			{/if}
			{#if node.ask}
				<span class="trace-wait">{t.trace.waitingAsk} · {node.ask.question}</span>
			{/if}
			{#if node.approval}
				<span class="trace-wait">{t.trace.waitingApproval}{#if node.approval.summary} · {node.approval.summary}{/if}</span>
			{/if}
			{#if node.passed > 0}
				<span class="trace-passed">{t.trace.passed(node.passed)}</span>
			{/if}
			<span class="trace-place">{placeOf(node)}</span>
		</button>
		{#if node.artifacts.length > 0}
			<ul class="trace-files">
				{#each node.artifacts as file (file.attachment_id)}
					<li>
						<button
							type="button"
							class="trace-file"
							class:is-open={openFile?.attachmentId === file.attachment_id}
							aria-expanded={openFile?.attachmentId === file.attachment_id}
							onclick={() => showFile({ path: file.path, messageId: file.message_id, attachmentId: file.attachment_id })}
							title={file.path}
						>
							<span class="trace-file-name">{traceFileName(file.path)}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</article>
{/snippet}

{#snippet output()}
	{#if openFile}
		{@const owner = ownerOf(openFile.attachmentId)}
		<div class="trace-output-stop">
			<div class="trace-flow-link" aria-hidden="true"></div>
			<TraceOutput
				path={openFile.path}
				handedBy={owner ? nameOf(owner.actor) : ''}
				{api}
				{workspacePath}
				{t}
				onOpenPath={showPath}
				onClose={() => (openFile = null)}
			/>
		</div>
	{/if}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="trace-overlay"
	class:is-placed={!phone && frame !== null}
	class:is-page={phone}
	transition:pageSlide
	role="dialog"
	aria-modal={phone}
	aria-label={t.trace.title}
	tabindex="-1"
>
	<div
		class="trace-pane"
		bind:this={paneEl}
		style:left={!phone && frame ? `${frame.x}px` : undefined}
		style:top={!phone && frame ? `${frame.y}px` : undefined}
		style:width={!phone && frame ? `${frame.width}px` : undefined}
		style:height={!phone && frame ? `${frame.height}px` : undefined}
	>
		<header class="trace-header" onpointerdowncapture={phone ? undefined : startDrag}>
			<div class="trace-titles">
				<h2>{trace ? `${t.trace.title} · ${trace.title}` : t.trace.title}</h2>
				{#if trace}
					<span class="trace-meta">{trace.closed_at ? t.trace.closed : t.trace.open} · {trace.dir}</span>
				{/if}
			</div>
			<button type="button" class="sheet-close" title={t.common.close} onclick={onClose}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18"></line>
					<line x1="6" y1="6" x2="18" y2="18"></line>
				</svg>
			</button>
		</header>
		{#if !phone}
			<button
				type="button"
				class="trace-resize"
				aria-label={t.trace.resize}
				onpointerdowncapture={startResize}
			></button>
		{/if}

		{#if jobs.length > 1}
			<div class="trace-switcher" role="tablist">
				{#each jobs as job (job.id)}
					<button
						type="button"
						role="tab"
						class="trace-job"
						class:is-current={job.id === currentId}
						aria-selected={job.id === currentId}
						onclick={() => selectJob(job.id)}
					>
						{job.title || job.dir}
					</button>
				{/each}
			</div>
		{/if}

		{#if trace && trace.nodes.length > 0}
			<label class="trace-filter">
				<input type="checkbox" bind:checked={notableOnly} />
				<span>{t.trace.filter}</span>
			</label>
		{/if}

		<div class="trace-flow-scroll">
				{#if loading && !trace}
					<p class="trace-empty">{t.trace.loading}</p>
				{:else if failed}
					<p class="trace-empty">
						{t.trace.failed}
						<button type="button" onclick={() => void load(currentId ?? taskId)}>{t.trace.retry}</button>
					</p>
				{:else if !flow || flow.nodes.length === 0}
					<p class="trace-empty">{t.trace.none}</p>
				{:else}
					<div class="trace-flow">
						{#each flow.stages as stage, index (stage[0]?.turn_id)}
							{#if index > 0}
								<div class="trace-flow-link" aria-hidden="true"></div>
							{/if}
							<div class="trace-stage">
								{#each stage as node (node.turn_id)}
									{@render card(node)}
									{#if node.artifacts.some((file) => file.attachment_id === openFile?.attachmentId)}
										{@render output()}
									{/if}
								{/each}
							</div>
						{/each}
					</div>
				{/if}
		</div>
	</div>
</div>

<style>
	.trace-overlay {
		position: fixed;
		z-index: 70;
		right: 24px;
		bottom: 24px;
		display: flex;
		pointer-events: none;
	}

	.trace-overlay.is-placed {
		inset: 0;
		right: auto;
		bottom: auto;
	}

	.trace-pane {
		position: relative;
		pointer-events: auto;
		width: min(440px, calc(100vw - 48px));
		height: min(640px, calc(100vh - 96px));
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--pane);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
	}

	.trace-overlay.is-placed .trace-pane {
		position: fixed;
	}

	.trace-resize {
		position: absolute;
		right: 0;
		bottom: 0;
		width: 16px;
		height: 16px;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: nwse-resize;
		touch-action: none;
	}

	.trace-resize::after {
		content: "";
		position: absolute;
		right: 4px;
		bottom: 4px;
		width: 7px;
		height: 7px;
		border-right: 2px solid var(--muted-light);
		border-bottom: 2px solid var(--muted-light);
	}

	.trace-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 14px 10px;
		border-bottom: 1px solid var(--line);
		background: var(--sidebar-bg);
		cursor: grab;
		touch-action: none;
		user-select: none;
	}

	.trace-header:active {
		cursor: grabbing;
	}

	.trace-titles {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.trace-titles h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-meta {
		font-size: 11.5px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.trace-switcher {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		padding: 10px 16px 0;
	}

	.trace-job {
		flex: none;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		height: 26px;
		padding: 0 10px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink-secondary);
		font-size: 12px;
		cursor: pointer;
	}

	.trace-job.is-current {
		background: var(--accent-tint);
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.trace-filter {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 16px 0;
		font-size: 12px;
		color: var(--ink-secondary);
	}

	.trace-flow-scroll {
		flex: 1;
		min-width: 0;
		overflow: auto;
		padding: 16px 16px 24px;
	}

	.trace-flow {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
	}

	.trace-stage {
		flex: 0 0 auto;
		width: min(440px, 100%);
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.trace-output-stop {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
	}

	.trace-flow-link {
		flex: none;
		width: 2px;
		height: 18px;
		margin: 0 0 0 24px;
		background: var(--line-hover);
		position: relative;
	}

	.trace-flow-link::after {
		content: "";
		position: absolute;
		left: -3px;
		bottom: 0;
		border-left: 4px solid transparent;
		border-right: 4px solid transparent;
		border-top: 6px solid var(--line-hover);
	}

	.trace-empty {
		margin: 24px 0;
		font-size: 13px;
		color: var(--muted);
	}

	.trace-card {
		border: 1px solid var(--line);
		border-left: 3px solid var(--muted-light);
		border-radius: var(--radius-md);
		background: var(--pane);
		overflow: hidden;
	}

	.trace-card.is-running {
		border-color: var(--accent-border);
		border-left-color: var(--accent);
		background: var(--accent-tint);
	}

	.trace-card.is-waiting_approval {
		border-color: var(--warn-line);
		border-left-color: var(--warn);
		background: var(--warn-bg);
	}

	.trace-card.is-waiting_ask {
		border-color: var(--purple-line);
		border-left-color: var(--purple);
		background: var(--purple-bg);
	}

	.trace-card.is-completed {
		border-color: var(--ok-line);
		border-left-color: var(--ok);
		background: var(--ok-bg);
	}

	.trace-card.is-redirected {
		border-color: var(--line);
		border-left-color: var(--muted);
		background: var(--chip);
	}

	.trace-card.is-interrupted,
	.trace-card.is-stopped {
		border-color: var(--danger-line);
		border-left-color: var(--danger);
		background: var(--danger-bg);
	}

	.trace-card.is-here {
		box-shadow: inset 0 0 0 1px var(--accent);
	}

	.trace-card-main {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		width: 100%;
		padding: 9px 10px;
		border: 0;
		background: transparent;
		text-align: left;
		cursor: pointer;
		color: inherit;
	}

	.trace-card-main:hover {
		background: var(--line-subtle);
	}

	.trace-card-line {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
	}

	.trace-card-who {
		font-size: 12px;
		font-weight: 600;
		color: var(--ink);
	}

	.trace-status {
		margin-left: auto;
		font-size: 11px;
		color: var(--muted);
	}

	.trace-status.is-running { color: var(--accent); }
	.trace-status.is-waiting_approval { color: var(--warn-text); }
	.trace-status.is-waiting_ask { color: var(--purple); }
	.trace-status.is-completed { color: var(--ok-text); }
	.trace-status.is-redirected { color: var(--muted); }
	.trace-status.is-interrupted,
	.trace-status.is-stopped { color: var(--danger-text); }

	.trace-summary,
	.trace-wait,
	.trace-woken,
	.trace-passed,
	.trace-place {
		font-size: 12px;
		line-height: 1.45;
		color: var(--ink-secondary);
		overflow-wrap: anywhere;
	}

	.trace-place,
	.trace-woken,
	.trace-passed {
		font-size: 11px;
		color: var(--muted);
	}

	.trace-wait {
		color: var(--accent);
	}

	.trace-files {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 0;
		padding: 0 10px 9px;
	}

	.trace-file {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		height: 24px;
		padding: 0 8px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: var(--chip);
		color: var(--ink-secondary);
		font-size: 11.5px;
		cursor: pointer;
	}

	.trace-file:hover,
	.trace-file.is-open {
		border-color: var(--accent-border);
		color: var(--accent);
	}

	.trace-file.is-open {
		background: var(--accent-tint);
	}

	.trace-file-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 680px) {
		/* All four edges. Resetting right and bottom afterwards would shrink this back to the flow. */
		.trace-overlay,
		.trace-overlay.is-placed,
		.trace-overlay.is-page {
			top: 0;
			right: 0;
			bottom: 0;
			left: 0;
			width: 100%;
			height: 100%;
			pointer-events: auto;
		}

		.trace-pane {
			position: relative;
			left: 0;
			top: 0;
			width: 100%;
			height: 100%;
			max-width: none;
			border: 0;
			border-radius: 0;
			box-shadow: none;
		}

		.trace-header {
			cursor: default;
			touch-action: auto;
		}

		.trace-resize {
			display: none;
		}

		.trace-header {
			padding: calc(10px + env(safe-area-inset-top)) 12px 10px;
		}

		.trace-flow-scroll {
			padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
		}
	}
</style>
