<script lang="ts">
	import type { Copy } from '../copy.ts';
	import { summarize, type CommandRow } from './command-activity.ts';

	interface Props {
		rows: CommandRow[];
		t: Copy;
	}

	let { rows, t }: Props = $props();

	/**
	 * A finished command folds to one line; a running one shows its tail. One open at a time —
	 * this sits inside a chat bubble, not in a log viewer.
	 */
	let opened = $state<string | null>(null);

	function toggle(id: string): void {
		opened = opened === id ? null : id;
	}

	/** Follow the output while it runs, the way a terminal does. */
	function pin(node: HTMLElement, _text: string) {
		const stick = () => {
			node.scrollTop = node.scrollHeight;
		};
		stick();
		return { update: stick };
	}
</script>

{#if rows.length}
	<div class="command-activity" aria-label={t.chat.commandActivity}>
		{#each rows as row (row.id)}
			<div class="command-row" class:is-running={row.running}>
				<button type="button" class="command-line" onclick={() => toggle(row.id)}>
					<span class="command-caret" class:is-open={row.running || opened === row.id}>▸</span>
					<span class="command-text mono">{summarize(row)}</span>
					{#if row.running}<span class="command-pulse" aria-hidden="true"></span>{/if}
					{#if !row.running && row.exitCode !== null && row.exitCode !== 0}
						<span class="command-failed">{t.chat.commandFailed}</span>
					{/if}
				</button>
				{#if (row.running || opened === row.id) && row.text}
					<pre class="command-output mono" use:pin={row.text}>{row.text}</pre>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.command-activity {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-top: 6px;
	}

	.command-line {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 2px 0;
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 11.5px;
		text-align: left;
		cursor: pointer;
	}

	.command-caret {
		display: inline-block;
		transition: transform 120ms ease;
	}

	.command-caret.is-open {
		transform: rotate(90deg);
	}

	.command-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-failed {
		color: var(--danger, #e05c5c);
	}

	.command-pulse {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
		animation: command-blink 1.2s ease-in-out infinite;
	}

	@keyframes command-blink {
		0%, 100% { opacity: 0.25; }
		50% { opacity: 1; }
	}

	.command-output {
		/* A dozen lines: enough to see it moving, not enough to push the transcript off screen. */
		max-height: 11em;
		margin: 0;
		padding: 6px 8px;
		overflow: auto;
		border-radius: var(--radius-sm, 6px);
		background: var(--surface-sunken, rgba(128, 128, 128, 0.1));
		color: var(--muted);
		font-size: 11px;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
	}

	@media (prefers-reduced-motion: reduce) {
		.command-pulse {
			animation: none;
		}
	}
</style>
