<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { formatDuration, type CommandRow } from './command-activity.ts';
	import { commandLine, splitProgram } from './command-line.ts';
	import { commandOutput } from './command-output.ts';

	interface Props {
		rows: CommandRow[];
		t: Copy;
	}

	let { rows, t }: Props = $props();

	/**
	 * What a turn has run so far: the finished commands. The one running now is the bubble's last
	 * line, and opening that line shows what it prints; it joins this list when it ends.
	 */
	const done = $derived(rows.filter((row) => !row.running));

	/**
	 * Folded to one line until you open it: this sits inside a chat bubble, not in a log viewer, and
	 * a long turn's dozens of commands pushed the reply itself off screen.
	 */
	let expanded = $state(false);

	/**
	 * One command's output open at a time, and only when you ask for it. A command that printed
	 * nothing has nothing to open: its row is a plain line.
	 */
	let opened = $state<string | null>(null);

	const failed = $derived(done.filter(isFailed).length);

	function isFailed(row: CommandRow): boolean {
		return row.exitCode !== null && row.exitCode !== 0;
	}

	function toggle(id: string): void {
		opened = opened === id ? null : id;
	}

	/** An output you open is brought into view, in the list and the conversation, not left cut off at the card's foot. */
	function reveal(node: HTMLElement) {
		node.scrollIntoView?.({ block: 'nearest' });
	}

	/** The list follows new commands the way a terminal does, unless you have scrolled up to read. */
	function follow(node: HTMLElement, _count: number) {
		let atEnd = true;
		const onScroll = () => {
			atEnd = node.scrollHeight - node.scrollTop - node.clientHeight < 8;
		};
		node.addEventListener('scroll', onScroll, { passive: true });
		node.scrollTop = node.scrollHeight;
		return {
			update() {
				if (atEnd) node.scrollTop = node.scrollHeight;
			},
			destroy() {
				node.removeEventListener('scroll', onScroll);
			}
		};
	}
</script>

