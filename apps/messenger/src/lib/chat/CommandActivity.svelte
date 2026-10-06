<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { formatDuration, type CommandRow } from './command-activity.ts';
	import { commandLine, commandOutput, splitProgram } from './command-output.ts';

	interface Props {
		rows: CommandRow[];
		t: Copy;
	}

	let { rows, t }: Props = $props();

	/**
	 * Folded to one line until you open it: this sits inside a chat bubble, not in a log viewer, and
	 * a long turn's dozens of commands pushed the reply itself off screen. The one running now is
	 * named by the bubble's last line, right under this, so the folded line only counts.
	 */
	let expanded = $state(false);

	/**
	 * One command's output open at a time, and only when you ask for it, running or not. A command
	 * that printed nothing has nothing to open: its row is a plain line.
	 */
	let opened = $state<string | null>(null);

	const failed = $derived(rows.filter(isFailed).length);

	function isFailed(row: CommandRow): boolean {
		return !row.running && row.exitCode !== null && row.exitCode !== 0;
	}

	function toggle(id: string): void {
		opened = opened === id ? null : id;
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
		{#if row.running}<span class="command-pulse"></span>{:else if isFailed(row)}<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"></path></svg>{:else}<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3L13 4.5"></path></svg>{/if}
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

{#if rows.length}
	<div class="command-activity" class:is-open={expanded} aria-label={t.chat.commandActivity}>
		<button type="button" class="command-summary" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
			<svg class="command-summary-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25"></rect><path d="M4.75 6.25l2 1.75-2 1.75M8.5 10h2.75"></path></svg>
			<span class="command-count">{t.chat.commandCount(rows.length)}</span>
			{#if failed > 0}
				<span class="command-failed">{t.chat.commandsFailed(failed)}</span>
			{/if}
			{@render chevron('command-summary-chevron')}
		</button>
		{#if expanded}
			<ol class="command-rows" use:follow={rows.length}>
				{#each rows as row (row.id)}
					{@const openable = Boolean(row.text)}
					<li class="command-row" class:is-running={row.running} class:is-failed={isFailed(row)} class:is-open={openable && opened === row.id}>
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
							<pre class="command-output code-out mono" use:commandOutput={{ text: row.text, command: row.command, live: row.running }}></pre>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
	</div>
{/if}

<style>
	/*
	 * A card that opens from its own header: folded it is a small pill as wide as what it says,
	 * open it takes the bubble's width and lists the commands under the same header.
	 */
	.command-activity {
		display: inline-flex;
		flex-direction: column;
		align-self: flex-start;
		max-width: 100%;
		margin-top: 8px;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--pane);
		box-shadow: var(--shadow-xs);
	}

	.command-activity.is-open {
		display: flex;
		width: 100%;
	}

	.command-summary {
		display: flex;
		align-items: center;
		gap: 7px;
		min-height: 30px;
		padding: 0 10px 0 9px;
		border: 0;
		background: transparent;
		color: var(--ink-secondary);
		font-size: 12px;
		text-align: left;
		cursor: pointer;
		transition: background-color 0.15s ease, color 0.15s ease;
	}

	.command-summary:hover {
		background: var(--row-hover);
		color: var(--ink);
	}

	.command-summary:focus-visible,
	.command-line:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.command-summary-icon {
		flex-shrink: 0;
		color: var(--muted);
	}

	.command-count {
		font-weight: 500;
		white-space: nowrap;
	}

	.command-failed {
		flex-shrink: 0;
		padding: 0 7px;
		border-radius: var(--radius-full);
		background: var(--danger-bg);
		color: var(--danger-text);
		font-size: 11px;
		line-height: 18px;
		white-space: nowrap;
	}

	:global(.command-summary-chevron) {
		flex-shrink: 0;
		margin-left: auto;
		color: var(--muted);
		transform: rotate(90deg);
		transition: transform 0.18s ease;
	}

	.is-open :global(.command-summary-chevron) {
		transform: rotate(-90deg);
	}

	/* About a dozen rows, then it scrolls: a long turn's list stays a part of the bubble. */
	.command-rows {
		max-height: 372px;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
		border-top: 1px solid var(--line-subtle);
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

	.command-pulse {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
		animation: command-blink 1.2s ease-in-out infinite;
	}

	@keyframes command-blink {
		0%, 100% { opacity: 0.25; }
		50% { opacity: 1; }
	}

	/* Read like a code block in a reply: the same ground, border and type. */
	.command-output {
		max-height: 18em;
		margin: 0 10px 10px 32px;
		padding: 8px 10px;
		overflow: auto;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--chip);
		color: var(--ink);
		font-size: 11.5px;
		line-height: 1.5;
		tab-size: 4;
		white-space: pre-wrap;
		word-break: break-word;
		animation: command-output-in 0.16s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@keyframes command-output-in {
		from { opacity: 0; transform: translateY(-2px); }
		to { opacity: 1; transform: none; }
	}

	@media (max-width: 680px) {
		.command-output {
			margin-left: 10px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.command-pulse,
		.command-output {
			animation: none;
		}
	}
</style>
