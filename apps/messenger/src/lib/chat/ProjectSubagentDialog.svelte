<script lang="ts">
	import type { AgentRunTask, AgentTaskDetail } from '@real-bot/protocol';
	import Icon from '../Icon.svelte';
	import MarkdownBody from '../MarkdownBody.svelte';
	import { backdropClick } from '../click-outside.ts';
	import type { Copy } from '../copy.ts';
	import { pageSlide } from '../mobile-page-slide.ts';
	import { modalOut } from '../modal-motion.ts';
	import type { MessengerRuntime } from '../runtime.svelte.ts';
	import CommandActivity from './CommandActivity.svelte';
	import { formatLiveDuration } from './chat-view.ts';
	import { holdBack } from './message-text-pages.ts';
	import { runningCall, trailBlocks } from './project-tasks.ts';

	/**
	 * A project session's subagent, read in a popup over the conversation that sent it (ADR 0095,
	 * 25), as a Bot↔Bot direct is (`BotDmDialog`): what it was asked, what it said, its tool calls
	 * folded between, and where it is now while it runs. The Mac reads it from the subagent's own
	 * session file, so it is read again while it goes on and once more when it ends. It is yours to
	 * read, not to stop from here: Stop is in the composer.
	 */
	type Props = {
		runtime: MessengerRuntime;
		t: Copy;
		task: AgentRunTask;
		onClose: () => void;
		onOpenPath: (path: string) => void;
	};

	let { runtime, t, task, onClose, onOpenPath }: Props = $props();

	const POLL_MS = 1500;

	const backdrop = backdropClick();
	const id = $derived(task.id);
	const runId = $derived(task.run_id);
	const going = $derived(task.status === 'running');

	let root = $state<HTMLElement | null>(null);
	let detail = $state<AgentTaskDetail | null>(null);
	let failed = $state(false);
	let nowMs = $state(Date.now());

	$effect(() => {
		const api = runtime.client;
		const taskId = id;
		const run = runId;
		const again = going;
		let gone = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const read = async () => {
			if (!api) return;
			try {
				const next = await api.agentTaskDetail(run, taskId);
				if (gone) return;
				detail = next;
				failed = false;
			} catch {
				if (!gone) failed = true;
			}
			if (!gone && again) timer = setTimeout(() => void read(), POLL_MS);
		};
		void read();
		return () => {
			gone = true;
			if (timer) clearTimeout(timer);
		};
	});

	$effect(() => {
		if (!going) return;
		const timer = setInterval(() => (nowMs = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	// Over everything, where no pane's transform or clipping reaches it, as a sheet is.
	$effect(() => {
		const el = root;
		if (!el) return;
		if (typeof el.showPopover === 'function') el.showPopover();
		el.focus({ preventScroll: true });
		return () => {
			if (typeof el.hidePopover === 'function' && el.isConnected) el.hidePopover();
		};
	});

	// A phone's Back closes it first, rather than leaving the conversation under it.
	$effect(() => holdBack(onClose));

	const blocks = $derived(trailBlocks(detail?.steps ?? []));
	const onCall = $derived(detail ? runningCall(detail.steps) : null);
	const facts = $derived(
		[
			task.agent_type,
			detail?.model,
			task.tool_uses ? t.project.taskCalls(task.tool_uses) : null,
			task.tokens ? t.project.taskTokens(task.tokens) : null,
			task.status === 'running' ? null : t.project.taskStatus[task.status]
		].filter((fact): fact is string => Boolean(fact))
	);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
	bind:this={root}
	class="modal-backdrop page-on-phone subagent-backdrop"
	popover="manual"
	in:pageSlide
	out:modalOut
	role="dialog"
	aria-modal="true"
	aria-labelledby="subagent-title"
	tabindex="-1"
	data-subagent-dialog={task.id}
	onmousedowncapture={backdrop.press}
	onclick={(event) => {
		if (backdrop.isOutside(event)) onClose();
	}}
	onkeydown={(event) => {
		if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
		event.stopPropagation();
		onClose();
	}}
>
	<div class="modal-dialog subagent-dialog">
		<div class="modal-head">
			<button type="button" class="modal-back" aria-label={t.common.back} title={t.common.back} onclick={onClose}>
				<Icon name="chevron-left" />
			</button>
			<Icon name="bot" size={20} />
			<div class="modal-head-titles">
				<h2 id="subagent-title">{task.description || t.project.taskDoing.subagent}</h2>
				{#if facts.length > 0}<span class="subagent-facts">{facts.join(' · ')}</span>{/if}
			</div>
			<button type="button" class="modal-close" title={t.common.close} onclick={onClose}>✕</button>
		</div>
		<div class="subagent-body">
			{#if failed && detail === null}
				<p class="subagent-note">{t.project.taskReadFailed}</p>
			{:else if detail === null}
				<p class="subagent-note" role="status">{t.project.taskLoading}</p>
			{:else}
				{#if detail.prompt}
					<div class="subagent-asked" data-subagent-prompt>{detail.prompt}</div>
				{/if}
				{#each blocks as block (block.key)}
					{#if block.kind === 'say'}
						<div class="subagent-say">
							<MarkdownBody source={block.text} copyLabel={t.chat.copyCode} copiedLabel={t.chat.copied} onOpenArtifact={onOpenPath} />
						</div>
					{:else}
						<CommandActivity rows={block.rows} {t} countLabel={t.project.taskCalls} />
					{/if}
				{/each}
				{#if blocks.length === 0 && !going}
					<p class="subagent-note">{t.project.taskStepsGone}</p>
				{/if}
				{#if going}
					<div class="subagent-foot" role="status">
						<span class="subagent-pulse" aria-hidden="true"></span>
						<span class="subagent-step" title={onCall ?? task.activity ?? ''}>{onCall ?? task.activity ?? (blocks.length === 0 ? t.project.taskNoSteps : t.sidebar.statusRunning)}</span>
						<span class="subagent-time">
							<Icon name="clock" size={12} />
							{formatLiveDuration(task.started_at, nowMs, t.chat.spanPart)}
						</span>
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	/* The popover's own box gives way to the backdrop's. */
	.subagent-backdrop[popover] {
		width: auto;
		height: auto;
		max-width: none;
		max-height: none;
		margin: 0;
		border: 0;
		overflow: visible;
		color: inherit;
	}

	.subagent-dialog {
		display: flex;
		flex-direction: column;
		/* Follows the window, from a Bot↔Bot direct's width up to where a line is still readable. */
		width: clamp(900px, 72vw, 1280px);
		max-width: 92vw;
		height: min(92dvh, calc(100dvh - 48px));
		min-height: 0;
		overflow: hidden;
	}

	.subagent-dialog :global(.modal-head) {
		gap: 10px;
		justify-content: flex-start;
	}

	.subagent-dialog :global(.modal-head-titles) {
		flex: 1 1 auto;
		min-width: 0;
	}

	.subagent-dialog :global(.modal-head h2) {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.subagent-facts {
		display: block;
		overflow: hidden;
		font-size: 12px;
		line-height: 1.3;
		color: var(--muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* A transcript read top to bottom, as a Bot↔Bot direct's. */
	.subagent-body {
		flex: 1 1 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
		min-height: 0;
		padding: 16px 20px 24px;
		overflow-y: auto;
		font-size: 14px;
	}

	/* What it was asked sits where a line you send does: it was sent this. All of it, flat. */
	.subagent-asked {
		align-self: flex-end;
		box-sizing: border-box;
		max-width: 85%;
		padding: 10px 14px;
		border-radius: var(--radius-lg) var(--radius-xs) var(--radius-lg) var(--radius-lg);
		background: var(--chip);
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.subagent-say {
		min-width: 0;
	}

	.subagent-body :global(.command-activity) {
		align-self: stretch;
		margin-top: 0;
	}

	.subagent-note {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
	}

	/* Where it is and for how long, as a working bubble's last line says. */
	.subagent-foot {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		color: var(--accent);
		font-size: 12px;
		font-weight: 500;
	}

	.subagent-pulse {
		flex-shrink: 0;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		animation: pulse 1.2s ease-in-out infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		.subagent-pulse {
			animation: none;
		}
	}

	.subagent-step {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.subagent-time {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 6px;
		margin-left: auto;
		padding-left: 8px;
		font-weight: 400;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
</style>