{#snippet chevron(cls: string)}
	<svg class={cls} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4l4 4-4 4"></path></svg>
{/snippet}

{#snippet line(row: CommandRow, openable: boolean)}
	{@const parts = splitProgram(commandLine(row.command ?? row.name))}
	<span class="command-mark" aria-hidden="true">
		{#if isFailed(row)}<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"></path></svg>{:else}<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3L13 4.5"></path></svg>{/if}
	</span>
	<span class="command-text mono"><span class="command-program">{parts.program}</span>{parts.rest}</span>
	<span class="command-meta mono">
		{#if isFailed(row)}<span class="command-exit">{t.chat.activity.exit(row.exitCode ?? 0)}</span>{/if}
		{#if row.durationMs !== null}<span>{formatDuration(row.durationMs)}</span>{/if}
	</span>
	{#if openable}
		{@render chevron('command-chevron')}
	{:else}
		<span class="command-chevron" aria-hidden="true"></span>
	{/if}
{/snippet}

{#if done.length}
	<div class="command-activity" class:is-open={expanded} aria-label={t.chat.commandActivity}>
		<!-- A line of text that opens, the same folded or open: only the list under it is a card. -->
		<button type="button" class="command-summary" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
			<svg class="command-summary-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25"></rect><path d="M4.75 6.25l2 1.75-2 1.75M8.5 10h2.75"></path></svg>
			<span class="command-count">{t.chat.commandCount(done.length)}</span>
			{#if failed > 0}
				<span class="command-failed">· {t.chat.commandsFailed(failed)}</span>
			{/if}
			{@render chevron('command-summary-chevron')}
		</button>
		{#if expanded}
			<div class="command-card">
				<ol class="command-rows" use:follow={done.length}>
					{#each done as row (row.id)}
						{@const openable = Boolean(row.text)}
						<li class="command-row" class:is-failed={isFailed(row)} class:is-open={openable && opened === row.id}>
							{#if openable}
								<button type="button" class="command-line" aria-expanded={opened === row.id} title={row.command ?? row.name} onclick={() => toggle(row.id)}>
									{@render line(row, true)}
								</button>
							{:else}
								<div class="command-line" title={row.command ?? row.name}>
									{@render line(row, false)}
								</div>
							{/if}
							{#if openable && opened === row.id}
								<pre class="command-output code-out mono" use:commandOutput={{ text: row.text, command: row.command, live: false }} use:reveal></pre>
							{/if}
						</li>
					{/each}
				</ol>
			</div>
		{/if}
	</div>
{/if}

<style>
	.command-activity {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		margin-top: 8px;
	}

	/* Text, not a button: the same few words whether the list under it is open or not. */
	.command-summary {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		padding: 2px 0;
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		text-align: left;
		cursor: pointer;
		transition: color 0.15s ease;
	}

	.command-summary:hover,
	.command-activity.is-open .command-summary {
		color: var(--ink-secondary);
	}

	.command-summary:focus-visible {
		border-radius: var(--radius-xs);
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.command-summary-icon {
		flex-shrink: 0;
	}

	.command-count {
		font-weight: 500;
		white-space: nowrap;
	}

	.command-failed {
		flex-shrink: 0;
		color: var(--danger-text);
		white-space: nowrap;
	}

	:global(.command-summary-chevron) {
		flex-shrink: 0;
		opacity: 0.7;
		transition: transform 0.18s ease;
	}

	.is-open :global(.command-summary-chevron) {
		transform: rotate(90deg);
	}

	.command-card {
		align-self: stretch;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
		animation: command-card-in 0.16s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@keyframes command-card-in {
		from { opacity: 0; transform: translateY(-3px); }
		to { opacity: 1; transform: none; }
	}

	/* About a dozen rows, then it scrolls: a long turn's list stays a part of the bubble. */
	.command-rows {
		max-height: 372px;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}

	.command-row + .command-row {
		border-top: 1px solid var(--line-subtle);
	}

	.command-line {
		display: flex;
		align-items: center;
		gap: 8px;
		box-sizing: border-box;
		width: 100%;
		min-height: 30px;
		padding: 0 10px;
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 12px;
		text-align: left;
	}

	button.command-line {
		cursor: pointer;
		transition: background-color 0.15s ease;
	}

	button.command-line:hover,
	.command-row.is-open > .command-line {
		background: var(--row-hover);
	}

	.command-line:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.command-mark {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 14px;
		color: var(--ok);
	}

	.command-row.is-failed .command-mark {
		color: var(--danger);
	}

	.command-text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-program {
		color: var(--ink);
		font-weight: 600;
	}

	.command-meta {
		display: inline-flex;
		flex-shrink: 0;
		gap: 8px;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}

	.command-exit {
		color: var(--danger-text);
	}

	/* The same width with or without an arrow, so the times line up down the list. */
	:global(.command-chevron) {
		flex-shrink: 0;
		width: 12px;
		color: var(--muted);
		transition: transform 0.18s ease;
	}

	.command-row.is-open :global(.command-chevron) {
		transform: rotate(90deg);
	}

	/*
	 * Part of its row, not a box inside the card: the code ground runs edge to edge under a hairline,
	 * and its text starts where the command's does (10px + the 14px mark + the 8px gap).
	 */
	.command-output {
		max-height: 20em;
		margin: 0;
		padding: 10px 14px 12px 32px;
		overflow: auto;
		border-top: 1px solid var(--line-subtle);
		background: var(--chip);
		color: var(--ink);
		font-size: 11.5px;
		line-height: 1.6;
		tab-size: 4;
		white-space: pre-wrap;
		word-break: break-word;
		animation: command-card-in 0.16s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@media (max-width: 680px) {
		.command-output {
			padding-left: 14px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.command-card,
		.command-output {
			animation: none;
		}
	}
</style>
